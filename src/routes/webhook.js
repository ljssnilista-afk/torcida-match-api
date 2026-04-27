const express      = require('express')
const Group        = require('../models/Group')
const Ride         = require('../models/Ride')
const User         = require('../models/User')
const Message      = require('../models/Message')
const Notification = require('../models/Notification')
const StripeEvent  = require('../models/StripeEvent')
const Transaction  = require('../models/Transaction')
const penalties    = require('../services/penalties')

const { stripe, webhookSecret } = require('../config/stripe')

const router = express.Router()

// ═══════════════════════════════════════════════════════════════════════════════
// THIN WEBHOOK V2 — POST /api/webhook/v2
//
// Eventos da Stripe Connect v2 (Accounts v2) chegam como "thin events".
// Diferente do v1, o thin event não traz o objeto completo — apenas a referência.
// Você usa eventNotif.fetchRelatedObject() / fetchEvent() para hidratar.
//
// Eventos esperados (v2):
//   v2.account.created               — nova Connected Account criada
//   v2.account.updated               — capabilities/requirements mudaram
//   v2.account.requirements.updated  — KYC pendente/atualizado
//
// Configurar separadamente no dashboard: webhook v2 com endpoint /api/webhook/v2
// O webhook v1 (eventos clássicos) continua em /api/webhook (definido abaixo).
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/v2', async (req, res) => {
  const signature = req.headers['stripe-signature']
  if (!signature) return res.status(400).json({ error: 'Assinatura ausente' })

  if (!stripe.parseEventNotification) {
    return res.status(501).json({ error: 'SDK Stripe sem suporte a thin events (v2)' })
  }

  const v2Secret = process.env.STRIPE_V2_WEBHOOK_SECRET || webhookSecret
  let eventNotif
  try {
    eventNotif = stripe.parseEventNotification(req.body, signature, v2Secret)
  } catch (err) {
    console.error('[WEBHOOK V2] Assinatura inválida:', err.message)
    return res.status(400).json({ error: 'Assinatura inválida' })
  }

  // Resposta rápida — processamento assíncrono
  res.status(200).json({ received: true })

  ;(async () => {
    try {
      const type = eventNotif.type
      console.log(`[WEBHOOK V2] ${type}`)

      switch (type) {
        case 'v2.account.created': {
          const related = await eventNotif.fetchRelatedObject()
          await handleV2AccountCreated(related)
          break
        }
        case 'v2.account.updated':
        case 'v2.account.requirements.updated': {
          const related = await eventNotif.fetchRelatedObject()
          await handleV2AccountUpdated(related)
          break
        }
        default:
          console.log(`[WEBHOOK V2] Ignorando: ${type}`)
      }
    } catch (err) {
      console.error('[WEBHOOK V2] erro processamento:', err.message)
    }
  })()
})

async function handleV2AccountCreated(account) {
  if (!account?.id) return
  const userId = account.metadata?.userId
  if (!userId) return
  console.log(`[WEBHOOK V2] account.created ${account.id} → user ${userId}`)
  await User.findByIdAndUpdate(userId, { stripeAccountId: account.id }).catch(() => {})
}

async function handleV2AccountUpdated(account) {
  if (!account?.id) return
  let userId = account.metadata?.userId
  if (!userId) {
    const u = await User.findOne({ stripeAccountId: account.id }).select('_id')
    userId = u?._id
  }
  if (!userId) return

  // Parse v2 status
  const recipient = account.configuration?.recipient
  const balance   = recipient?.capabilities?.stripe_balance
  const chargesEnabled = balance?.stripe_transfers?.status === 'active'
  const payoutsEnabled = balance?.payouts?.status === 'active'
  const summaryStatus  = account.requirements?.summary?.minimum_deadline?.status
  const detailsSubmitted = !summaryStatus || summaryStatus === 'eventually_due'
  const onboardingDone = !!(detailsSubmitted && chargesEnabled)

  const before = await User.findById(userId).select('stripeOnboardingDone')
  await User.findByIdAndUpdate(userId, {
    stripeOnboardingDone: onboardingDone,
    stripeOnboarded:      onboardingDone,
    chargesEnabled,
    payoutsEnabled,
  })

  if (onboardingDone && !before?.stripeOnboardingDone) {
    await Notification.create({
      user: userId,
      type: 'connect_onboarded',
      title: 'Cadastro financeiro aprovado!',
      message: 'Sua conta está pronta para receber pagamentos.',
    }).catch(() => {})
  }

  console.log(`[WEBHOOK V2] account.updated ${account.id} | onboarded=${onboardingDone}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/webhook
//
// Webhooks essenciais (TorcidaMATCH_Financeiro_Stripe — seção 11):
//   payment_intent.succeeded      → mensalidade paga / captura concluída
//   payment_intent.payment_failed → notifica usuário
//   account.updated               → atualiza stripeOnboarded/charges/payouts
//   invoice.paid                  → mensalidade recorrente recebida
//   invoice.payment_failed        → mensalidade falhou (suspender após 3)
//   customer.subscription.deleted → assinatura cancelada → remover do grupo
//   payout.paid                   → saque chegou na conta bancária
//   payout.failed                 → saque falhou
//   charge.dispute.created        → chargeback → suspender conta
//   charge.refunded               → reembolso processado
//
// REGRAS:
//   - SEMPRE validar a assinatura com STRIPE_WEBHOOK_SECRET
//   - SEMPRE checar idempotência via StripeEvent (evita reprocessar)
//   - Responder 200 RAPIDAMENTE — processamento assíncrono
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature']
  if (!sig) return res.status(400).json({ error: 'Assinatura ausente' })

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
  } catch (err) {
    console.error(`[WEBHOOK] Assinatura inválida: ${err.message}`)
    return res.status(400).json({ error: 'Assinatura inválida' })
  }

  // Idempotência — verificar se já processamos
  try {
    const existing = await StripeEvent.findOne({ eventId: event.id })
    if (existing) {
      console.log(`[WEBHOOK] Duplicado: ${event.id}`)
      return res.status(200).json({ received: true, duplicate: true })
    }
  } catch (err) {
    console.error('[WEBHOOK] check idempotência:', err.message)
  }

  res.status(200).json({ received: true })

  processEvent(event).catch(err => {
    console.error(`[WEBHOOK] erro evento ${event.id}: ${err.message}`)
  })
})

async function processEvent(event) {
  const { type, data, id: eventId } = event
  console.log(`[WEBHOOK] Processando: ${type} | id=${eventId}`)

  switch (type) {
    // ─── PaymentIntent ────────────────────────────────────────────────────
    case 'payment_intent.succeeded':
      await handlePaymentSucceeded(data.object)
      break

    case 'payment_intent.amount_capturable_updated':
      // PI autorizado (escrow ativo) — confirm-ride já tratou
      console.log(`[WEBHOOK] PI autorizado: ${data.object.id}`)
      break

    case 'payment_intent.payment_failed':
      await handlePaymentFailed(data.object)
      break

    case 'payment_intent.canceled':
      console.log(`[WEBHOOK] PI cancelado: ${data.object.id}`)
      break

    // ─── Charge ───────────────────────────────────────────────────────────
    case 'charge.refunded':
      await handleChargeRefunded(data.object)
      break

    case 'charge.dispute.created':
      await handleChargebackOpened(data.object)
      break

    // ─── Connect Account ──────────────────────────────────────────────────
    case 'account.updated':
      await handleAccountUpdated(data.object)
      break

    case 'transfer.created':
      console.log(`[WEBHOOK] Transfer criado: ${data.object.id} → ${data.object.destination}`)
      break

    // ─── Subscriptions / Invoices ─────────────────────────────────────────
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      await handleInvoicePaid(data.object)
      break

    case 'invoice.payment_failed':
      await handleInvoiceFailed(data.object)
      break

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(data.object)
      break

    // ─── Payouts ──────────────────────────────────────────────────────────
    case 'payout.paid':
      await handlePayoutPaid(data.object, event.account)
      break

    case 'payout.failed':
      await handlePayoutFailed(data.object, event.account)
      break

    default:
      console.log(`[WEBHOOK] Ignorando: ${type}`)
  }

  // Marcar como processado
  try {
    await StripeEvent.create({
      eventId, type,
      data: { objectId: data.object?.id, type: data.object?.object || null },
    })
  } catch (err) {
    if (err.code !== 11000) console.error('[WEBHOOK] save event:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// payment_intent.succeeded
// ═══════════════════════════════════════════════════════════════════════════════
async function handlePaymentSucceeded(paymentIntent) {
  const { metadata } = paymentIntent
  if (metadata?.type === 'group_membership') {
    await handleGroupPaymentSuccess(paymentIntent)
  } else if (metadata?.type === 'ride_reservation') {
    await handleRidePaymentSuccess(paymentIntent)
  } else {
    console.log(`[WEBHOOK] PI succeeded sem type: ${paymentIntent.id}`)
  }
}

// ─── Mensalidade de grupo paga (cobrança única) ─────────────────────────────
async function handleGroupPaymentSuccess(paymentIntent) {
  const { groupId, userId, userName, leaderUserId } = paymentIntent.metadata
  if (!groupId || !userId) return

  const group = await Group.findById(groupId)
  if (!group) return

  const pending = group.pendingMembers?.find(p => String(p.user) === userId)
  if (!pending) return

  group.pendingMembers = group.pendingMembers.filter(p => String(p.user) !== userId)
  group.members.push(userId)
  await group.save()

  await Message.create({
    grupo: group._id, sender: userId, senderName: userName || 'Membro',
    text: `${userName || 'Membro'} entrou no grupo (pagamento confirmado)`,
    type: 'system',
  }).catch(() => {})

  await Promise.allSettled([
    Notification.create({
      user: userId, type: 'group_payment_confirmed',
      title: 'Pagamento confirmado!',
      message: `Pagamento confirmado. Bem-vindo ao grupo ${group.name}!`,
      group: group._id,
    }),
    Notification.create({
      user: leaderUserId || group.leader, type: 'group_payment_received',
      title: 'Pagamento recebido',
      message: `${userName} pagou a mensalidade do grupo ${group.name}.`,
      group: group._id, fromUser: userId, fromName: userName,
    }),
  ])

  // Transações imutáveis (Stripe já transferiu via transfer_data)
  const total = paymentIntent.amount
  const fee   = paymentIntent.application_fee_amount || Math.round(total * 0.20)
  const leaderCredit = total - fee

  await Promise.allSettled([
    Transaction.create({
      userId: leaderUserId || group.leader,
      type: 'group_earning', direction: 'credit',
      amount: leaderCredit, status: 'completed',
      description: `Mensalidade de ${userName} — grupo ${group.name}`,
      relatedId: group._id, relatedType: 'group',
      stripePaymentIntentId: paymentIntent.id,
      appCommission: fee,
    }),
    Transaction.create({
      userId, type: 'group_subscription', direction: 'debit',
      amount: total, status: 'completed',
      description: `Mensalidade — grupo ${group.name}`,
      relatedId: group._id, relatedType: 'group',
      stripePaymentIntentId: paymentIntent.id,
      appCommission: fee,
    }),
  ])

  console.log(`[WEBHOOK] grupo ${groupId}: membro ${userId} ativado | fee=${fee} líder=${leaderCredit}`)
}

// ─── Captura de viagem concluída ────────────────────────────────────────────
async function handleRidePaymentSuccess(paymentIntent) {
  const { rideId, userId } = paymentIntent.metadata
  // validate-code já registrou a transação ride_earn — apenas backup
  const already = await Transaction.findOne({
    stripePaymentIntentId: paymentIntent.id, type: 'ride_earn',
  })
  if (already) {
    console.log(`[WEBHOOK] ride ${rideId}: já processado em validate-code`)
    return
  }
  console.log(`[WEBHOOK] ride ${rideId}: succeeded sem ride_earn (edge case)`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// payment_intent.payment_failed
// ═══════════════════════════════════════════════════════════════════════════════
async function handlePaymentFailed(paymentIntent) {
  const { userId } = paymentIntent.metadata || {}
  if (!userId) return
  const errorMessage = paymentIntent.last_payment_error?.message || 'Pagamento recusado'

  await Notification.create({
    user: userId, type: 'payment_failed',
    title: 'Pagamento falhou',
    message: `Seu pagamento não foi processado: ${errorMessage}`,
  }).catch(() => {})
}

// ═══════════════════════════════════════════════════════════════════════════════
// charge.refunded
// ═══════════════════════════════════════════════════════════════════════════════
async function handleChargeRefunded(charge) {
  const piId = charge.payment_intent
  if (!piId) return
  try {
    const pi = await stripe.paymentIntents.retrieve(piId)
    const { userId, type, rideId } = pi.metadata || {}

    if (type === 'ride_reservation' && rideId) {
      const ride = await Ride.findById(rideId)
      if (ride) {
        const passenger = ride.passengers.find(
          p => String(p.user) === userId && !['cancelled', 'no_show', 'unvalidated'].includes(p.status)
        )
        if (passenger) {
          ride.escrowTotal -= (passenger.escrowAmount || passenger.paidAmount || 0)
          passenger.status = 'cancelled'
          if (ride.status === 'full') ride.status = 'open'
          await ride.save()
        }
      }
    }

    if (userId) {
      await Notification.create({
        user: userId, type: 'payment_refunded',
        title: 'Reembolso processado',
        message: `Reembolso de R$ ${(charge.amount_refunded / 100).toFixed(2)} processado.`,
      }).catch(() => {})
    }
  } catch (err) {
    console.error('[WEBHOOK] charge.refunded:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// charge.dispute.created — chargeback aberto
// ═══════════════════════════════════════════════════════════════════════════════
async function handleChargebackOpened(dispute) {
  try {
    const charge = await stripe.charges.retrieve(dispute.charge)
    const piId = charge.payment_intent
    if (!piId) return
    const pi = await stripe.paymentIntents.retrieve(piId)
    const { userId } = pi.metadata || {}
    if (!userId) return

    await penalties.registerChargeback(userId, { disputeId: dispute.id }).catch(() => {})

    await Transaction.create({
      userId, type: 'chargeback', direction: 'debit',
      amount: dispute.amount, status: 'completed',
      description: `Chargeback aberto — disputa ${dispute.id}`,
      stripePaymentIntentId: piId,
      stripeChargeId: dispute.charge,
    }).catch(() => {})

    console.log(`[WEBHOOK] CHARGEBACK user=${userId} | dispute=${dispute.id} | amount=${dispute.amount}`)
  } catch (err) {
    console.error('[WEBHOOK] dispute.created:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// account.updated — onboarding / capacidades
// ═══════════════════════════════════════════════════════════════════════════════
async function handleAccountUpdated(account) {
  try {
    const userId = account.metadata?.userId
    if (!userId) {
      // Buscar pelo accountId se metadata foi perdida
      const user = await User.findOne({ stripeAccountId: account.id })
      if (!user) return
      account.metadata = account.metadata || {}
      account.metadata.userId = String(user._id)
    }

    const onboardingDone = !!(account.details_submitted && account.charges_enabled)
    const update = {
      stripeOnboardingDone: onboardingDone,
      stripeOnboarded:      onboardingDone,
      chargesEnabled:       !!account.charges_enabled,
      payoutsEnabled:       !!account.payouts_enabled,
    }

    const before = await User.findById(account.metadata.userId).select('stripeOnboardingDone')
    await User.findByIdAndUpdate(account.metadata.userId, update)

    // Notificação na primeira aprovação
    if (onboardingDone && !before?.stripeOnboardingDone) {
      await Notification.create({
        user: account.metadata.userId,
        type: 'connect_onboarded',
        title: 'Cadastro financeiro aprovado! 🎉',
        message: 'Sua conta está pronta para receber pagamentos.',
      }).catch(() => {})
    }

    // Alerta se payouts foram desabilitados
    if (!account.payouts_enabled && account.requirements?.disabled_reason) {
      await Notification.create({
        user: account.metadata.userId,
        type: 'connect_payouts_disabled',
        title: 'Atenção: saques bloqueados',
        message: `Stripe sinalizou: ${account.requirements.disabled_reason}. Atualize seus dados.`,
      }).catch(() => {})
    }

    console.log(`[WEBHOOK] account.updated ${account.id}: onboarded=${onboardingDone}`)
  } catch (err) {
    console.error('[WEBHOOK] account.updated:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// invoice.paid (Subscriptions — mensalidade recorrente)
// ═══════════════════════════════════════════════════════════════════════════════
async function handleInvoicePaid(invoice) {
  const subId = invoice.subscription
  if (!subId) return
  try {
    const sub = await stripe.subscriptions.retrieve(subId)
    const { groupId, userId } = sub.metadata || {}
    if (!groupId || !userId) return

    const group = await Group.findById(groupId)
    if (!group) return

    // Adicionar ao grupo se ainda não está
    const isMember = group.members.map(String).includes(userId)
    if (!isMember) {
      group.pendingMembers = group.pendingMembers.filter(p => String(p.user) !== userId)
      group.members.push(userId)
    }

    // Atualizar/criar registro de subscription ativa
    let subRec = group.subscriptions.find(s => s.stripeSubscriptionId === subId)
    if (!subRec) {
      group.subscriptions.push({
        user: userId,
        stripeSubscriptionId: subId,
        status: 'active',
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
        startedAt: new Date(),
        failedAttempts: 0,
      })
    } else {
      subRec.status = 'active'
      subRec.currentPeriodEnd = new Date(sub.current_period_end * 1000)
      subRec.failedAttempts = 0
    }
    await group.save()

    // Transação para histórico
    const total = invoice.amount_paid
    const fee   = invoice.application_fee_amount || Math.round(total * 0.20)
    await Transaction.create({
      userId: group.leader, type: 'group_earning', direction: 'credit',
      amount: total - fee, status: 'completed',
      description: `Mensalidade recorrente — grupo ${group.name}`,
      relatedId: group._id, relatedType: 'group',
      stripeSubscriptionId: subId,
      stripeInvoiceId: invoice.id,
      appCommission: fee,
    }).catch(() => {})

    console.log(`[WEBHOOK] invoice.paid sub=${subId} grupo=${groupId} user=${userId}`)
  } catch (err) {
    console.error('[WEBHOOK] invoice.paid:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// invoice.payment_failed — após 3 tentativas, remover do grupo
// ═══════════════════════════════════════════════════════════════════════════════
async function handleInvoiceFailed(invoice) {
  const subId = invoice.subscription
  if (!subId) return
  try {
    const sub = await stripe.subscriptions.retrieve(subId)
    const { groupId, userId } = sub.metadata || {}
    if (!groupId || !userId) return

    const group = await Group.findById(groupId)
    if (!group) return

    let subRec = group.subscriptions.find(s => s.stripeSubscriptionId === subId)
    if (subRec) {
      subRec.failedAttempts = (subRec.failedAttempts || 0) + 1
      subRec.status = 'past_due'
      await group.save()

      if (subRec.failedAttempts >= 3) {
        // Cancelar subscription e remover do grupo
        await stripe.subscriptions.cancel(subId).catch(() => {})
        group.members = group.members.filter(m => String(m) !== userId)
        group.subscriptions = group.subscriptions.filter(s => s.stripeSubscriptionId !== subId)
        await group.save()

        await Notification.create({
          user: userId, type: 'subscription_cancelled',
          title: 'Acesso ao grupo suspenso',
          message: `Seu pagamento falhou 3 vezes. Você foi removido do grupo ${group.name}.`,
          group: group._id,
        }).catch(() => {})
      } else {
        await Notification.create({
          user: userId, type: 'invoice_failed',
          title: 'Pagamento falhou',
          message: `A cobrança da mensalidade do grupo ${group.name} falhou (${subRec.failedAttempts}/3).`,
          group: group._id,
        }).catch(() => {})
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] invoice.payment_failed:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// customer.subscription.deleted
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSubscriptionDeleted(sub) {
  const { groupId, userId } = sub.metadata || {}
  if (!groupId || !userId) return
  try {
    const group = await Group.findById(groupId)
    if (!group) return
    group.members = group.members.filter(m => String(m) !== userId)
    group.subscriptions = group.subscriptions.filter(s => s.stripeSubscriptionId !== sub.id)
    await group.save()

    await Notification.create({
      user: userId, type: 'subscription_cancelled',
      title: 'Assinatura cancelada',
      message: `Sua assinatura do grupo ${group.name} foi cancelada.`,
      group: group._id,
    }).catch(() => {})
  } catch (err) {
    console.error('[WEBHOOK] subscription.deleted:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// payout.paid — saque chegou na conta bancária
// ═══════════════════════════════════════════════════════════════════════════════
async function handlePayoutPaid(payout, accountId) {
  if (!accountId) return
  const user = await User.findOne({ stripeAccountId: accountId })
  if (!user) return

  await Notification.create({
    user: user._id, type: 'payout_paid',
    title: 'Saque concluído!',
    message: `R$ ${(payout.amount / 100).toFixed(2)} foi depositado na sua conta bancária.`,
  }).catch(() => {})

  await Transaction.findOneAndUpdate(
    { stripePayoutId: payout.id },
    { status: 'completed' }
  ).catch(() => {})

  console.log(`[WEBHOOK] payout.paid ${payout.id} → user ${user._id}`)
}

async function handlePayoutFailed(payout, accountId) {
  if (!accountId) return
  const user = await User.findOne({ stripeAccountId: accountId })
  if (!user) return

  await Notification.create({
    user: user._id, type: 'payout_failed',
    title: 'Saque falhou',
    message: `O saque de R$ ${(payout.amount / 100).toFixed(2)} falhou. Verifique seus dados bancários.`,
  }).catch(() => {})

  await Transaction.findOneAndUpdate(
    { stripePayoutId: payout.id },
    { status: 'failed' }
  ).catch(() => {})
}

module.exports = router
}

module.exports = router
groupId, userId } = sub.metadata || {}
    if (!groupId || !userId) return

    const group = await Group.findById(groupId)
    if (!group) return

    let subRec = group.subscriptions.find(s => s.stripeSubscriptionId === subId)
    if (subRec) {
      subRec.failedAttempts = (subRec.failedAttempts || 0) + 1
      subRec.status = 'past_due'
      await group.save()

      if (subRec.failedAttempts >= 3) {
        await stripe.subscriptions.cancel(subId).catch(() => {})
        group.members = group.members.filter(m => String(m) !== userId)
        group.subscriptions = group.subscriptions.filter(s => s.stripeSubscriptionId !== subId)
        await group.save()

        await Notification.create({
          user: userId, type: 'subscription_cancelled',
          title: 'Acesso ao grupo suspenso',
          message: `Seu pagamento falhou 3 vezes. Você foi removido do grupo ${group.name}.`,
          group: group._id,
        }).catch(() => {})
      } else {
        await Notification.create({
          user: userId, type: 'invoice_failed',
          title: 'Pagamento falhou',
          message: `A cobrança do grupo ${group.name} falhou (${subRec.failedAttempts}/3).`,
          group: group._id,
        }).catch(() => {})
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] invoice.payment_failed:', err.message)
  }
}

async function handleSubscriptionDeleted(sub) {
  const { groupId, userId } = sub.metadata || {}
  if (!groupId || !userId) return
  try {
    const group = await Group.findById(groupId)
    if (!group) return
    group.members = group.members.filter(m => String(m) !== userId)
    group.subscriptions = group.subscriptions.filter(s => s.stripeSubscriptionId !== sub.id)
    await group.save()

    await Notification.create({
      user: userId, type: 'subscription_cancelled',
      title: 'Assinatura cancelada',
      message: `Sua assinatura do grupo ${group.name} foi cancelada.`,
      group: group._id,
    }).catch(() => {})
  } catch (err) {
    console.error('[WEBHOOK] subscription.deleted:', err.message)
  }
}

async function handlePayoutPaid(payout, accountId) {
  if (!accountId) return
  const user = await User.findOne({ stripeAccountId: accountId })
  if (!user) return
  await Notification.create({
    user: user._id, type: 'payout_paid',
    title: 'Saque concluído!',
    message: `R$ ${(payout.amount / 100).toFixed(2)} depositado na sua conta bancária.`,
  }).catch(() => {})
  await Transaction.findOneAndUpdate({ stripePayoutId: payout.id }, { status: 'completed' }).catch(() => {})
  console.log(`[WEBHOOK] payout.paid ${payout.id} → user ${user._id}`)
}

async function handlePayoutFailed(payout, accountId) {
  if (!accountId) return
  const user = await User.findOne({ stripeAccountId: accountId })
  if (!user) return
  await Notification.create({
    user: user._id, type: 'payout_failed',
    title: 'Saque falhou',
    message: `O saque de R$ ${(payout.amount / 100).toFixed(2)} falhou.`,
  }).catch(() => {})
  await Transaction.findOneAndUpdate({ stripePayoutId: payout.id }, { status: 'failed' }).catch(() => {})
}

module.exports = router
═══════════════
async function handlePayoutPaid(payout, accountId) {
  if (!accountId) return
  const user = await User.findOne({ stripeAccountId: accountId })
  if (!user) return
  await Notification.create({
    user: user._id, type: 'payout_paid',
    title: 'Saque concluído!',
    message: `R$ ${(payout.amount / 100).toFixed(2)} depositado na sua conta bancária.`,
  }).catch(() => {})
  await Transaction.findOneAndUpdate({ stripePayoutId: payout.id }, { status: 'completed' }).catch(() => {})
  console.log(`[WEBHOOK] payout.paid ${payout.id} → user ${user._id}`)
}

async function handlePayoutFailed(payout, accountId) {
  if (!accountId) return
  const user = await User.findOne({ stripeAccountId: accountId })
  if (!user) return
  await Notification.create({
    user: user._id, type: 'payout_failed',
    title: 'Saque falhou',
    message: `O saque de R$ ${(payout.amount / 100).toFixed(2)} falhou.`,
  }).catch(() => {})
  await Transaction.findOneAndUpdate({ stripePayoutId: payout.id }, { status: 'failed' }).catch(() => {})
}

module.exports = router
id },
    { status: 'failed' }
  ).catch(() => {})
}

module.exports = router
