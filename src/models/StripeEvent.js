const mongoose = require('mongoose')

// Modelo para idempotência de webhooks Stripe
// Armazena o ID de cada evento processado para evitar processamento duplicado
const StripeEventSchema = new mongoose.Schema({
  eventId:     { type: String, required: true, unique: true, index: true },
  type:        { type: String, required: true },
  processedAt: { type: Date, default: Date.now },
  data:        { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true })

// TTL: limpar eventos processados após 30 dias
StripeEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 })

module.exports = mongoose.model('StripeEvent', StripeEventSchema)
