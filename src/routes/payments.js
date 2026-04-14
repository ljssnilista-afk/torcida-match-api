const express    = require('express')
const mongoose   = require('mongoose')
const rateLimit  = require('express-rate-limit')
const auth       = require('../middleware/auth')
const Group      = require('../models/Group')
const Ride       = require('../models/Ride')

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

module.exports = router
