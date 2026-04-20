const express      = require('express')
const Group        = require('../models/Group')
const Ride         = require('../models/Ride')
const User         = require('../models/User')
const Message      = require('../models/Message')
const Notification = require('../models/Notification')
const StripeEvent  = require('../models/StripeEvent')
const Transaction  = require('../models/Transaction')

// 💳 Stripe — chaves selecionadas automaticamente (test/live) por NODE_ENV
const { stripe, webhookSecret } = require('../config/stripe')

const router = express.Router()

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/webhook
//
// IMPORTANTE:
// - O body DEVE ser raw (Buffer) para validar a assinatura
// - NÃO use express.json() neste endpoint — configurado no server.js
// - SEMPRE valide a assinatura antes de processar qualquer evento
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature']

  if (!sig) {
    console.error('[WEBHOOK] Assinatura ausente')
    return res.status(400).json({ error: 'Assinatura do webhook ausente' })
  }

  let event

  // ─── 1. Validar assinatura do webhook ────────────────────────────────────────
  try {
    event = stripe.webhooks.constructEvent(
      req.body,  // DEVE ser Buffer/raw — configurado no server.js
      sig,
      webhookSecret
    )
  } catch (err) {
    console.error(`[WEBHOOK] Assinatura inválida: ${err.message}`)
    return res.status(400).json({ error: 'Assinatura inválida' })
  }

  // ─── 2. Idempotência — verificar se já processamos este evento ──────────────
  try {
    const existing = await StripeEvent.findOne({ eventId: event.id })
    if (existing) {
      console.log(`[WEBHOOK] Evento já processado (idempotente): ${event.id}`)
      return res.status(200).json({ received: true, duplicate: true })
    }
  } catch (err) {
    console.error(`[WEBHOOK] Erro ao verificar idempotência: ${err.message}`)
    // Continuar processando — melhor processar duas vezes do que perder
  }

  // ─── 3. Retornar 200 rapidamente — processar de forma assíncrona ───────────
  res.status(200).json({ received: true })

  // Processamento assíncrono (não bloqueia o Stripe)
  processEvent(event).catch(err => {
    console.error(`[WEBHOOK] Erro ao processar evento ${event.id}: ${err.message}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Processamento assíncrono dos eventos
// ═══════════════════════════════════════════════════════════════════════════════
async function processEvent(event) {
  const { type, data, id: eventId } = event
  const paymentIntent = data.object

  console.log(`[WEBHOOK] Processando: ${type} | PI: ${paymentIntent.id}`)

  switch (type) {
    case 'payment_intent.succeeded':
      // Para viagens: succeeded dispara APÓS stripe.paymentIntents.capture() no validate-code.
      // O crédito do motorista já foi feito lá — webhook só processa group_membership aqui.
      await handlePaymentSucceeded(paymentIntent)
      break

    case 'payment_intent.amount_capturable_updated':
      // Disparado quando o passageiro autorizou (requires_capture).
      // confirm-ride já registrou o passageiro — só logamos aqui.
      console.log(`[WEBHOOK] PI autorizado (aguarda validação): ${paymentIntent.id}`)
      break

    case 'payment_intent.payment_failed':
      await handlePaymentFailed(paymentIntent)
      break

    case 'charge.refunded':
      await handleChargeRefunded(data.object)
      break

    // ─── Eventos Stripe Connect ────────────────────────────────────────────────
    case 'account.updated':
      await handleAccountUpdated(data.object)
      break

    case 'transfer.created':
      console.log(`[WEBHOOK] Transfer criado: ${data.object.id} → ${data.object.destination}`)
      break

    default:
      console.log(`[WEBHOOK] Evento não tratado: ${type}`)
  }

  // ─── 4. Registrar evento como processado (idempotência) ──────────────────────
  try {
    await StripeEvent.create({
      eventId,
      type,
      data: {
        paymentIntentId: paymentIntent.id,
        amount: paymentIntent.amount,
        metadata: paymentIntent.metadata,
      },
    })
  } catch (err) {
    // Se falhar por duplicata (race condition), tudo bem
    if (err.code !== 11000) {
      console.error(`[WEBHOOK] Erro ao salvar evento: ${err.message}`)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: payment_intent.succeeded
// ═══════════════════════════════════════════════════════════════════════════════
async function handlePaymentSucceeded(paymentIntent) {
  const { metadata } = paymentIntent

  if (metadata.type === 'group_membership') {
    await handleGroupPaymentSuccess(paymentIntent)
  } else if (metadata.type === 'ride_reservation') {
    await handleRidePaymentSuccess(paymentIntent)
  } else {
    console.log(`[WEBHOOK] Tipo de pagamento desconhecido: ${metadata.type}`)
  }
}

// ─── Pagamento de mensalidade de grupo aprovado ─────────────────────────────
async function handleGroupPaymentSuccess(paymentIntent) {
  const { groupId, userId, userName } = paymentIntent.metadata

  try {
    const group = await Group.findById(groupId)
    if (!group) {
      console.error(`[WEBHOOK] Grupo não encontrado: ${groupId}`)
      return
    }

    // Remover de pendingMembers e adicionar a members
    const pending = group.pendingMembers?.find(
      p => String(p.user) === userId
    )
    if (!pending) {
      console.log(`[WEBHOOK] Usuário ${userId} não está pendente no grupo ${groupId}`)
      return
    }

    group.pendingMembers = group.pendingMembers.filter(
      p => String(p.user) !== userId
    )
    group.members.push(userId)
    await group.save()

    // Mensagem no chat do grupo
    await Message.create({
      grupo: group._id,
      sender: userId,
      senderName: userName || 'Membro',
      text: `${userName || 'Membro'} entrou no grupo (pagamento confirmado via Stripe)`,
      type: 'system',
    })

    // Notificação para o novo membro
    await Notification.create({
      user: userId,
      type: 'group_payment_confirmed',
      title: 'Pagamento confirmado!',
      message: `Seu pagamento para o grupo ${group.name} foi confirmado. Bem-vindo!`,
      group: group._id,
    })

    // Notificação para o líder
    await Notification.create({
      user: group.leader,
      type: 'group_payment_received',
      title: 'Pagamento recebido',
      message: `${userName} pagou a mensalidade do grupo ${group.name}.`,
      group: group._id,
      fromUser: userId,
      fromName: userName,
    })

    // ─── Carteira do líder: creditar 80% da mensalidade ─────────────────────
    const totalAmount    = paymentIntent.amount           // centavos
    const appCommission  = Math.round(totalAmount * 0.20) // 20% plataforma
    const leaderCredit   = totalAmount - appCommission    // 80% para o líder

    await User.findByIdAndUpdate(group.leader, {
      $inc: { walletBalance: leaderCredit },
    })

    // Transação do líder (crédito na carteira)
    await Transaction.create({
      userId:      group.leader,
      type:        'deposit',
      amount:      leaderCredit,
      status:      'completed',
      description: `Mensalidade de ${userName} — grupo ${group.name}`,
      relatedId:   group._id,
      relatedType: 'group',
      stripePaymentIntentId: paymentIntent.id,
      appCommission,
    }).catch(e => console.error('[WEBHOOK] Falha ao registrar Transaction (líder):', e.message))

    // Transação do membro (pagamento)
    await Transaction.create({
      userId:      userId,
      type:        'payment',
      amount:      totalAmount,
      status:      'completed',
      description: `Mensalidade — grupo ${group.name}`,
      relatedId:   group._id,
      relatedType: 'group',
      stripePaymentIntentId: paymentIntent.id,
      appCommission,
    }).catch(e => console.error('[WEBHOOK] Falha ao registrar Transaction (membro):', e.message))

    console.log(`[WEBHOOK] Grupo ${groupId}: membro ${userId} ativado | líder creditado R$ ${(leaderCredit / 100).toFixed(2)}`)
  } catch (err) {
    console.error(`[WEBHOOK] Erro ao processar pagamento de grupo: ${err.message}`)
    throw err // re-throw para log no processEvent
  }
}

// ─── Pagamento de viagem capturado (succeeded após validate-code) ────────────
async function handleRidePaymentSuccess(paymentIntent) {
  const { rideId, userId, userName } = paymentIntent.metadata

  try {
    // Com capture_method:'manual', payment_intent.succeeded só dispara
    // DEPOIS de stripe.paymentIntents.capture() no endpoint validate-code.
    // O crédito do motorista já foi feito lá — aqui só verificamos se
    // o passageiro já está confirmado e registramos backup se necessário.
    const alreadyCredited = await Transaction.findOne({
      stripePaymentIntentId: paymentIntent.id,
      type:   'deposit',
    })

    if (alreadyCredited) {
      // validate-code já processou tudo — nada a fazer
      console.log(`[WEBHOOK] Ride ${rideId}: succeeded recebido, crédito já processado via validate-code`)
      return
    }

    // Edge case: validate-code falhou mas Stripe capturou (retry / fallback)
    const ride = await Ride.findById(rideId)
    if (!ride) { console.error(`[WEBHOOK] Viagem não encontrada: ${rideId}`); return }

    const amount = paymentIntent.amount_received || paymentIntent.amount
    const appCommission = Math.round(amount * 0.20)
    const driverCredit  = amount - appCommission

    await User.findByIdAndUpdate(ride.driver, { $inc: { walletBalance: driverCredit } })

    await Transaction.create({
      userId:      ride.driver,
      type:        'deposit',
      amount:      driverCredit,
      status:      'completed',
      description: `[Fallback webhook] Embarque ${userName} — viagem ${ride.shareCode}`,
      relatedId:   ride._id,
      relatedType: 'ride',
      stripePaymentIntentId: paymentIntent.id,
      appCommission,
    }).catch(e => console.error('[WEBHOOK] Falha Transaction motorista fallback:', e.message))

    // Atualizar passageiro para confirmed se ainda estiver authorized
    const passenger = ride.passengers.find(
      p => String(p.user) === userId && p.status === 'authorized'
    )
    if (passenger) {
      passenger.status = 'confirmed'
      passenger.capturedAt = new Date()
      await ride.save()
    }

    console.log(`[WEBHOOK] Viagem ${rideId}: fallback — motorista creditado R$ ${(driverCredit / 100).toFixed(2)}`)

    console.log(`[WEBHOOK] Viagem ${rideId}: passageiro ${userId} processado com sucesso`)
  } catch (err) {
    console.error(`[WEBHOOK] Erro ao processar pagamento de viagem: ${err.message}`)
    throw err
  }
}

// ─── Conta Connect atualizada ─────────────────────────────────────────────────
async function handleAccountUpdated(account) {
  try {
    const userId = account.metadata?.userId
    if (!userId) return

    const onboardingDone = account.details_submitted && account.charges_enabled

    await User.findByIdAndUpdate(userId, { stripeOnboardingDone: onboardingDone })
    console.log(`[WEBHOOK] Conta Connect ${account.id}: onboarding=${onboardingDone} | user=${userId}`)
  } catch (err) {
    console.error(`[WEBHOOK] Erro ao atualizar conta Connect: ${err.message}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: payment_intent.payment_failed
// ═══════════════════════════════════════════════════════════════════════════════
async function handlePaymentFailed(paymentIntent) {
  const { metadata } = paymentIntent
  const { userId, userName } = metadata

  if (!userId) return

  const errorMessage = paymentIntent.last_payment_error?.message || 'Pagamento recusado'

  // Notificar o usuário sobre a falha
  await Notification.create({
    user: userId,
    type: 'payment_failed',
    title: 'Pagamento falhou',
    message: `Seu pagamento não foi processado: ${errorMessage}. Tente novamente.`,
  })

  console.log(`[WEBHOOK] Pagamento falhou: PI=${paymentIntent.id} | user=${userId} | erro=${errorMessage}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: charge.refunded
// ═══════════════════════════════════════════════════════════════════════════════
async function handleChargeRefunded(charge) {
  const paymentIntentId = charge.payment_intent

  if (!paymentIntentId) return

  try {
    // Buscar o PaymentIntent para obter metadata
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId)
    const { metadata } = paymentIntent
    const { userId, type: paymentType, rideId } = metadata

    if (paymentType === 'ride_reservation' && rideId) {
      const ride = await Ride.findById(rideId)
      if (ride) {
        const passenger = ride.passengers.find(
          p => String(p.user) === userId && p.status !== 'cancelled'
        )
        if (passenger) {
          ride.escrowTotal -= passenger.paidAmount
          passenger.status = 'cancelled'
          if (ride.status === 'full') ride.status = 'open'
          await ride.save()
        }
      }
    }

    if (userId) {
      await Notification.create({
        user: userId,
        type: 'payment_refunded',
        title: 'Reembolso processado',
        message: `Seu reembolso de R$ ${(charge.amount_refunded / 100).toFixed(2)} foi processado.`,
      })
    }

    console.log(`[WEBHOOK] Reembolso processado: charge=${charge.id} | amount=${charge.amount_refunded}`)
  } catch (err) {
    console.error(`[WEBHOOK] Erro ao processar reembolso: ${err.message}`)
  }
}

module.exports = router
