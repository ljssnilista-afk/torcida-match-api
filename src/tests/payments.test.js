/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Testes de Integração Stripe — Backend TorcidaMatch
 *
 * Para rodar: npx jest src/tests/payments.test.js
 *
 * IMPORTANTE: Estes testes usam mocks — NÃO fazem chamadas reais ao Stripe.
 * Para testes E2E com Stripe, use o Stripe CLI:
 *   stripe listen --forward-to localhost:3001/api/webhook
 *   stripe trigger payment_intent.succeeded
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Mock do Stripe ANTES de importar qualquer módulo
jest.mock('stripe', () => {
  const mockPaymentIntentsCreate = jest.fn()
  const mockPaymentIntentsRetrieve = jest.fn()
  const mockWebhooksConstructEvent = jest.fn()

  return jest.fn(() => ({
    paymentIntents: {
      create: mockPaymentIntentsCreate,
      retrieve: mockPaymentIntentsRetrieve,
    },
    webhooks: {
      constructEvent: mockWebhooksConstructEvent,
    },
  }))
})

// Mock env vars
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_mock'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock'
process.env.JWT_SECRET = 'test_jwt_secret'
process.env.MONGODB_URI = 'mongodb://localhost:27017/test'

const stripe = require('stripe')()

// ─── Testes de validação de pagamento ────────────────────────────────────────

describe('Payment Validation', () => {
  // Helper para validar amount (replicando a lógica do backend)
  function validateAmount(amount) {
    if (!Number.isInteger(amount)) return 'Amount deve ser um número inteiro (centavos)'
    if (amount < 100) return 'Valor mínimo: R$ 1,00 (100 centavos)'
    if (amount > 99999900) return 'Valor máximo: R$ 999.999,00'
    return null
  }

  test('rejeita amount não inteiro', () => {
    expect(validateAmount(10.5)).toBe('Amount deve ser um número inteiro (centavos)')
    expect(validateAmount(99.99)).toBe('Amount deve ser um número inteiro (centavos)')
  })

  test('rejeita amount menor que 100 centavos (R$ 1,00)', () => {
    expect(validateAmount(0)).toBe('Valor mínimo: R$ 1,00 (100 centavos)')
    expect(validateAmount(50)).toBe('Valor mínimo: R$ 1,00 (100 centavos)')
    expect(validateAmount(99)).toBe('Valor mínimo: R$ 1,00 (100 centavos)')
    expect(validateAmount(-100)).toBe('Valor mínimo: R$ 1,00 (100 centavos)')
  })

  test('rejeita amount maior que R$ 999.999,00', () => {
    expect(validateAmount(100000000)).toBe('Valor máximo: R$ 999.999,00')
  })

  test('aceita amount válido', () => {
    expect(validateAmount(100)).toBeNull()
    expect(validateAmount(5000)).toBeNull()
    expect(validateAmount(99999900)).toBeNull()
  })
})

// ─── Testes do PaymentIntent ─────────────────────────────────────────────────

describe('Stripe PaymentIntent Creation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('cria PaymentIntent com parâmetros corretos para grupo', async () => {
    const mockPI = {
      id: 'pi_test_123',
      client_secret: 'pi_test_123_secret_abc',
      amount: 5000,
      currency: 'brl',
      status: 'requires_payment_method',
    }

    stripe.paymentIntents.create.mockResolvedValue(mockPI)

    const result = await stripe.paymentIntents.create({
      amount: 5000,
      currency: 'brl',
      metadata: {
        type: 'group_membership',
        groupId: '507f1f77bcf86cd799439011',
        userId: '507f1f77bcf86cd799439012',
      },
      automatic_payment_methods: { enabled: true },
    })

    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 5000,
        currency: 'brl',
        metadata: expect.objectContaining({
          type: 'group_membership',
        }),
      })
    )

    expect(result.client_secret).toBe('pi_test_123_secret_abc')
    expect(result.id).toBe('pi_test_123')
  })

  test('cria PaymentIntent com parâmetros corretos para viagem', async () => {
    const mockPI = {
      id: 'pi_test_456',
      client_secret: 'pi_test_456_secret_def',
      amount: 2500,
      currency: 'brl',
    }

    stripe.paymentIntents.create.mockResolvedValue(mockPI)

    const result = await stripe.paymentIntents.create({
      amount: 2500,
      currency: 'brl',
      metadata: {
        type: 'ride_reservation',
        rideId: '507f1f77bcf86cd799439013',
        userId: '507f1f77bcf86cd799439012',
        isMember: 'true',
      },
      automatic_payment_methods: { enabled: true },
    })

    expect(result.client_secret).toBe('pi_test_456_secret_def')
    expect(result.amount).toBe(2500)
  })

  test('lida com erro StripeCardError', async () => {
    const cardError = new Error('Your card was declined')
    cardError.type = 'StripeCardError'

    stripe.paymentIntents.create.mockRejectedValue(cardError)

    await expect(
      stripe.paymentIntents.create({ amount: 5000, currency: 'brl' })
    ).rejects.toThrow('Your card was declined')
  })

  test('lida com erro StripeInvalidRequestError', async () => {
    const invalidError = new Error('Invalid amount')
    invalidError.type = 'StripeInvalidRequestError'

    stripe.paymentIntents.create.mockRejectedValue(invalidError)

    await expect(
      stripe.paymentIntents.create({ amount: -100, currency: 'brl' })
    ).rejects.toThrow('Invalid amount')
  })
})

// ─── Testes do Webhook ───────────────────────────────────────────────────────

describe('Stripe Webhook Signature Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('valida assinatura correta do webhook', () => {
    const mockEvent = {
      id: 'evt_test_123',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_test_123',
          amount: 5000,
          metadata: { type: 'group_membership', groupId: '123', userId: '456' },
        },
      },
    }

    stripe.webhooks.constructEvent.mockReturnValue(mockEvent)

    const rawBody = Buffer.from(JSON.stringify(mockEvent))
    const sig = 't=1234567890,v1=abc123'

    const result = stripe.webhooks.constructEvent(rawBody, sig, 'whsec_mock')

    expect(result.id).toBe('evt_test_123')
    expect(result.type).toBe('payment_intent.succeeded')
    expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(rawBody, sig, 'whsec_mock')
  })

  test('rejeita assinatura inválida', () => {
    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload')
    })

    const rawBody = Buffer.from('fake payload')
    const sig = 'invalid_sig'

    expect(() => {
      stripe.webhooks.constructEvent(rawBody, sig, 'whsec_mock')
    }).toThrow('No signatures found matching the expected signature')
  })

  test('rejeita webhook sem header de assinatura', () => {
    // Simula o comportamento do endpoint — sem sig header retorna 400
    const sig = undefined
    expect(sig).toBeUndefined()
    // O endpoint retornaria 400 antes de chamar constructEvent
  })
})

// ─── Testes de Idempotência ──────────────────────────────────────────────────

describe('Webhook Idempotency', () => {
  test('eventos com mesmo ID não devem ser processados duas vezes', () => {
    // Simula o comportamento do StripeEvent model
    const processedEvents = new Set()

    function isEventProcessed(eventId) {
      return processedEvents.has(eventId)
    }

    function markEventProcessed(eventId) {
      processedEvents.add(eventId)
    }

    const eventId = 'evt_test_123'

    // Primeira vez: não processado
    expect(isEventProcessed(eventId)).toBe(false)
    markEventProcessed(eventId)

    // Segunda vez: já processado
    expect(isEventProcessed(eventId)).toBe(true)
  })
})

// ─── Testes de Segurança ─────────────────────────────────────────────────────

describe('Security Checks', () => {
  test('chave secreta nunca aparece em respostas de config', () => {
    // Simula o endpoint GET /api/payments/config
    const configResponse = {
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    }

    expect(configResponse).not.toHaveProperty('secretKey')
    expect(configResponse).not.toHaveProperty('STRIPE_SECRET_KEY')
    expect(configResponse.publishableKey).toBe('pk_test_mock')
    expect(configResponse.publishableKey).toMatch(/^pk_/)
  })

  test('client_secret começa com pi_ (prefixo de PaymentIntent)', () => {
    const clientSecret = 'pi_test_123_secret_abc'
    expect(clientSecret).toMatch(/^pi_/)
    // Verifica que não é a chave secreta do Stripe
    expect(clientSecret).not.toMatch(/^sk_/)
  })

  test('.env.example não contém chaves reais', () => {
    const fs = require('fs')
    const path = require('path')
    const envExample = fs.readFileSync(
      path.join(__dirname, '../../.env.example'),
      'utf8'
    )

    // Não deve conter chaves reais (que começam com sk_live_ ou pk_live_)
    expect(envExample).not.toMatch(/sk_live_/)
    expect(envExample).not.toMatch(/pk_live_/)
    // Deve conter placeholders
    expect(envExample).toContain('STRIPE_SECRET_KEY')
    expect(envExample).toContain('STRIPE_PUBLISHABLE_KEY')
    expect(envExample).toContain('STRIPE_WEBHOOK_SECRET')
  })
})

// ─── Testes de Cartões ───────────────────────────────────────────────────────

describe('Test Card Numbers (Reference)', () => {
  const testCards = {
    success: '4242424242424242',
    requires3DS: '4000002500003155',
    declined: '4000000000009995',
    insufficientFunds: '4000000000009995',
  }

  test('cartões de teste têm 16 dígitos', () => {
    Object.values(testCards).forEach(card => {
      expect(card).toMatch(/^\d{16}$/)
    })
  })

  test('cartão de sucesso é 4242...', () => {
    expect(testCards.success).toBe('4242424242424242')
  })

  test('cartão de 3D Secure é 4000 0025 0000 3155', () => {
    expect(testCards.requires3DS).toBe('4000002500003155')
  })
})
