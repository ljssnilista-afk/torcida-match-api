const mongoose = require('mongoose')

const PendingMemberSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:     { type: String, default: '' },
  handle:   { type: String, default: '' },
  status:   { type: String, enum: ['pendingApproval', 'pendingPayment'], required: true },
  requestedAt: { type: Date, default: Date.now },
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

  // Membros ativos (acesso total ao grupo)
  members:          [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Membros pendentes (aguardando aprovação ou pagamento)
  pendingMembers:   [PendingMemberSchema],

  maxMembers:       { type: Number, default: 100 },

  // 💰 Mensalidade (centavos, 0 = gratuito)
  membershipFee:    { type: Number, default: 0 },

  // 🏷️ Tipo/categoria do grupo
  groupType:        { type: String, enum: ['misto', 'organizada', 'familia', 'feminino', 'jovem'], default: 'misto' },

  // 📸 Foto do grupo (base64, max 800KB)
  photo:            { type: String, default: null },

  // 🆔 Código amigável de 7 dígitos (ex: 0000001)
  code:             { type: String, unique: true, sparse: true },

}, { timestamps: true })

// Índice para evitar duplicidade de nome+time+bairro
GroupSchema.index({ name: 1, team: 1, bairro: 1 }, { unique: true })

// 🆔 Gerar código sequencial de 7 dígitos antes de salvar
GroupSchema.pre('save', async function (next) {
  if (this.code) return next() // já tem código

  const Group = mongoose.model('Group')
  // Buscar o maior código existente
  const last = await Group.findOne({ code: { $ne: null } }).sort({ code: -1 }).select('code').lean()
  const nextNum = last?.code ? parseInt(last.code) + 1 : 1
  this.code = String(nextNum).padStart(7, '0')

  next()
})

module.exports = mongoose.model('Group', GroupSchema)
