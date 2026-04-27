const express = require('express')
const auth    = require('../middleware/auth')
const User    = require('../models/User')
const { stripe } = require('../config/stripe')

const router = express.Router()

// ─── URL base do frontend (para redirect após onboarding) ───────────────────
const FRONTEND_URL = process.env.FRONTEND_URL
  || process.env.CLIENT_URL
  || 'https://torcidamatch.vercel.app'

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/connect/onboard
//
// Cria (ou reutiliza) uma Connected Account Express e retorna o accountLink
// hospedado pelo Stripe. Motoristas e líderes precisam disso ANTES de:
//   - Criar viagem paga
//   - Criar grupo privado pago (mensalidade)
//
// O Stripe cuida do KYC (CPF, dados bancários, selfie). Nós nunca tocamos
// nesses dados — apenas guardamos o accountId.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/onboard', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })

    // Bloqueio se conta sob revisão
    if (user.accountUnderReview) {
      return res.status(403).json({
        error: 'Sua conta está sob revisão. Entre em contato com o suporte.',
        code: 'ACCOUNT_UNDER_REVIEW',
      })
    }

    let accountId = user.stripeAccountId

    // 1. Criar Connected Account Express se ainda não existir
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'BR',
        email: user.email,
        capabilities: {
          // Recebe pagamentos via PaymentIntent (transfer_data)
          transfers: { requested: true },
          // Permite cobrar pagamentos diretos (mensalidade recorrente)
          card_payments: { requested: true },
        },
        business_type: 'individual',
        business_profile: {
          name: user.name,
          product_description: 'Caronas de torcedores e gestão de grupos via TorcidaMATCH',
          mcc: '4111', // Transportes locais e suburbanos
          url: FRONTEND_URL,
        },
        settings: {
          payouts: {
            schedule: { interval: 'manual' }, // saque sob demanda do líder/motorista
          },
        },
        metadata: {
          userId: String(user._id),
          handle: user.handle,
          createdAt: new Date().toISOString(),
        },
      })

      accountId = account.id
      user.stripeAccountId = accountId
      await user.save()

      console.log(`[CONNECT] Conta Express criada: ${accountId} para ${user._id}`)
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
      expiresAt: accountLink.expires_at,
    })
  } catch (err) {
    console.error('[CONNECT] Erro ao criar onboarding:', err.message)
    res.status(500).json({ error: 'Erro ao iniciar cadastro financeiro' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/connect/status
//
// Retorna o status REAL da conta Connect (consultando o Stripe).
// Usado pelo frontend para decidir se libera o botão "Criar Grupo Pago" /
// "Oferecer Viagem".
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('stripeAccountId stripeOnboardingDone chargesEnabled payoutsEnabled')
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })

    if (!user.stripeAccountId) {
      return res.json({
        status: 'not_started',
        onboardingDone: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        canCreatePaidGroup: false,
        canOfferRide: false,
      })
    }

    // Verificar status diretamente no Stripe (fonte da verdade)
    const account = await stripe.accounts.retrieve(user.stripeAccountId)

    const onboardingDone = !!(account.details_submitted && account.charges_enabled)
    const chargesEnabled = !!account.charges_enabled
    const payoutsEnabled = !!account.payouts_enabled

    // Atualizar flags no banco se mudaram (cache local)
    if (
      onboardingDone !== user.stripeOnboardingDone ||
      chargesEnabled !== user.chargesEnabled ||
      payoutsEnabled !== user.payoutsEnabled
    ) {
      user.stripeOnboardingDone = onboardingDone
      user.chargesEnabled       = chargesEnabled
      user.payoutsEnabled       = payoutsEnabled
      await user.save()
    }

    res.json({
      status: onboardingDone ? 'active' : (account.details_submitted ? 'pending' : 'not_started'),
      onboardingDone,
      chargesEnabled,
      payoutsEnabled,
      // Pode criar grupo pago / oferecer viagem?
      canCreatePaidGroup: onboardingDone && chargesEnabled,
      canOfferRide:       onboardingDone && chargesEnabled,
      accountId: user.stripeAccountId,
      requirements: account.requirements?.currently_due || [],
      pastDueRequirements: account.requirements?.past_due || [],
      disabledReason: account.requirements?.disabled_reason || null,
    })
  } catch (err) {
    if (err.code === 'resource_missing') {
      // Conta foi deletada no Stripe — limpar no banco
      await User.findByIdAndUpdate(req.user.id, {
        stripeAccountId: null,
        stripeOnboardingDone: false,
        stripeOnboarded: false,
        chargesEnabled: false,
        payoutsEnabled: false,
      })
      return res.json({
        status: 'not_started',
        onboardingDone: false,
        canCreatePaidGroup: false,
        canOfferRide: false,
      })
    }
    console.error('[CONNECT] Erro ao verificar status:', err.message)
    res.status(500).json({ error: 'Erro ao verificar conta financeira' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/connect/dashboard
// Link de login para o painel Express do Stripe (gerenciar dados bancários).
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/dashboard', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('stripeAccountId stripeOnboardingDone')
    if (!user?.stripeAccountId || !user.stripeOnboardingDone) {
      return res.status(400).json({
        error: 'Cadastro financeiro ainda não concluído',
        code: 'ONBOARDING_REQUIRED',
      })
    }

    const loginLink = await stripe.accounts.createLoginLink(user.stripeAccountId)
    res.json({ url: loginLink.url })
  } catch (err) {
    console.error('[CONNECT] Erro ao gerar link do painel:', err.message)
    res.status(500).json({ error: 'Erro ao acessar painel financeiro' })
  }
})

module.exports = router
