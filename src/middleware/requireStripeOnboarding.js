const User = require('../models/User')

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Middleware: requireStripeOnboarding
 *
 * Bloqueia a criação de grupos pagos e viagens caso o usuário ainda não tenha
 * concluído o onboarding da Connected Account no Stripe.
 *
 * Regra (TorcidaMATCH_Financeiro_Stripe — seção 3 e tabela após 4):
 *   - Motorista só pode criar viagem com pagamento se stripeOnboardingDone = true
 *   - Líder só pode ativar mensalidade se stripeOnboardingDone = true
 *
 * Uso:
 *   router.post('/', auth, requireStripeOnboarding, handler)
 *
 * Se usar `requireStripeOnboarding({ optional: true })` o middleware só
 * bloqueia se o usuário tentou ativar pagamento (ex: viagem com price > 0
 * ou grupo privado com mensalidade).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
function requireStripeOnboarding(opts = {}) {
  return async function (req, res, next) {
    try {
      // Se o middleware "auth" já carregou req.user, reutilizar — caso contrário, buscar
      let user = req.user
      if (!user || !('stripeOnboardingDone' in user)) {
        user = await User.findById(req.user.id).select(
          'stripeAccountId stripeOnboardingDone chargesEnabled accountUnderReview suspendedUntil'
        )
      }

      if (!user) return res.status(401).json({ error: 'Usuário não encontrado' })

      // Conta sob revisão / suspensa
      if (user.accountUnderReview) {
        return res.status(403).json({
          error: 'Sua conta está sob revisão. Entre em contato com o suporte.',
          code: 'ACCOUNT_UNDER_REVIEW',
        })
      }
      if (user.suspendedUntil && user.suspendedUntil > new Date()) {
        return res.status(403).json({
          error: `Sua conta está suspensa até ${user.suspendedUntil.toLocaleDateString('pt-BR')}.`,
          code: 'ACCOUNT_SUSPENDED',
          suspendedUntil: user.suspendedUntil,
        })
      }

      // Onboarding incompleto?
      const onboarded = !!(user.stripeAccountId && user.stripeOnboardingDone && user.chargesEnabled)

      if (!onboarded) {
        return res.status(403).json({
          error: 'Para criar grupos pagos ou oferecer viagens você precisa completar o cadastro financeiro.',
          code: 'ONBOARDING_REQUIRED',
          action: 'POST /api/connect/onboard',
          hasAccount: !!user.stripeAccountId,
          chargesEnabled: !!user.chargesEnabled,
        })
      }

      // OK → seguir
      next()
    } catch (err) {
      console.error('[requireStripeOnboarding]', err.message)
      res.status(500).json({ error: 'Erro ao verificar cadastro financeiro' })
    }
  }
}

// Export como função direta E como factory
module.exports = requireStripeOnboarding()
module.exports.factory = requireStripeOnboarding
