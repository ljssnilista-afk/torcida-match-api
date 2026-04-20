const mongoose = require('mongoose')

// ═══════════════════════════════════════════════════════════════════════════════
// Transaction — Registro imutável de toda movimentação financeira no app.
// Serve para histórico, auditoria e detecção de fraude.
// ═══════════════════════════════════════════════════════════════════════════════
const TransactionSchema = new mongoose.Schema({
  // Usuário que gerou a transação
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Tipo da transação
  type: {
    type: String,
    enum: ['deposit', 'payment', 'refund', 'withdraw', 'commission', 'transfer'],
    required: true,
  },

  // Valor em centavos (sempre positivo; o tipo define direção)
  amount: { type: Number, required: true, min: 0 },

  // Status atual
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'pending',
  },

  // Descrição legível
  description: { type: String, default: '' },

  // Referência ao recurso relacionado (viagem ou grupo)
  relatedId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  relatedType: { type: String, enum: ['ride', 'group', null], default: null },

  // IDs Stripe para rastreabilidade
  stripePaymentIntentId: { type: String, default: null },
  stripeTransferId:      { type: String, default: null },
  stripePayoutId:        { type: String, default: null },

  // Comissão do app retida nesta transação (centavos)
  appCommission: { type: Number, default: 0 },
}, { timestamps: true })

// ─── Índices para queries comuns ────────────────────────────────────────────
TransactionSchema.index({ userId: 1, createdAt: -1 })
TransactionSchema.index({ stripePaymentIntentId: 1 })
TransactionSchema.index({ status: 1 })

module.exports = mongoose.model('Transaction', TransactionSchema)
