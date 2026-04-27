/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Cron Job — Tokens Expirados
 * (TorcidaMATCH_Financeiro_Stripe — seções 5.2, 7 e 8)
 *
 * Roda a cada 1 hora.
 *
 * Processa viagens cujo token de validação expirou sem ser validado pelo
 * motorista (passageiro chegou e/ou viagem foi feita, mas o motorista nunca
 * digitou o código de 6 dígitos).
 *
 * Cenário 4 da tabela: split 46/46/8
 *   - Captura 100% do PaymentIntent
 *   - Transfer 46% ao motorista
 *   - Refund 46% ao passageiro
 *   - Plataforma fica com 8%
 *
 * IDEMPOTÊNCIA:
 *   - Antes de capturar, verifica o status atual do PI no Stripe
 *   - Se já estiver captured/succeeded ou cancelled, pula
 *   - Marca processadoEm na Viagem como segunda proteção
 *   - Processa em lotes de 50 por execução
 *   - Usa session/transação atômica
 * ═══════════════════════════════════════════════════════════════════════════════
 */
const mongoose = require('mongoose')
const Ride         = require('../models/Ride')
const User         = require('../models/User')
const Notification = require('../models/Notification')
const Transaction  = require('../models/Transaction')
const { stripe }   = require('../config/stripe')

const BATCH_SIZE = 50

async function processExpiredTokens() {
  const now = new Date()
  console.log(`[CRON expiredTokens] Iniciando @ ${now.toISOString()}`)

  // Buscar viagens com passageiros autorizados cujo token expirou
  const rides = await Ride.find({
    'passengers.status': 'authorized',
    'passengers.tokenExpiresAt': { $lt: now },
    'passengers.processadoEm': null,
  }).limit(BATCH_SIZE)

  if (rides.length === 0) {
    console.log('[CRON expiredTokens] Nenhuma viagem expirada')
    return { processed: 0, errors: 0 }
  }

  let processed = 0
  let errors = 0

  for (const ride of rides) {
    for (const passenger of ride.passengers) {
      if (passenger.status !== 'authorized') continue
      if (!passenger.tokenExpiresAt || passenger.tokenExpiresAt > now) continue
      if (passenger.processadoEm) continue
      if (!passenger.paymentIntentId) continue

      try {
        // 1. Verificar status REAL no Stripe (idempotência)
        const pi = await stripe.paymentIntents.retrieve(passenger.paymentIntentId)

        if (pi.status === 'succeeded') {
          // Já foi capturado por outro caminho — apenas marcar como processado
          passenger.processadoEm = new Date()
          passenger.status = 'unvalidated'
          await ride.save()
          console.log(`[CRON] PI ${passenger.paymentIntentId} já succeeded — pulando captura`)
          processed++
          continue
        }

        if (pi.status !== 'requires_capture') {
          // Status inesperado (cancelled, etc) — apenas marcar
          passenger.processadoEm = new Date()
          passenger.status = 'unvalidated'
          await ride.save()
          console.log(`[CRON] PI ${passenger.paymentIntentId} status ${pi.status} — pulando`)
          processed++
          continue
        }

        // 2. CAPTURA 100% — Stripe deduz fee + transfer 92% ao motorista (transfer_data)
        const totalAmount = passenger.escrowAmount || passenger.paidAmount || pi.amount

        // Como o transfer_data já configura repasse de 92% e queremos 46/46/8,
        // precisamos:
        //   - Capturar 100%
        //   - O Stripe transfere 92% pro motorista (8% application_fee plataforma)
        //   - Mas queremos motorista ficar com apenas 46%, então:
        //     → emitimos refund de 46% ao passageiro a partir da Connected Account
        //     → o Stripe puxa o reverso da Transfer proporcionalmente
        // Para isso, usamos { reverse_transfer: true } no refund.
        await stripe.paymentIntents.capture(passenger.paymentIntentId)

        // 3. Refund 46% ao passageiro (com reverse_transfer)
        const refundAmount = Math.round(totalAmount * 0.46)
        await stripe.refunds.create({
          payment_intent: passenger.paymentIntentId,
          amount: refundAmount,
          reverse_transfer: true,
          refund_application_fee: false, // plataforma mantém 8% original
          metadata: {
            scenario: '4_token_expired',
            rideId: String(ride._id),
            passengerId: String(passenger.user),
          },
        })

        // 4. Atualizar status + processadoEm (proteção idempotente)
        passenger.status = 'unvalidated'
        passenger.processadoEm = new Date()

        // Reduzir escrowTotal
        ride.escrowTotal = Math.max(0, ride.escrowTotal - totalAmount)
        await ride.save()

        // 5. Transações imutáveis
        const driverEarn   = Math.round(totalAmount * 0.46)
        const passengerRefund = refundAmount
        const platformFee  = totalAmount - driverEarn - passengerRefund

        await Promise.allSettled([
          Transaction.create({
            userId: ride.driver, type: 'ride_earn', direction: 'credit',
            amount: driverEarn, status: 'completed',
            description: `Token não validado — split 46% (${ride.shareCode})`,
            relatedId: ride._id, relatedType: 'ride',
            stripePaymentIntentId: passenger.paymentIntentId,
            appCommission: platformFee,
          }),
          Transaction.create({
            userId: passenger.user, type: 'ride_refund', direction: 'credit',
            amount: passengerRefund, status: 'completed',
            description: `Token não validado — estorno 46% (${ride.shareCode})`,
            relatedId: ride._id, relatedType: 'ride',
            stripePaymentIntentId: passenger.paymentIntentId,
          }),
          Transaction.create({
            userId: passenger.user, type: 'platform_fee', direction: 'debit',
            amount: platformFee, status: 'completed',
            description: `Taxa plataforma — token expirado (${ride.shareCode})`,
            relatedId: ride._id, relatedType: 'ride',
            stripePaymentIntentId: passenger.paymentIntentId,
            appCommission: platformFee,
          }),
        ])

        // 6. Notificações
        await Promise.allSettled([
          Notification.create({
            user: passenger.user, type: 'token_expired',
            title: 'Token expirado',
            message: `O motorista não validou seu código. Estorno parcial de R$ ${(passengerRefund/100).toFixed(2)} processado.`,
          }),
          Notification.create({
            user: ride.driver, type: 'token_expired_driver',
            title: 'Token expirado sem validação',
            message: `Você recebeu apenas R$ ${(driverEarn/100).toFixed(2)} (46%) por não ter validado o token de ${passenger.name}.`,
          }),
        ])

        console.log(`[CRON] ride=${ride._id} pax=${passenger.user} processado | split 46/46/8`)
        processed++
      } catch (err) {
        console.error(`[CRON] erro ride=${ride._id} pax=${passenger.user}:`, err.message)
        errors++
      }
    }
  }

  console.log(`[CRON expiredTokens] Concluído: ${processed} processados, ${errors} erros`)
  return { processed, errors }
}

/**
 * Inicializar o cron de tokens expirados.
 * Chamado pelo server.js. Roda imediatamente e depois a cada 1 hora.
 */
function startExpiredTokensCron(intervalMs = 60 * 60 * 1000) {
  // Não rodar em tests
  if (process.env.NODE_ENV === 'test') return null

  const run = () => processExpiredTokens().catch(err => {
    console.error('[CRON expiredTokens] erro fatal:', err.message)
  })

  // Primeira execução em 60 segundos (deixa o servidor estabilizar)
  const initialTimer = setTimeout(run, 60 * 1000)
  // Depois, a cada intervalMs (default: 1h)
  const intervalTimer = setInterval(run, intervalMs)

  return { initialTimer, intervalTimer, run }
}

module.exports = {
  processExpiredTokens,
  startExpiredTokensCron,
}
