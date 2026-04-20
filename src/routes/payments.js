const express      = require('express')
const mongoose     = require('mongoose')
const rateLimit    = require('express-rate-limit')
const auth         = require('../middleware/auth')
const Group        = require('../models/Group')
const Ride         = require('../models/Ride')
const User         = require('../models/User')
const Notification  = require('../models/Notification')
const Transaction   = require('../models/Transaction')

// 💳 Stripe — chaves selecionadas automaticamente (test/live) por NODE_ENV
const { stripe, publishableKey, mode } = require('../config/stripe')

const router = express.Router()

// ─── Rate Limiting — pagamentos: max 10 req/min por IP ──────────────────────
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de pagamento. Aguarde 1 minuto.' },
})

// ─── Helper: validar ObjectId ────────────────────────────────────────────────
function validId(paramName = 'id') {
  return (req, res, next) => {
    const id = req.params[paramName] || req.body[paramName]
    if (id && !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'ID inválido' })
    }
    next()
  }
}

// ─── Helper: validar amount (inteiro positivo em centavos) ──────────────────
function validateAmount(amount) {
  if (!Number.isInteger(amount)) return 'Amount deve ser um número inteiro (centavos)'
  if (amount < 100) return 'Valor mínimo: R$ 1,00 (100 centavos)'
  if (amount > 99999900) return 'Valor máximo: R$ 999.999,00'
  return null
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/create-group-payment-intent
// Cria PaymentIntent para mensalidade de grupo
// ═══════════════════════════════════════════════════════════════════════════════
router.post(
  '/create-group-payment-intent',
  paymentLimiter,
  auth,
  validId('groupId'),
  async (req, res) => {
    try {
      const { groupId } = req.body

      if (!groupId) {
        return res.status(400).json({ error: 'groupId é obrigatório' })
      }

      // Buscar grupo e validar
      const group = await Group.findById(groupId)
      if (!group) {
        return res.status(404).json({ error: 'Grupo não encontrado' })
      }

      // Verificar se o usuário está pendente de pagamento
      const pending = group.pendingMembers?.find(
        p => String(p.user) === String(req.user.id) && p.status === 'pendingPayment'
      )
      if (!pending) {
        return res.status(400).json({ error: 'Nenhum pagamento pendente para este grupo' })
      }

      // IMPORTANTE: calcular valor no backend — NUNCA confiar no frontend
      const amount = group.membershipFee
      const amountError = validateAmount(amount)
      if (amountError) {
        return res.status(400).json({ error: amountError })
      }

      // Criar PaymentIntent no Stripe
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'brl',
        metadata: {
          type: 'group_membership',
          groupId: String(group._id),
          groupName: group.name,
          userId: String(req.user.id),
          userName: req.user.name,
        },
        // Métodos de pagamento aceitos no Brasil
        automatic_payment_methods: { enabled: true },
        description: `Mensalidade - ${group.name}`,
      })

      // Log de auditoria (sem dados sensíveis)
      console.log(`[PAYMENT] PaymentIntent criado: ${paymentIntent.id} | grupo=${groupId} | user=${req.user.id} | amount=${amount}`)

      // Retornar APENAS o client_secret — NUNCA a chave secreta
      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount,
        currency: 'brl',
      })
    } catch (err) {
      // Tratar erros específicos do Stripe
      if (err.type === 'StripeCardError') {
        console.error(`[PAYMENT] StripeCardError: ${err.message}`)
        return res.status(400).json({ error: 'Erro no cartão. Verifique os dados e tente novamente.' })
      }
      if (err.type === 'StripeInvalidRequestError') {
        console.error(`[PAYMENT] StripeInvalidRequestError: ${err.message}`)
        return res.status(400).json({ error: 'Dados de pagamento inválidos.' })
      }
      if (err.type === 'StripeAPIError') {
        console.error(`[PAYMENT] StripeAPIError: ${err.message}`)
        return res.status(502).json({ error: 'Erro temporário no processamento. Tente novamente.' })
      }
      if (err.type === 'StripeConnectionError') {
        console.error(`[PAYMENT] StripeConnectionError: ${err.message}`)
        return res.status(502).json({ error: 'Falha de conexão com o processador. Tente novamente.' })
      }
      if (err.type === 'StripeRateLimitError') {
        console.error(`[PAYMENT] StripeRateLimitError`)
        return res.status(429).json({ error: 'Muitas requisições. Aguarde e tente novamente.' })
      }

      console.error('[PAYMENT] Erro inesperado:', err.message)
      res.status(500).json({ error: 'Erro ao processar pagamento' })
    }
  }
)

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/create-ride-payment-intent
// Cria PaymentIntent para reserva de vaga em viagem
// ═══════════════════════════════════════════════════════════════════════════════
router.post(
  '/create-ride-payment-intent',
  paymentLimiter,
  auth,
  validId('rideId'),
  async (req, res) => {
    try {
      const { rideId } = req.body

      if (!rideId) {
        return res.status(400).json({ error: 'rideId é obrigatório' })
      }

      const ride = await Ride.findById(rideId)
      if (!ride) {
        return res.status(404).json({ error: 'Viagem não encontrada' })
      }

      if (ride.status !== 'open') {
        return res.status(400).json({ error: 'Viagem não está aberta para reservas' })
      }

      if (String(ride.driver) === String(req.user.id)) {
        return res.status(400).json({ error: 'Você é o motorista desta viagem' })
      }

      // Verificar se já reservou
      const alreadyIn = ride.passengers.find(
        p => String(p.user) === String(req.user.id) && p.status !== 'cancelled'
      )
      if (alreadyIn) {
        return res.status(400).json({ error: 'Você já tem uma reserva nesta viagem' })
      }

      // Vagas disponíveis
      const active = ride.passengers.filter(p => p.status !== 'cancelled').length
      if (active >= ride.totalSeats) {
        return res.status(400).json({ error: 'Não há vagas disponíveis' })
      }

      // CALCULAR PREÇO NO BACKEND — verificar se é membro do grupo
      let isMember = false
      let finalPrice = ride.price

      if (ride.group) {
        const group = await Group.findById(ride.group)
        if (group && group.members.map(String).includes(String(req.user.id))) {
          isMember = true
          if (ride.memberPrice != null) {
            finalPrice = ride.memberPrice
          }
        }
      }

      const amountError = validateAmount(finalPrice)
      if (amountError) {
        return res.status(400).json({ error: amountError })
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: finalPrice,
        currency: 'brl',
        // ⚠️ ESCROW: autorizar agora, capturar SOMENTE quando o motorista
        // validar o código TM-XXXX do passageiro no embarque.
        capture_method: 'manual',
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
        description: `Viagem ${ride.shareCode} - ${ride.game.homeTeam} x ${ride.game.awayTeam}`,
      })

      console.log(`[PAYMENT] PaymentIntent criado: ${paymentIntent.id} | ride=${rideId} | user=${req.user.id} | amount=${finalPrice}`)

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: finalPrice,
        currency: 'brl',
        isMember,
      })
    } catch (err) {
      if (err.type === 'StripeCardError') {
        return res.status(400).json({ error: 'Erro no cartão. Verifique os dados.' })
      }
      if (err.type === 'StripeInvalidRequestError') {
        return res.status(400).json({ error: 'Dados de pagamento inválidos.' })
      }
      if (err.type === 'StripeAPIError' || err.type === 'StripeConnectionError') {
        return res.status(502).json({ error: 'Erro temporário. Tente novamente.' })
      }

      console.error('[PAYMENT] Erro inesperado:', err.message)
      res.status(500).json({ error: 'Erro ao processar pagamento' })
    }
  }
)

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/payments/config
// Retorna a chave publicável para o frontend (sem expor a secreta)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/config', (req, res) => {
  res.json({
    publishableKey,
    mode, // 'test' ou 'live' — útil para UI indicar modo de teste
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/payments/confirm-ride
//
// Chamado pelo FRONTEND imediatamente após stripe.confirmPayment() retornar
// com status 'succeeded'. Garante o registro da reserva no banco mesmo que o
// webhook do Stripe demore ou falhe.
//
// Body: { paymentIntentId: String, rideId: String }
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/confirm-ride', paymentLimiter, auth, async (req, res) => {
  const { paymentIntentId, rideId } = req.body

  if (!paymentIntentId || !rideId) {
    return res.status(400).json({ error: 'paymentIntentId e rideId são obrigatórios' })
  }

  try {
    // 1. Verificar o PaymentIntent diretamente no Stripe
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId)

    if (pi.status !== 'succeeded' && pi.status !== 'requires_capture') {
      return res.status(400).json({
        error: `Pagamento ainda não confirmado. Status: ${pi.status}`,
      })
    }

    // 2. Validar que o PI pertence a este usuário e a esta viagem
    const metaUserId = pi.metadata?.userId
    const metaRideId = pi.metadata?.rideId

    if (metaUserId !== String(req.user.id)) {
      return res.status(403).json({ error: 'PaymentIntent não pertence a este usuário' })
    }
    if (metaRideId !== String(rideId)) {
      return res.status(400).json({ error: 'PaymentIntent não corresponde a esta viagem' })
    }

    // 3. Buscar viagem
    const ride = await Ride.findById(rideId)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    // 4. Idempotência — passageiro já foi adicionado? (webhook pode ter chegado primeiro)
    const existing = ride.passengers.find(
      p => String(p.user) === String(req.user.id) && p.status !== 'cancelled'
    )

    if (existing) {
      // Já registrado — retornar o código existente
      return res.json({
        message: 'Reserva já confirmada',
        validationCode: existing.validationCode || `TM-${existing._id.toString().slice(-4).toUpperCase()}`,
        alreadyConfirmed: true,
      })
    }

    // 5. Gerar código de validação único (TM-XXXX)
    const genCode = () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      let code = 'TM-'
      for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]
      return code
    }

    let validationCode = genCode()
    // Garantir unicidade dentro da viagem (improvável mas seguro)
    while (ride.passengers.some(p => p.validationCode === validationCode)) {
      validationCode = genCode()
    }

    // 6. Adicionar passageiro com status 'authorized' (pagamento autorizado, não capturado)
    // O crédito do motorista SÓ acontece após validação do código TM-XXXX no embarque.
    const user = await User.findById(req.user.id).select('name handle')

    ride.passengers.push({
      user: req.user.id,
      name: user?.name || pi.metadata.userName || 'Passageiro',
      handle: user?.handle || '',
      status: 'authorized',          // ← escrow: autorizado, aguarda validação
      paidAmount: pi.amount,
      isMember: pi.metadata.isMember === 'true',
      validationCode,
      paymentIntentId,
    })

    // 7. Atualizar escrow e status da viagem
    ride.escrowTotal += pi.amount
    const activeCount = ride.passengers.filter(p => p.status !== 'cancelled').length
    if (activeCount >= ride.totalSeats) ride.status = 'full'

    await ride.save()

    // 8. Transação do passageiro (authorization — pending capture)
    await Transaction.create({
      userId:                req.user.id,
      type:                  'payment',
      amount:                pi.amount,
      status:                'pending',     // ← pending até o motorista capturar
      description:           `Autorização reserva viagem ${ride.shareCode} — ${ride.game?.homeTeam} × ${ride.game?.awayTeam}`,
      relatedId:             ride._id,
      relatedType:           'ride',
      stripePaymentIntentId: paymentIntentId,
      appCommission:         Math.round(pi.amount * 0.20),
    }).catch(e => console.error('[CONFIRM-RIDE] Falha ao registrar Transaction passageiro:', e.message))

    console.log(`[CONFIRM-RIDE] Viagem ${rideId}: passageiro ${req.user.id} autorizado | código ${validationCode} | aguarda validação no embarque`)

    // 9. Notificações
    await Promise.allSettled([
      Notification.create({
        user: req.user.id,
        type: 'ride_payment_confirmed',
        title: 'Vaga garantida!',
        message: `Sua vaga na viagem ${ride.shareCode} está reservada. Mostre o código ${validationCode} ao motorista no embarque.`,
      }),
      Notification.create({
        user: ride.driver,
        type: 'ride_new_passenger',
        title: 'Nova reserva!',
        message: `${user?.name || 'Passageiro'} reservou uma vaga na viagem ${ride.shareCode}. Valide o código no embarque para confirmar o pagamento.`,
        fromUser: req.user.id,
        fromName: user?.name,
      }),
    ])

    res.json({
      message: 'Reserva confirmada com sucesso!',
      validationCode,
      rideShareCode: ride.shareCode,
    })
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      return res.status(502).json({ error: 'Erro ao verificar pagamento com Stripe' })
    }
    console.error('[CONFIRM-RIDE] Erro:', err.message)
    res.status(500).json({ error: 'Erro ao confirmar reserva' })
  }
})

module.exports = router
