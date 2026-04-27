const mongoose = require('mongoose')

// ═══════════════════════════════════════════════════════════════════════════════
// Transaction — Log IMUTÁVEL de toda movimentação financeira no app.
//
// Regra de ouro (TorcidaMATCH_Financeiro_Stripe):
//   - Transações são IMUTÁVEIS. Nunca edite um registro existente.
//   - Para estornos/correções, crie SEMPRE uma nova transação de reversão
//     com direction: credit e status: reversed.
//   - Isso garante trilha de auditoria completa.
//
// Tipos (alinhados com o documento de arquitetura):
//   deposit             — depósito genérico
//   group_subscription  — passageiro/membro pagou mensalidade
//   group_earning       — líder recebeu repasse de mensalidade (80%)
//   ride_reserve        — passageiro reservou (autorização escrow)
//   ride_earn           — motorista recebeu repasse (92% / 72% / 46%)
//   ride_refund         — passageiro foi reembolsado
//   ride_partial        — captura parcial (multa)
//   platform_fee        — comissão retida pela plataforma
//   payout              — saque para conta bancária
//   chargeback          — disputa aberta
// ═══════════════════════════════════════════════════════════════════════════════
const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Tipo da transação (compatível com legado + novos tipos do doc)
  type: {
    type: String,
    enum: [
      // Legado — manter retro-compat
      'deposit', 'payment', 'refund', 'withdraw', 'commission', 'transfer',
      // Novos (doc oficial)
      'group_subscription', 'group_earning',
      'ride_reserve', 'ride_earn', 'ride_refund', 'ride_partial',
      'platform_fee', 'payout', 'chargeback',
    ],
    required: true,
  },

  // Direção contábil — ajuda a separar entrada/saída na exibição
  direction: {
    type: String,
    enum: ['credit', 'debit'],
    default: 'credit',
  },

  amount: { type: Number, required: true, min: 0 }, // sempre positivo, em centavos

  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded', 'reversed'],
    default: 'pending',
  },

  description: { type: String, default: '' },

  // Referência ao recurso relacionado (viagem ou grupo)
  relatedId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  relatedType: { type: String, enum: ['ride', 'group', null], default: null },

  // IDs Stripe para rastreabilidade — NUNCA editar após criar
  stripePaymentIntentId: { type: String, default: null, index: true },
  stripeTransferId:      { type: String, default: null },
  stripePayoutId:        { type: String, default: null },
  stripeChargeId:        { type: String, default: null },
  stripeRefundId:        { type: String, default: null },
  stripeSubscriptionId:  { type: String, default: null },
  stripeInvoiceId:       { type: String, default: null },

  appCommission: { type: Number, default: 0 }, // centavos
}, { timestamps: true })

TransactionSchema.index({ userId: 1, createdAt: -1 })
TransactionSchema.index({ stripePaymentIntentId: 1, type: 1 })
TransactionSchema.index({ status: 1 })
TransactionSchema.index({ relatedId: 1, relatedType: 1 })

// 🔒 Bloquear updates após salvar (regra de ouro: imutável)
TransactionSchema.pre('save', function (next) {
  if (!this.isNew) {
    // Permitir apenas mudança de status para failed/reversed (nunca outros campos)
    const allowedFields = ['status']
    const changed = this.modifiedPaths()
    const blocked = changed.filter(f => !allowedFields.includes(f))
    if (blocked.length > 0) {
      return next(new Error(`Transaction is immutable. Blocked changes: ${blocked.join(', ')}`))
    }
  }
  next()
})

module.exports = mongoose.model('Transaction', TransactionSchema)
