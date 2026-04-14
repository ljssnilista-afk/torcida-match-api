const express      = require('express')
const Group        = require('../models/Group')
const Ride         = require('../models/Ride')
const User         = require('../models/User')
const Message      = require('../models/Message')
const Notification = require('../models/Notification')
const StripeEvent  = require('../models/StripeEvent')

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
      await handlePaymentSucceeded(paymentIntent)
      break

    case 'payment_intent.payment_failed':
      await handlePaymentFailed(paymentIntent)
      break

    case 'charge.refunded':
      await handleChargeRefunded(data.object)
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

    console.log(`[WEBHOOK] Grupo ${groupId}: membro ${userId} ativado com sucesso`)
  } catch (err) {
    console.error(`[WEBHOOK] Erro ao processar pagamento de grupo: ${err.message}`)
    throw err // re-throw para log no processEvent
  }
}

// ─── Pagamento de viagem aprovado ────────────────────────────────────────────
async function handleRidePaymentSuccess(paymentIntent) {
  const { rideId, userId, userName, isMember } = paymentIntent.metadata
  const amount = paymentIntent.amount

  try {
    const ride = await Ride.findById(rideId)
    if (!ride) {
      console.error(`[WEBHOOK] Viagem não encontrada: ${rideId}`)
      return
    }

    // Verificar se o passageiro já foi adicionado (idempotência interna)
    const alreadyIn = ride.passengers.find(
      p => String(p.user) === userId && p.status !== 'cancelled'
    )
    if (alreadyIn) {
      console.log(`[WEBHOOK] Passageiro ${userId} já está na viagem ${rideId}`)
      return
    }

    // Buscar nome/handle do usuário
    const user = await User.findById(userId).select('name handle')

    // Adicionar passageiro com status 'paid'
    ride.passengers.push({
      user: userId,
      name: user?.name || userName || 'Passageiro',
      handle: user?.handle || '',
      status: 'paid',
      paidAmount: amount,
      isMember: isMember === 'true',
    })

    // Escrow: acumular pagamento
    ride.escrowTotal += amount

    // Atualizar status se lotou
    const activeCount = ride.passengers.filter(p => p.status !== 'cancelled').length
    if (activeCount >= ride.totalSeats) {
      ride.status = 'full'
    }

    await ride.save()

    // Notificação para o passageiro
    await Notification.create({
      user: userId,
      type: 'ride_payment_confirmed',
      title: 'Reserva confirmada!',
      message: `Sua reserva na viagem ${ride.shareCode} foi confirmada. R$ ${(amount / 100).toFixed(2)}`,
    })

    // Notificação para o motorista
    await Notification.create({
      user: ride.driver,
      type: 'ride_new_passenger',
      title: 'Novo passageiro!',
      message: `${userName} reservou uma vaga na viagem ${ride.shareCode}.`,
      fromUser: userId,
      fromName: userName,
    })

    console.log(`[WEBHOOK] Viagem ${rideId}: passageiro ${userId} adicionado com sucesso`)
  } catch (err) {
    console.error(`[WEBHOOK] Erro ao processar pagamento de viagem: ${err.message}`)
    throw err
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
