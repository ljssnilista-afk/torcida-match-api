const mongoose = require('mongoose')

const PendingMemberSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:     { type: String, default: '' },
  handle:   { type: String, default: '' },
  status:   { type: String, enum: ['pendingApproval', 'pendingPayment'], required: true },
  requestedAt: { type: Date, default: Date.now },
  // Stripe — referências da cobrança em curso
  stripePaymentIntentId: { type: String, default: '' },
  stripeSubscriptionId:  { type: String, default: '' },
}, { _id: false })

const ActiveSubscriptionSchema = new mongoose.Schema({
  user:                 { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  stripeSubscriptionId: { type: String, required: true },
  status:               { type: String, default: 'active' }, // active | past_due | canceled
  currentPeriodEnd:     { type: Date, default: null },
  startedAt:            { type: Date, default: Date.now },
  failedAttempts:       { type: Number, default: 0 },
}, { _id: false })

const GroupSchema = new mongoose.Schema({
  name:             { type: String, required: true, trim: true, minlength: 3, maxlength: 50 },
  team:             { type: String, required: true },
  bairro:           { type: String, required: true },
  zona:             { type: String, required: true },
  description:      { type: String, default: '', maxlength: 140 },
  meetPoint:        { type: String, required: true },
  privacy:          { type: String, enum: ['public','private'], default: 'public' },
  approvalRequired: { type: Boolean, default: false },
  leader:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // snapshot do stripeAccountId do líder no momento da criação
  leaderStripeAccountId: { type: String, default: '' },

  members:          [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  pendingMembers:   [PendingMemberSchema],
  // Assinaturas ativas (recorrência mensal)
  subscriptions:    [ActiveSubscriptionSchema],

  maxMembers:       { type: Number, default: 100 },

  // ═══════════════════════════════════════════════════════════════════════════
  // STRIPE — Mensalidade via Subscriptions (Recorrência automática)
  // ═══════════════════════════════════════════════════════════════════════════
  // membershipFee em centavos. 0 = grupo gratuito (sem subscription).
  membershipFee:    { type: Number, default: 0, min: 0 },
  // isPago é derivado, mas armazenado como flag para queries rápidas
  isPago:           { type: Boolean, default: false, index: true },
  // Product e Price do Stripe — criados na primeira ativação de mensalidade
  stripeProductId:  { type: String, default: null },
  stripePriceId:    { type: String, default: null },

  groupType:        { type: String, enum: ['misto', 'organizada', 'familia', 'feminino', 'jovem'], default: 'misto' },

  photo:            { type: String, default: null },

  location: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },

  code:             { type: String, unique: true, sparse: true },

}, { timestamps: true })

GroupSchema.index({ name: 1, team: 1, bairro: 1 }, { unique: true })
GroupSchema.index({ leader: 1 })

GroupSchema.pre('save', async function (next) {
  // Derivar flag isPago
  this.isPago = (this.membershipFee || 0) > 0

  // Gerar code de 7 dígitos
  if (!this.code) {
    const Group = mongoose.model('Group')
    const last = await Group.findOne({ code: { $ne: null } }).sort({ code: -1 }).select('code').lean()
    const nextNum = last?.code ? parseInt(last.code) + 1 : 1
    this.code = String(nextNum).padStart(7, '0')
  }

  next()
})

module.exports = mongoose.model('Group', GroupSchema)
