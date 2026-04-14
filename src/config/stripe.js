/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Stripe Config — Seleção automática de chaves test/live por ambiente
 *
 * Regra:
 *   - NODE_ENV === 'production' → usa chaves LIVE (STRIPE_LIVE_*)
 *   - Qualquer outro ambiente    → usa chaves TEST (STRIPE_*)
 *
 * Você também pode forçar o modo via STRIPE_MODE=live ou STRIPE_MODE=test
 * (útil para testar em staging com chaves live, ou em produção com test).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

function resolveMode() {
  // Forçar via STRIPE_MODE tem prioridade máxima
  const forced = (process.env.STRIPE_MODE || '').toLowerCase()
  if (forced === 'live' || forced === 'test') return forced

  // Caso contrário, deduzir por NODE_ENV
  return process.env.NODE_ENV === 'production' ? 'live' : 'test'
}

const mode = resolveMode()

// ─── Selecionar chaves conforme o modo ──────────────────────────────────────
const secretKey = mode === 'live'
  ? process.env.STRIPE_LIVE_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY

const publishableKey = mode === 'live'
  ? process.env.STRIPE_LIVE_PUBLISHABLE_KEY
  : process.env.STRIPE_PUBLISHABLE_KEY

// Webhook secret: usa LIVE variant se existir quando estiver em modo live,
// senão cai no STRIPE_WEBHOOK_SECRET padrão.
const webhookSecret = mode === 'live' && process.env.STRIPE_LIVE_WEBHOOK_SECRET
  ? process.env.STRIPE_LIVE_WEBHOOK_SECRET
  : process.env.STRIPE_WEBHOOK_SECRET

// ─── Validação de consistência (warnings em dev, fatal em produção) ─────────
function validateKeys() {
  const issues = []

  if (!secretKey) {
    issues.push(`STRIPE_${mode === 'live' ? 'LIVE_' : ''}SECRET_KEY ausente`)
  } else {
    const expectedPrefix = mode === 'live' ? 'sk_live_' : 'sk_test_'
    if (!secretKey.startsWith(expectedPrefix)) {
      issues.push(`Secret key não tem prefixo esperado (${expectedPrefix})`)
    }
  }

  if (!publishableKey) {
    issues.push(`STRIPE_${mode === 'live' ? 'LIVE_' : ''}PUBLISHABLE_KEY ausente`)
  } else {
    const expectedPrefix = mode === 'live' ? 'pk_live_' : 'pk_test_'
    if (!publishableKey.startsWith(expectedPrefix)) {
      issues.push(`Publishable key não tem prefixo esperado (${expectedPrefix})`)
    }
  }

  if (!webhookSecret) {
    issues.push('STRIPE_WEBHOOK_SECRET ausente')
  }

  if (issues.length > 0) {
    const msg = `[STRIPE CONFIG] Problemas no modo "${mode}": ${issues.join(', ')}`
    if (process.env.NODE_ENV === 'production') {
      // Em produção, falhar rápido
      throw new Error(msg)
    } else {
      console.warn(msg)
    }
  } else {
    console.log(`[STRIPE CONFIG] Modo: ${mode.toUpperCase()} ✓`)
  }
}

// Validar na inicialização (mas não quebrar os testes com mock)
if (process.env.NODE_ENV !== 'test') {
  validateKeys()
}

// ─── Cliente Stripe pré-configurado ──────────────────────────────────────────
const stripe = require('stripe')(secretKey)

module.exports = {
  stripe,
  mode,
  secretKey,
  publishableKey,
  webhookSecret,
  isLive: mode === 'live',
  isTest: mode === 'test',
}
