const express     = require('express')
const rateLimit   = require('express-rate-limit')
const auth        = require('../middleware/auth')
const User        = require('../models/User')
const Transaction = require('../models/Transaction')
const { stripe }  = require('../config/stripe')

const router = express.Router()

const MIN_WITHDRAW_CENTS = 5000 // R$ 50,00 mínimo para saque
const MAX_WITHDRAWS_PER_DAY = 3

// Rate limit para saques
const withdrawLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24h
  max: MAX_WITHDRAWS_PER_DAY,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: `Limite de ${MAX_WITHDRAWS_PER_DAY} saques por dia atingido.` },
})

function formatBRL(centavos) {
  return `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/wallet/balance
// Retorna saldo da carteira + últimas transações
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/balance', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('walletBalance pixKey pixKeyType stripeAccountId stripeOnboardingDone')
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })

    const transactions = await Transaction.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean()

    res.json({
      balance: user.walletBalance,
      balanceFormatted: formatBRL(user.walletBalance),
      hasPixKey: !!user.pixKey,
      pixKeyType: user.pixKeyType,
      hasConnectAccount: !!user.stripeAccountId,
      onboardingDone: user.stripeOnboardingDone,
      canWithdraw: user.walletBalance >= MIN_WITHDRAW_CENTS,
      minWithdraw: MIN_WITHDRAW_CENTS,
      transactions,
    })
  } catch (err) {
    console.error('[WALLET] Erro ao buscar saldo:', err.message)
    res.status(500).json({ error: 'Erro ao carregar carteira' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /api/wallet/pix-key
// Salva/atualiza a chave PIX do usuário (simples — criptografia avançada em produção)
// ═══════════════════════════════════════════════════════════════════════════════
router.put('/pix-key', auth, async (req, res) => {
  const { pixKey, pixKeyType } = req.body

  const validTypes = ['cpf', 'email', 'phone', 'random']
  if (!pixKey || !validTypes.includes(pixKeyType)) {
    return res.status(400).json({ error: 'Chave PIX e tipo são obrigatórios' })
  }

  // Validação básica por tipo
  if (pixKeyType === 'cpf' && !/^\d{11}$/.test(pixKey.replace(/\D/g, ''))) {
    return res.status(400).json({ error: 'CPF inválido' })
  }
  if (pixKeyType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pixKey)) {
    return res.status(400).json({ error: 'E-mail inválido' })
  }
  if (pixKeyType === 'phone' && !/^\+?55\d{10,11}$/.test(pixKey.replace(/\D/g, '').replace(/^/, '+55').slice(0,13))) {
    return res.status(400).json({ error: 'Telefone inválido. Use formato +5511999999999' })
  }

  try {
    // TODO (produção): criptografar pixKey com AES-256 antes de salvar
    await User.findByIdAndUpdate(req.user.id, { pixKey, pixKeyType })
    res.json({ message: 'Chave PIX salva com sucesso' })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar chave PIX' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/wallet/withdraw
//
// Saque do saldo da carteira para conta bancária/PIX via Stripe Connect.
// Requer:
//  - Conta Connect com onboarding concluído
//  - Saldo ≥ R$ 50,00
//  - Máx 3 saques por dia (rate limit)
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/withdraw', auth, withdrawLimiter, async (req, res) => {
  const { amount } = req.body // centavos

  if (!amount || typeof amount !== 'number' || amount < MIN_WITHDRAW_CENTS) {
    return res.status(400).json({
      error: `Valor mínimo para saque é ${formatBRL(MIN_WITHDRAW_CENTS)}`,
    })
  }

  try {
    const user = await User.findById(req.user.id)
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })

    // Verificar conta Connect
    if (!user.stripeAccountId || !user.stripeOnboardingDone) {
      return res.status(400).json({
        error: 'Complete o cadastro financeiro para sacar',
      })
    }

    // Verificar saldo
    if (user.walletBalance < amount) {
      return res.status(400).json({
        error: `Saldo insuficiente. Disponível: ${formatBRL(user.walletBalance)}`,
      })
    }

    // 1. Criar transferência via Stripe Connect
    const transfer = await stripe.transfers.create({
      amount,
      currency: 'brl',
      destination: user.stripeAccountId,
      description: `Saque TorcidaMatch — @${user.handle}`,
      metadata: {
        userId: String(user._id),
        type: 'wallet_withdraw',
      },
    })

    // 2. Debitar saldo da carteira
    user.walletBalance -= amount
    await user.save()

    // 3. Registrar transação
    const tx = await Transaction.create({
      userId: user._id,
      type: 'withdraw',
      amount,
      status: 'completed',
      description: `Saque de ${formatBRL(amount)} via Stripe Connect`,
      stripeTransferId: transfer.id,
    })

    console.log(`[WALLET] Saque de ${formatBRL(amount)} para @${user.handle} | transfer=${transfer.id}`)

    res.json({
      message: `Saque de ${formatBRL(amount)} solicitado com sucesso! O valor cairá em até 1 dia útil.`,
      transfer: transfer.id,
      newBalance: user.walletBalance,
      newBalanceFormatted: formatBRL(user.walletBalance),
      transactionId: tx._id,
    })
  } catch (err) {
    if (err.type?.startsWith('Stripe')) {
      console.error('[WALLET] Erro Stripe no saque:', err.message)
      return res.status(502).json({ error: 'Erro ao processar saque. Tente novamente.' })
    }
    console.error('[WALLET] Erro no saque:', err.message)
    res.status(500).json({ error: 'Erro ao processar saque' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/wallet/transactions
// Histórico paginado de transações
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/transactions', auth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.min(50, parseInt(req.query.limit) || 20)

  try {
    const [transactions, total] = await Promise.all([
      Transaction.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
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

module.exports = router
