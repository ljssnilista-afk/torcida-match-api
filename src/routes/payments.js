const express      = require('express')
const mongoose     = require('mongoose')
const rateLimit    = require('express-rate-limit')
const bcrypt       = require('bcryptjs')
const crypto       = require('crypto')
const auth         = require('../middleware/auth')
const Group        = require('../models/Group')
const Ride         = require('../models/Ride')
const User         = require('../models/User')
const Notification = require('../models/Notification')
const Transaction  = require('../models/Transaction')

// 💳 Stripe — chaves selecionadas automaticamente (test/live) por NODE_ENV
const { stripe, publishableKey, mode } = require('../config/stripe')

const router = express.Router()

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTES — Taxas da plataforma (alinhadas com TorcidaMATCH_Financeiro_Stripe)
// ═══════════════════════════════════════════════════════════════════════════════
const RIDE_FEE_PCT  = 0.08   // 8% comissão sobre viagens
const GROUP_FEE_PCT = 0.20   // 20% comissão sobre mensalidades
const TOKEN_TTL_HOURS         = 24
const CANCEL_DEADLINE_HOURS   = 2

// ─── Rate Limiting — pagamentos: max 10 req/min por IP ──────────────────────
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de pagamento. Aguarde 1 minuto.' },
})

// ─── Helpers ────────────────────────────────────────────────────────────────
function validId(paramName = 'id') {
  return (req, res, next) => {
    const id = req.params[paramName] || req.body[paramName]
    if (id && !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'ID inválido' })
    }
    next()
  }
}

function validateAmount(amount) {
  if (!Number.isInteger(amount)) return 'Amount deve ser um número inteiro (centavos)'
  if (amount < 100) return 'Valor mínimo: R$ 1,00 (100 centavos)'
  if (amount > 99999900) return 'Valor máximo: R$ 999.999,00'
  return null
}

/** Gera token numérico de 6 dígitos crypto-random, e seu hash bcrypt. */
async function generateNumericToken() {
  // 6 dígitos: 100000 a 999999
  const num = (crypto.randomInt(0, 900000) + 100000).toString()
  const hash = await bcrypt.hash(num, 10)
  return { code: num, hash }
}

/** Garante que o usuário tenha stripeCustomerId (cria se necessário). */
async function ensureCustomer(userDoc) {
  if (userDoc.stripeCustomerId) return userDoc.stripeCustomerId
  const customer = await stripe.customers.create({
    email: userDoc.email,
    name:  userDoc.name,
    metadata: { userId: String(userDoc._id), handle: userDoc.handle },
  })
  userDoc.stripeCustomerId = customer.id
  await userDoc.save()
  return customer.id
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/create-group-payment-intent
//
// Cria PaymentIntent para mensalidade ÚNICA do grupo (sem recorrência).
// Captura imediata + 20% application_fee + transfer_data.destination = líder.
// Para recorrência mensal use POST /create-group-subscription (abaixo).
// ═══════════════════════════════════════════════════════════════════════════════
router.post(
  '/create-group-payment-intent',
  paymentLimiter,
  auth,
  validId('groupId'),
  async (req, res) => {
    try {
      const { groupId } = req.body
      if (!groupId) return res.status(400).json({ error: 'groupId é obrigatório' })

      const group = await Group.findById(groupId).populate('leader', 'stripeAccountId stripeOnboardingDone chargesEnabled')
      if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })
      if (!group.isPago || group.membershipFee < 100) {
        return res.status(400).json({ error: 'Grupo não tem mensalidade ativa' })
      }

      // Líder precisa estar onboarded
      if (!group.leader?.stripeAccountId || !group.leader.stripeOnboardingDone || !group.leader.chargesEnabled) {
        return res.status(400).json({
          error: 'Líder do grupo ainda não concluiu o cadastro financeiro.',
          code: 'LEADER_NOT_ONBOARDED',
        })
      }

      // Solicitante precisa estar pendente de pagamento
      const pending = group.pendingMembers?.find(
        p => String(p.user) === String(req.user.id) && p.status === 'pendingPayment'
      )
      if (!pending) {
        return res.status(400).json({ error: 'Nenhum pagamento pendente para este grupo' })
      }

      const amount = group.membershipFee
      const amountError = validateAmount(amount)
      if (amountError) return res.status(400).json({ error: amountError })

      // Garantir customer
      const userDoc = await User.findById(req.user.id)
      const customerId = await ensureCustomer(userDoc)

      const applicationFee = Math.round(amount * GROUP_FEE_PCT)

      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'brl',
        customer: customerId,
        application_fee_amount: applicationFee,
        transfer_data: { destination: group.leader.stripeAccountId },
        // Captura automática (mensalidade — serviço entregue na hora)
        metadata: {
          type: 'group_membership',
          groupId: String(group._id),
          groupName: group.name,
          userId: String(req.user.id),
          userName: req.user.name,
          leaderUserId: String(group.leader._id),
        },
        automatic_payment_methods: { enabled: true },
        description: `Mensalidade — ${group.name}`,
      })

      // Salvar paymentIntentId no pending
      pending.stripePaymentIntentId = paymentIntent.id
      await group.save()

      console.log(`[PAYMENT] PI grupo: ${paymentIntent.id} | grupo=${groupId} | amount=${amount} | fee=${applicationFee}`)

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount,
        currency: 'brl',
        applicationFee,
      })
    } catch (err) {
      return handleStripeError(err, res, 'Erro ao processar pagamento de grupo')
    }
  }
)

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/create-group-subscription
//
// Mensalidade RECORRENTE — cria Stripe Subscription mensal.
// O membro cadastra o cartão uma vez; o Stripe cobra todo mês automaticamente.
// application_fee_percent: 20 + transfer_data.destination = líder.
// ═══════════════════════════════════════════════════════════════════════════════
router.post(
  '/create-group-subscription',
  paymentLimiter,
  auth,
  validId('groupId'),
  async (req, res) => {
    try {
      const { groupId } = req.body
      if (!groupId) return res.status(400).json({ error: 'groupId é obrigatório' })

      const group = await Group.findById(groupId).populate('leader', 'stripeAccountId stripeOnboardingDone chargesEnabled')
      if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })
      if (!group.isPago) return res.status(400).json({ error: 'Grupo não é pago' })
      if (!group.leader?.stripeAccountId || !group.leader.stripeOnboardingDone) {
        return res.status(400).json({ error: 'Líder não concluiu cadastro financeiro' })
      }

      // 1) Garantir Product + Price (criados na primeira ativação)
      if (!group.stripeProductId) {
        const product = await stripe.products.create({
          name: `Mensalidade ${group.name}`,
          metadata: { groupId: String(group._id), leaderId: String(group.leader._id) },
        })
        group.stripeProductId = product.id
      }
      if (!group.stripePriceId) {
        const price = await stripe.prices.create({
          product:    group.stripeProductId,
          unit_amount: group.membershipFee,
          currency:   'brl',
          recurring:  { interval: 'month' },
          metadata:   { groupId: String(group._id) },
        })
        group.stripePriceId = price.id
        await group.save()
      }

      // 2) Customer
      const userDoc = await User.findById(req.user.id)
      const customerId = await ensureCustomer(userDoc)

      // 3) Subscription com transfer_data + application_fee_percent
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: group.stripePriceId }],
        application_fee_percent: GROUP_FEE_PCT * 100,
        transfer_data: { destination: group.leader.stripeAccountId },
        payment_behavior: 'default_incomplete',
        payment_settings: {
          save_default_payment_method: 'on_subscription',
          payment_method_types: ['card'],
        },
        expand: ['latest_invoice.payment_intent'],
        metadata: {
          type: 'group_subscription',
          groupId: String(group._id),
          userId:  String(req.user.id),
          leaderUserId: String(group.leader._id),
        },
      })

      const pi = subscription.latest_invoice?.payment_intent
      console.log(`[PAYMENT] Subscription criada: ${subscription.id} | grupo=${groupId}`)

      res.json({
        subscriptionId: subscription.id,
        clientSecret:   pi?.client_secret || null,
        status:         subscription.status,
        amount:         group.membershipFee,
        currency:       'brl',
      })
    } catch (err) {
      return handleStripeError(err, res, 'Erro ao criar assinatura')
    }
  }
)

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/create-ride-payment-intent
//
// Reserva de vaga em viagem — ESCROW (capture_method: manual).
// Stripe autoriza no cartão mas NÃO captura. A captura ocorre no
// validate-code (motorista valida o token de 6 dígitos no embarque).
// ═══════════════════════════════════════════════════════════════════════════════
router.post(
  '/create-ride-payment-intent',
  paymentLimiter,
  auth,
  validId('rideId'),
  async (req, res) => {
    try {
      const { rideId } = req.body
      if (!rideId) return res.status(400).json({ error: 'rideId é obrigatório' })

      const ride = await Ride.findById(rideId)
      if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
      if (ride.status !== 'open') {
        return res.status(400).json({ error: 'Viagem não está aberta para reservas' })
      }
      if (String(ride.driver) === String(req.user.id)) {
        return res.status(400).json({ error: 'Você é o motorista desta viagem' })
      }

      // Já tem reserva ativa?
      const alreadyIn = ride.passengers.find(
        p => String(p.user) === String(req.user.id) &&
             !['cancelled', 'no_show', 'unvalidated'].includes(p.status)
      )
      if (alreadyIn) {
        return res.status(400).json({ error: 'Você já tem uma reserva nesta viagem' })
      }

      // Vagas disponíveis
      const active = ride.passengers.filter(
        p => !['cancelled', 'no_show', 'unvalidated'].includes(p.status)
      ).length
      if (active >= ride.totalSeats) {
        return res.status(400).json({ error: 'Não há vagas disponíveis' })
      }

      // Motorista deve estar onboarded
      const driver = await User.findById(ride.driver).select('stripeAccountId stripeOnboardingDone chargesEnabled')
      if (!driver?.stripeAccountId || !driver.stripeOnboardingDone || !driver.chargesEnabled) {
        return res.status(400).json({
          error: 'Motorista ainda não concluiu o cadastro financeiro.',
          code: 'DRIVER_NOT_ONBOARDED',
        })
      }

      // Calcular preço
      let isMember = false
      let finalPrice = ride.price
      if (ride.group) {
        const group = await Group.findById(ride.group)
        if (group && group.members.map(String).includes(String(req.user.id))) {
          isMember = true
          if (ride.memberPrice != null) finalPrice = ride.memberPrice
        }
      }

      const amountError = validateAmount(finalPrice)
      if (amountError) return res.status(400).json({ error: amountError })

      // Customer (passageiro)
      const userDoc = await User.findById(req.user.id)
      const customerId = await ensureCustomer(userDoc)

      const applicationFee = Math.round(finalPrice * RIDE_FEE_PCT)

      const paymentIntent = await stripe.paymentIntents.create({
        amount: finalPrice,
        currency: 'brl',
        customer: customerId,
        // ⚠️ ESCROW: autorizar agora, capturar SOMENTE quando motorista validar o token
        capture_method: 'manual',
        application_fee_amount: applicationFee,
        transfer_data: { destination: driver.stripeAccountId },
        metadata: {
          type: 'ride_reservation',
          rideId: String(ride._id),
          userId: String(req.user.id),
          userName: req.user.name,
          isMember: String(isMember),
          driverId: String(ride.driver),
          gameInfo: `${ride.game.homeTeam} x ${ride.game.awayTeam}`,
        },
        automatic_payment_methods: { enabled: true },
        description: `Viagem ${ride.shareCode} — ${ride.game.homeTeam} x ${ride.game.awayTeam}`,
      })

      console.log(`[PAYMENT] PI ride (escrow): ${paymentIntent.id} | ride=${rideId} | amount=${finalPrice} | fee=${applicationFee}`)

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: finalPrice,
        currency: 'brl',
        applicationFee,
        isMember,
      })
    } catch (err) {
      return handleStripeError(err, res, 'Erro ao processar pagamento')
    }
  }
)

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/payments/config
// Chave pública para o frontend (Stripe.js)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/config', (req, res) => {
  res.json({ publishableKey, mode })
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/confirm-ride
//
// Chamado pelo FRONTEND após stripe.confirmPayment() retornar
// 'requires_capture'. Registra a reserva no banco com:
//   - validationCode TM-XXXX (legado)
//   - paymentToken (bcrypt hash de 6 dígitos numéricos — NUNCA o código bruto)
//   - tokenExpiresAt (game.date + 24h)
//   - cancellationDeadline (departureTime − 2h)
//   - escrowAmount + platformFee (snapshots imutáveis)
//
// O código numérico de 6 dígitos é retornado UMA ÚNICA VEZ aqui — o passageiro
// deve guardá-lo. O backend só armazena o hash.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/confirm-ride', paymentLimiter, auth, async (req, res) => {
  const { paymentIntentId, rideId } = req.body
  if (!paymentIntentId || !rideId) {
    return res.status(400).json({ error: 'paymentIntentId e rideId são obrigatórios' })
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId)
    if (!['succeeded', 'requires_capture'].includes(pi.status)) {
      return res.status(400).json({ error: `Pagamento não confirmado. Status: ${pi.status}` })
    }
    if (pi.metadata?.userId !== String(req.user.id)) {
      return res.status(403).json({ error: 'PaymentIntent não pertence a este usuário' })
    }
    if (pi.metadata?.rideId !== String(rideId)) {
      return res.status(400).json({ error: 'PaymentIntent não corresponde a esta viagem' })
    }

    const ride = await Ride.findById(rideId)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    // Idempotência
    const existing = ride.passengers.find(
      p => String(p.user) === String(req.user.id) &&
           !['cancelled', 'no_show', 'unvalidated'].includes(p.status)
    )
    if (existing) {
      return res.json({
        message: 'Reserva já confirmada',
        validationCode: existing.validationCode,
        alreadyConfirmed: true,
      })
    }

    // Gerar código legado TM-XXXX (compat) + token numérico de 6 dígitos
    const genShortCode = () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      let code = 'TM-'
      for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]
      return code
    }
    let validationCode = genShortCode()
    while (ride.passengers.some(p => p.validationCode === validationCode)) {
      validationCode = genShortCode()
    }

    const { code: numericToken, hash: tokenHash } = await generateNumericToken()

    // Deadlines (snapshots imutáveis)
    const tokenExpiresAt       = new Date(new Date(ride.game.date).getTime() + TOKEN_TTL_HOURS * 60 * 60 * 1000)
    const cancellationDeadline = new Date(new Date(ride.departureTime).getTime() - CANCEL_DEADLINE_HOURS * 60 * 60 * 1000)
    const platformFee          = Math.round(pi.amount * RIDE_FEE_PCT)

    const user = await User.findById(req.user.id).select('name handle')

    ride.passengers.push({
      user: req.user.id,
      name: user?.name || pi.metadata.userName || 'Passageiro',
      handle: user?.handle || '',
      status: 'authorized',
      paidAmount: pi.amount,
      escrowAmount: pi.amount,
      platformFee,
      isMember: pi.metadata.isMember === 'true',
      validationCode,
      paymentToken: tokenHash,         // bcrypt hash — código bruto NUNCA volta no DB
      paymentIntentId,
      tokenExpiresAt,
      cancellationDeadline,
    })

    ride.escrowTotal += pi.amount
    const activeCount = ride.passengers.filter(
      p => !['cancelled', 'no_show', 'unvalidated'].includes(p.status)
    ).length
    if (activeCount >= ride.totalSeats) ride.status = 'full'

    await ride.save()

    // Transação imutável
    await Transaction.create({
      userId:                req.user.id,
      type:                  'ride_reserve',
      direction:             'debit',
      amount:                pi.amount,
      status:                'pending',
      description:           `Reserva — viagem ${ride.shareCode} (${ride.game.homeTeam} × ${ride.game.awayTeam})`,
      relatedId:             ride._id,
      relatedType:           'ride',
      stripePaymentIntentId: paymentIntentId,
      appCommission:         platformFee,
    }).catch(e => console.error('[CONFIRM-RIDE] Transaction:', e.message))

    // Notificações
    await Promise.allSettled([
      Notification.create({
        user: req.user.id,
        type: 'ride_payment_confirmed',
        title: 'Vaga garantida! 🎟️',
        message: `Reserva ${ride.shareCode} confirmada. Mostre o código ${numericToken} ao motorista no embarque.`,
      }),
      Notification.create({
        user: ride.driver,
        type: 'ride_new_passenger',
        title: 'Nova reserva!',
        message: `${user?.name || 'Passageiro'} reservou uma vaga em ${ride.shareCode}.`,
        fromUser: req.user.id,
        fromName: user?.name,
      }),
    ])

    console.log(`[CONFIRM-RIDE] ride=${rideId} user=${req.user.id} authorized | escrow=R$${(pi.amount/100).toFixed(2)}`)

    res.json({
      message: 'Reserva confirmada com sucesso!',
      validationCode,            // legado TM-XXXX (compat com motoristas atuais)
      paymentToken: numericToken, // 6 dígitos — exibir UMA VEZ no frontend
      tokenExpiresAt,
      cancellationDeadline,
      rideShareCode: ride.shareCode,
    })
  } catch (err) {
    return handleStripeError(err, res, 'Erro ao confirmar reserva')
  }
})

// ─── Helper de erros do Stripe ──────────────────────────────────────────────
function handleStripeError(err, res, fallbackMsg) {
  if (err.type === 'StripeCardError') {
    return res.status(400).json({ error: 'Erro no cartão. Verifique os dados.' })
  }
  if (err.type === 'StripeInvalidRequestError') {
    console.error('[STRIPE]', err.message)
    return res.status(400).json({ error: 'Dados de pagamento inválidos.' })
  }
  if (err.type === 'StripeAPIError' || err.type === 'StripeConnectionError') {
    return res.status(502).json({ error: 'Erro temporário. Tente novamente.' })
  }
  if (err.type === 'StripeRateLimitError') {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }
  console.error('[PAYMENT]', err.message)
  return res.status(500).json({ error: fallbackMsg })
}

module.exports = router
