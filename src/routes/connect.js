const express = require('express')
const auth    = require('../middleware/auth')
const User    = require('../models/User')
const { stripe } = require('../config/stripe')

const router = express.Router()

// ─── URL base do frontend (para redirect após onboarding) ───────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://torcidamatch.vercel.app'

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/connect/onboard
//
// Cria (ou reutiliza) uma conta Express do Stripe Connect para o usuário
// e retorna o link de onboarding hospedado pelo Stripe.
// Motoristas e líderes de grupo precisam completar o onboarding para receber.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/onboard', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })

    let accountId = user.stripeAccountId

    // 1. Criar conta Express se ainda não existir
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'BR',
        email: user.email,
        capabilities: {
          transfers: { requested: true },
        },
        business_type: 'individual',
        business_profile: {
          name: user.name,
          product_description: 'Motorista de caronas para torcedores via TorcidaMatch',
          mcc: '4111', // Transportes locais e suburbanos
          url: FRONTEND_URL,
        },
        metadata: {
          userId: String(user._id),
          handle: user.handle,
        },
      })

      accountId = account.id
      user.stripeAccountId = accountId
      await user.save()

      console.log(`[CONNECT] Conta Express criada: ${accountId} para usuário ${user._id}`)
    }

    // 2. Gerar link de onboarding (único e com expiração)
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${FRONTEND_URL}/perfil?connect=refresh`,
      return_url:  `${FRONTEND_URL}/perfil?connect=success`,
      type: 'account_onboarding',
    })

    res.json({
      url: accountLink.url,
      accountId,
    })
  } catch (err) {
    console.error('[CONNECT] Erro ao criar onboarding:', err.message)
    res.status(500).json({ error: 'Erro ao iniciar cadastro financeiro' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/connect/status
//
// Retorna o status da conta Connect do usuário (se existe e se onboarding está OK).
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('stripeAccountId stripeOnboardingDone')
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })

    if (!user.stripeAccountId) {
      return res.json({ status: 'not_started', onboardingDone: false })
    }

    // Verificar status diretamente no Stripe
    const account = await stripe.accounts.retrieve(user.stripeAccountId)

    const onboardingDone = account.details_submitted && account.charges_enabled

    // Atualizar flag no banco se mudou
    if (onboardingDone && !user.stripeOnboardingDone) {
      user.stripeOnboardingDone = true
      await user.save()
    }

    res.json({
      status: onboardingDone ? 'active' : 'pending',
      onboardingDone,
      accountId: user.stripeAccountId,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      requirements: account.requirements?.currently_due || [],
    })
  } catch (err) {
    if (err.code === 'resource_missing') {
      // Conta foi deletada no Stripe — limpar no banco
      await User.findByIdAndUpdate(req.user.id, { stripeAccountId: null, stripeOnboardingDone: false })
      return res.json({ status: 'not_started', onboardingDone: false })
    }
    console.error('[CONNECT] Erro ao verificar status:', err.message)
    res.status(500).json({ error: 'Erro ao verificar conta financeira' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/connect/dashboard
//
// Retorna um link para o painel Express do motorista/líder no Stripe.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/dashboard', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('stripeAccountId stripeOnboardingDone')
    if (!user?.stripeAccountId || !user.stripeOnboardingDone) {
      return res.status(400).json({ error: 'Cadastro financeiro ainda não concluído' })
    }

    const loginLink = await stripe.accounts.createLoginLink(user.stripeAccountId)
    res.json({ url: loginLink.url })
  } catch (err) {
    console.error('[CONNECT] Erro ao gerar link do painel:', err.message)
    res.status(500).json({ error: 'Erro ao acessar painel financeiro' })
  }
})

module.exports = router
