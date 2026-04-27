const express = require('express')
const auth    = require('../middleware/auth')
const User    = require('../models/User')
const { stripe } = require('../config/stripe')

const router = express.Router()

const FRONTEND_URL = process.env.FRONTEND_URL
  || process.env.CLIENT_URL
  || 'https://torcidamatch.vercel.app'

// ═══════════════════════════════════════════════════════════════════════════════
// Stripe Connect API v2 — TorcidaMATCH
//
// Baseado no sample oficial da Stripe (Connect v2 / Accounts v2). Diferente do
// legado v1 (stripe.accounts.create + capabilities.transfers), a v2 usa:
//
//   stripe.v2.core.accounts.create({
//     dashboard: 'express',
//     defaults: { responsibilities: {
//       fees_collector: 'application',     // plataforma cobra fees
//       losses_collector: 'application',   // plataforma absorve chargebacks
//     }},
//     identity: { country: 'BR', entity_type: 'individual' },
//     configuration: { recipient: { capabilities: { stripe_balance: {
//       stripe_transfers: { requested: true },     // recebe transfers
//     }}}}
//   })
//
// Compatibilidade: se o SDK Stripe instalado NÃO expuser v2.core, caímos no
// fluxo v1 automaticamente — assim a migração não quebra deploys atuais.
// ═══════════════════════════════════════════════════════════════════════════════

const HAS_V2 = !!(stripe && stripe.v2 && stripe.v2.core && stripe.v2.core.accounts)

console.log(`[CONNECT] Modo: ${HAS_V2 ? 'V2 (Accounts v2)' : 'V1 (Legacy Express)'}`)

// ─── Helpers v2 ─────────────────────────────────────────────────────────────
async function createAccountV2(user) {
  return stripe.v2.core.accounts.create({
    display_name:  user.name,
    contact_email: user.email,
    dashboard:     'express',
    defaults: {
      responsibilities: {
        fees_collector:   'application',
        losses_collector: 'application',
      },
    },
    identity: {
      country: 'BR',
      entity_type: 'individual', // motoristas/líderes individuais
    },
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: {
            stripe_transfers: { requested: true },
          },
        },
      },
    },
    metadata: {
      userId: String(user._id),
      handle: user.handle,
      createdAt: new Date().toISOString(),
    },
  })
}

async function createAccountLinkV2(accountId) {
  return stripe.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['recipient'],
        refresh_url: `${FRONTEND_URL}/perfil?connect=refresh`,
        return_url:  `${FRONTEND_URL}/perfil?connect=success&accountId=${accountId}`,
      },
    },
  })
}

async function retrieveAccountV2(accountId) {
  return stripe.v2.core.accounts.retrieve(accountId, {
    include: ['requirements', 'configuration.recipient'],
  })
}

function parseV2Status(account) {
  const recipient = account.configuration?.recipient
  const balance   = recipient?.capabilities?.stripe_balance
  const chargesEnabled = balance?.stripe_transfers?.status === 'active'
  const payoutsEnabled = balance?.payouts?.status === 'active'
  const summaryStatus  = account.requirements?.summary?.minimum_deadline?.status
  const detailsSubmitted = !summaryStatus || summaryStatus === 'eventually_due'
  const onboardingDone = !!(detailsSubmitted && chargesEnabled)
  return {
    onboardingDone,
    chargesEnabled,
    payoutsEnabled,
    detailsSubmitted,
    requirements: account.requirements?.entries || [],
  }
}

// ─── Helpers v1 (fallback) ──────────────────────────────────────────────────
async function createAccountV1(user) {
  return stripe.accounts.create({
    type: 'express',
    country: 'BR',
    email: user.email,
    capabilities: { transfers: { requested: true } },
    business_type: 'individual',
    business_profile: {
      product_description: 'Caronas de torcedores e gestão de grupos via TorcidaMATCH',
      mcc: '4111',
      url: FRONTEND_URL,
    },
    metadata: {
      userId: String(user._id),
      handle: user.handle,
      createdAt: new Date().toISOString(),
    },
  })
}

async function createAccountLinkV1(accountId) {
  return stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${FRONTEND_URL}/perfil?connect=refresh`,
    return_url:  `${FRONTEND_URL}/perfil?connect=success`,
    type: 'account_onboarding',
  })
}

async function retrieveAccountV1(accountId) {
  return stripe.accounts.retrieve(accountId)
}

function parseV1Status(account) {
  const chargesEnabled = !!account.charges_enabled
  const payoutsEnabled = !!account.payouts_enabled
  const detailsSubmitted = !!account.details_submitted
  const onboardingDone = !!(detailsSubmitted && chargesEnabled)
  return {
    onboardingDone,
    chargesEnabled,
    payoutsEnabled,
    detailsSubmitted,
    requirements: account.requirements?.currently_due || [],
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/connect/onboard
// Cria/recupera Connected Account + accountLink (v2 ou v1 fallback)
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/onboard', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })

    if (user.accountUnderReview) {
      return res.status(403).json({
        error: 'Sua conta está sob revisão. Entre em contato com o suporte.',
        code: 'ACCOUNT_UNDER_REVIEW',
      })
    }

    let accountId = user.stripeAccountId

    // 1. Criar conta se não existir
    if (!accountId) {
      try {
        const account = HAS_V2
          ? await createAccountV2(user)
          : await createAccountV1(user)

        accountId = account.id
        user.stripeAccountId = accountId
        await user.save()

        console.log(`[CONNECT] Conta criada (${HAS_V2 ? 'v2' : 'v1'}): ${accountId} → ${user._id}`)
      } catch (stripeErr) {
        console.error('[CONNECT] account.create FAILED:')
        console.error('  type:    ', stripeErr.type)
        console.error('  code:    ', stripeErr.code)
        console.error('  param:   ', stripeErr.param)
        console.error('  message: ', stripeErr.message)
        console.error('  raw:     ', JSON.stringify(stripeErr.raw || {}, null, 2))
        return res.status(500).json({
          error: 'Erro ao criar conta no Stripe',
          stripeMessage: stripeErr.message,
          stripeCode: stripeErr.code,
          hint: stripeErr.code === 'account_country_invalid_address'
            ? 'País não habilitado no seu Stripe Connect'
            : stripeErr.message?.includes('signed up for Connect')
              ? 'Habilite o Stripe Connect no dashboard antes de criar contas'
              : undefined,
        })
      }
    }

    // 2. Gerar accountLink
    try {
      const accountLink = HAS_V2
        ? await createAccountLinkV2(accountId)
        : await createAccountLinkV1(accountId)

      return res.json({
        url: accountLink.url,
        accountId,
        expiresAt: accountLink.expires_at,
        apiVersion: HAS_V2 ? 'v2' : 'v1',
      })
    } catch (stripeErr) {
      console.error('[CONNECT] accountLinks.create FAILED:', stripeErr.message)
      return res.status(500).json({
        error: 'Erro ao gerar link de onboarding',
        stripeMessage: stripeErr.message,
      })
    }
  } catch (err) {
    console.error('[CONNECT] Erro inesperado:', err.message, err.stack)
    res.status(500).json({
      error: 'Erro ao iniciar cadastro financeiro',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/connect/status
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

    const account = HAS_V2
      ? await retrieveAccountV2(user.stripeAccountId)
      : await retrieveAccountV1(user.stripeAccountId)

    const status = HAS_V2 ? parseV2Status(account) : parseV1Status(account)

    if (
      status.onboardingDone !== user.stripeOnboardingDone ||
      status.chargesEnabled !== user.chargesEnabled ||
      status.payoutsEnabled !== user.payoutsEnabled
    ) {
      user.stripeOnboardingDone = status.onboardingDone
      user.chargesEnabled       = status.chargesEnabled
      user.payoutsEnabled       = status.payoutsEnabled
      await user.save()
    }

    res.json({
      status: status.onboardingDone ? 'active'
        : (status.detailsSubmitted ? 'pending' : 'not_started'),
      onboardingDone:     status.onboardingDone,
      chargesEnabled:     status.chargesEnabled,
      payoutsEnabled:     status.payoutsEnabled,
      canCreatePaidGroup: status.onboardingDone && status.chargesEnabled,
      canOfferRide:       status.onboardingDone && status.chargesEnabled,
      accountId: user.stripeAccountId,
      requirements: status.requirements,
      apiVersion: HAS_V2 ? 'v2' : 'v1',
    })
  } catch (err) {
    if (err.code === 'resource_missing' || err.statusCode === 404) {
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
// Login link para Express dashboard. v2: stripe.v2.core.accounts.createLoginLink
// caso disponível, senão v1 (stripe.accounts.createLoginLink).
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

    let loginLink
    if (HAS_V2 && stripe.v2.core.accounts.createLoginLink) {
      loginLink = await stripe.v2.core.accounts.createLoginLink(user.stripeAccountId)
    } else {
      loginLink = await stripe.accounts.createLoginLink(user.stripeAccountId)
    }
    res.json({ url: loginLink.url })
  } catch (err) {
    console.error('[CONNECT] Erro ao gerar link do painel:', err.message)
    res.status(500).json({ error: 'Erro ao acessar painel financeiro' })
  }
})

module.exports = router
      error: 'Erro ao gerar link de onboarding',
        stripeMessage: stripeErr.message,
      })
    }
  } catch (err) {
    console.error('[CONNECT] Erro inesperado:', err.message, err.stack)
    res.status(500).json({
      error: 'Erro ao iniciar cadastro financeiro',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/connect/status
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

    const account = HAS_V2
      ? await retrieveAccountV2(user.stripeAccountId)
      : await retrieveAccountV1(user.stripeAccountId)

    const status = HAS_V2 ? parseV2Status(account) : parseV1Status(account)

    if (
      status.onboardingDone !== user.stripeOnboardingDone ||
      status.chargesEnabled !== user.chargesEnabled ||
      status.payoutsEnabled !== user.payoutsEnabled
    ) {
      user.stripeOnboardingDone = status.onboardingDone
      user.chargesEnabled       = status.chargesEnabled
      user.payoutsEnabled       = status.payoutsEnabled
      await user.save()
    }

    res.json({
      status: status.onboardingDone ? 'active'
        : (status.detailsSubmitted ? 'pending' : 'not_started'),
      onboardingDone:     status.onboardingDone,
      chargesEnabled:     status.chargesEnabled,
      payoutsEnabled:     status.payoutsEnabled,
      canCreatePaidGroup: status.onboardingDone && status.chargesEnabled,
      canOfferRide:       status.onboardingDone && status.chargesEnabled,
      accountId: user.stripeAccountId,
      requirements: status.requirements,
      apiVersion: HAS_V2 ? 'v2' : 'v1',
    })
  } catch (err) {
    if (err.code === 'resource_missing' || err.statusCode === 404) {
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

    let loginLink
    if (HAS_V2 && stripe.v2.core.accounts.createLoginLink) {
      loginLink = await stripe.v2.core.accounts.createLoginLink(user.stripeAccountId)
    } else {
      loginLink = await stripe.accounts.createLoginLink(user.stripeAccountId)
    }
    res.json({ url: loginLink.url })
  } catch (err) {
    console.error('[CONNECT] Erro ao gerar link do painel:', err.message)
    res.status(500).json({ error: 'Erro ao acessar painel financeiro' })
  }
})

module.exports = router
ro ao gerar link do painel:', err.message)
    res.status(500).json({ error: 'Erro ao acessar painel financeiro' })
  }
})

module.exports = router
