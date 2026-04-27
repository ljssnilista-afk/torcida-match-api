const express     = require('express')
const rateLimit   = require('express-rate-limit')
const auth        = require('../middleware/auth')
const User        = require('../models/User')
const Transaction = require('../models/Transaction')
const { stripe }  = require('../config/stripe')

const router = express.Router()

// ═══════════════════════════════════════════════════════════════════════════════
// Wallet — ESPELHO da Connected Account no Stripe
// (TorcidaMATCH_Financeiro_Stripe — seção 9: Carteira Espelho)
//
// REGRA DE OURO: Nenhum saldo é armazenado no MongoDB.
//   - O saldo real fica no Stripe (Connected Account do motorista/líder).
//   - O backend consulta a API do Stripe em tempo real e exibe o resultado.
//   - Isso evita o enquadramento como Instituição de Pagamento (BCB).
// ═══════════════════════════════════════════════════════════════════════════════

const MIN_PAYOUT_CENTS = 1000   // R$ 10,00 mínimo (cobre custo de payout)
const MAX_PAYOUTS_PER_DAY = 5

const payoutLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: MAX_PAYOUTS_PER_DAY,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: `Limite de ${MAX_PAYOUTS_PER_DAY} saques por dia atingido.` },
})

function formatBRL(c) {
  return `R$ ${((c || 0) / 100).toFixed(2).replace('.', ',')}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/wallet/balance
// Saldo REAL via stripe.balance.retrieve sobre a Connected Account.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/balance', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('stripeAccountId stripeOnboardingDone chargesEnabled payoutsEnabled walletBalance')
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })

    // Sem Connected Account → mostra apenas o que existe (legado)
    if (!user.stripeAccountId) {
      return res.json({
        available:   user.walletBalance || 0,
        availableFormatted: formatBRL(user.walletBalance),
        pending:     0,
        pendingFormatted: 'R$ 0,00',
        canPayout:   false,
        hasConnectAccount: false,
        onboardingDone: false,
        minPayout: MIN_PAYOUT_CENTS,
        source: 'legacy_local',
      })
    }

    // Espelho REAL do Stripe
    const balance = await stripe.balance.retrieve({ stripeAccount: user.stripeAccountId })

    const availableBRL = balance.available.find(b => b.currency === 'brl')?.amount || 0
    const pendingBRL   = balance.pending.find(b => b.currency === 'brl')?.amount || 0

    res.json({
      available:           availableBRL,
      availableFormatted:  formatBRL(availableBRL),
      pending:             pendingBRL,
      pendingFormatted:    formatBRL(pendingBRL),
      canPayout:           availableBRL >= MIN_PAYOUT_CENTS && user.payoutsEnabled,
      hasConnectAccount:   true,
      onboardingDone:      user.stripeOnboardingDone,
      chargesEnabled:      user.chargesEnabled,
      payoutsEnabled:      user.payoutsEnabled,
      minPayout:           MIN_PAYOUT_CENTS,
      source:              'stripe_mirror',
    })
  } catch (err) {
    if (err.code === 'resource_missing' || err.statusCode === 404) {
      return res.json({
        available: 0, pending: 0, canPayout: false,
        hasConnectAccount: false, onboardingDone: false,
        source: 'no_account',
      })
    }
    console.error('[WALLET] balance:', err.message)
    res.status(500).json({ error: 'Erro ao consultar saldo' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/wallet/transfers — repasses recebidos (entradas)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/transfers', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('stripeAccountId')
    if (!user?.stripeAccountId) return res.json({ transfers: [] })

    const limit = Math.min(50, parseInt(req.query.limit) || 20)

    // No Stripe, transferências chegam como "balance_transactions" type=payment
    const txs = await stripe.balanceTransactions.list(
      { limit, type: 'payment' },
      { stripeAccount: user.stripeAccountId }
    )

    const transfers = txs.data.map(t => ({
      id:        t.id,
      amount:    t.amount,
      net:       t.net,
      fee:       t.fee,
      currency:  t.currency,
      status:    t.status,
      created:   t.created,
      description: t.description,
    }))

    res.json({ transfers })
  } catch (err) {
    console.error('[WALLET] transfers:', err.message)
    res.status(500).json({ error: 'Erro ao buscar repasses' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/wallet/payouts — histórico de saques bancários
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/payouts', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('stripeAccountId')
    if (!user?.stripeAccountId) return res.json({ payouts: [] })

    const limit = Math.min(50, parseInt(req.query.limit) || 10)
    const payouts = await stripe.payouts.list(
      { limit },
      { stripeAccount: user.stripeAccountId }
    )

    const data = payouts.data.map(p => ({
      id:           p.id,
      amount:       p.amount,
      currency:     p.currency,
      status:       p.status,
      arrival_date: p.arrival_date,
      created:      p.created,
      method:       p.method,
      type:         p.type,
      description:  p.description,
    }))

    res.json({ payouts: data })
  } catch (err) {
    console.error('[WALLET] payouts:', err.message)
    res.status(500).json({ error: 'Erro ao buscar saques' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/wallet/payout — solicitar saque para conta bancária
//
// Body: { amount?: Number }  (em centavos; opcional — se omitido, saca todo
//                              o saldo disponível)
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/payout', auth, payoutLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('stripeAccountId stripeOnboardingDone payoutsEnabled handle suspendedUntil accountUnderReview')
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })

    if (user.accountUnderReview) {
      return res.status(403).json({ error: 'Conta sob revisão. Saques temporariamente bloqueados.', code: 'ACCOUNT_UNDER_REVIEW' })
    }
    if (user.suspendedUntil && user.suspendedUntil > new Date()) {
      return res.status(403).json({ error: 'Conta suspensa.', code: 'ACCOUNT_SUSPENDED' })
    }
    if (!user.stripeAccountId || !user.stripeOnboardingDone) {
      return res.status(400).json({ error: 'Conclua o cadastro financeiro primeiro.', code: 'ONBOARDING_REQUIRED' })
    }
    if (!user.payoutsEnabled) {
      return res.status(400).json({
        error: 'Saques bloqueados pelo Stripe. Verifique seus dados bancários.',
        code: 'PAYOUTS_DISABLED',
      })
    }

    // Consultar saldo real
    const balance = await stripe.balance.retrieve({ stripeAccount: user.stripeAccountId })
    const available = balance.available.find(b => b.currency === 'brl')?.amount || 0

    let amount = req.body.amount
    if (amount == null) {
      amount = available // saca tudo
    } else {
      if (typeof amount !== 'number' || !Number.isInteger(amount)) {
        return res.status(400).json({ error: 'amount deve ser inteiro (centavos)' })
      }
    }

    if (amount < MIN_PAYOUT_CENTS) {
      return res.status(400).json({ error: `Valor mínimo: ${formatBRL(MIN_PAYOUT_CENTS)}` })
    }
    if (amount > available) {
      return res.status(400).json({ error: `Saldo insuficiente. Disponível: ${formatBRL(available)}` })
    }

    // Criar payout na Connected Account (saída do Stripe → conta bancária)
    const payout = await stripe.payouts.create(
      {
        amount,
        currency: 'brl',
        method: 'standard',
        description: `Saque TorcidaMATCH — @${user.handle}`,
        metadata: { userId: String(user._id) },
      },
      { stripeAccount: user.stripeAccountId }
    )

    // Registrar transação imutável
    await Transaction.create({
      userId: user._id, type: 'payout', direction: 'debit',
      amount, status: 'pending',
      description: `Saque de ${formatBRL(amount)} (Stripe payout)`,
      stripePayoutId: payout.id,
    }).catch(e => console.error('[WALLET] tx payout:', e.message))

    console.log(`[WALLET] payout ${payout.id} | user=${user._id} | amount=${amount}`)

    res.json({
      message: `Saque de ${formatBRL(amount)} solicitado. Previsão: 1-2 dias úteis.`,
      payoutId: payout.id,
      status:   payout.status,
      arrival:  payout.arrival_date,
      amount,
    })
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      console.error('[WALLET] Stripe payout:', err.message)
      return res.status(502).json({ error: 'Erro Stripe ao processar saque.' })
    }
    console.error('[WALLET] payout:', err.message)
    res.status(500).json({ error: 'Erro ao processar saque' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/wallet/transactions — histórico paginado (Mongo)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/transactions', auth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.min(50, parseInt(req.query.limit) || 20)
  try {
    const [transactions, total] = await Promise.all([
      Transaction.find({ userId: req.user.id }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Transaction.countDocuments({ userId: req.user.id }),
    ])
    res.json({
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar histórico' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY — endpoints antigos mantidos para retro-compat
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/wallet/withdraw → mantém compatibilidade redirecionando p/ payout
router.post('/withdraw', auth, payoutLimiter, async (req, res) => {
  // Encaminha para o handler de payout
  req.url = '/payout'
  return router.handle(req, res)
})

// PUT /api/wallet/pix-key → continua salvando pix legado (cosmético — produção usa external_account no Stripe)
router.put('/pix-key', auth, async (req, res) => {
  const { pixKey, pixKeyType } = req.body
  const validTypes = ['cpf', 'email', 'phone', 'random']
  if (!pixKey || !validTypes.includes(pixKeyType)) {
    return res.status(400).json({ error: 'Chave PIX e tipo são obrigatórios' })
  }
  try {
    await User.findByIdAndUpdate(req.user.id, { pixKey, pixKeyType })
    res.json({
      message: 'Chave PIX salva. Lembre-se: saques reais usam a conta bancária cadastrada no Stripe Connect.',
    })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar chave PIX' })
  }
})

module.exports = router
