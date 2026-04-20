const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')

const RideHistorySchema = new mongoose.Schema({
  rideId:      { type: mongoose.Schema.Types.ObjectId },
  homeTeam:    { type: String },
  awayTeam:    { type: String },
  gameDate:    { type: Date },
  role:        { type: String, enum: ['motorista', 'passageiro'] },
  vehicle:     { type: String },
  paidAmount:  { type: Number, default: 0 },   // centavos
  earned:      { type: Number, default: 0 },    // centavos (só motorista)
  rating:      { type: Number, default: null },
  completedAt: { type: Date, default: Date.now },
}, { _id: false })

const userSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    age:      { type: Number, required: true, min: 13, max: 100 },
    bairro:   { type: String, required: true, trim: true },
    zona:     { type: String, required: true, trim: true },
    handle:   { type: String, required: true, unique: true, trim: true, lowercase: true },
    email:    { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true, minlength: 6 },

    // Time do coração
    team:      { type: String, default: '' },
    teamId:    { type: String, default: '' },
    teamEmoji: { type: String, default: '' },

    // Foto de perfil (base64 JPEG, max ~5MB)
    photo: { type: String, default: null },

    // Stats (atualizadas pelo backend futuramente)
    grupos:             { type: Number, default: 0 },
    caronasOferecidas:  { type: Number, default: 0 },
    caronasPegadas:     { type: Number, default: 0 },
    avaliacaoMedia:     { type: Number, default: null },

    // 🗑️ NOVO — histórico permanente de viagens (sobrevive à exclusão TTL)
    rideHistory:        [RideHistorySchema],

    memberSince: { type: Date, default: Date.now },

    // ─── Stripe Connect (motoristas e líderes) ─────────────────────────────────
    stripeAccountId:      { type: String, default: null },   // ID da conta Express no Stripe
    stripeOnboardingDone: { type: Boolean, default: false }, // onboarding concluído?

    // ─── Carteira digital (apenas líderes) ────────────────────────────────────
    walletBalance: { type: Number, default: 0 }, // saldo em centavos

    // ─── Chave PIX (solicitada no saque, armazenada criptografada) ────────────
    pixKey:     { type: String, default: null },
    pixKeyType: { type: String, enum: ['cpf', 'email', 'phone', 'random', null], default: null },
  },
  { timestamps: true }
)

// Hash da senha antes de salvar
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  const salt = await bcrypt.genSalt(10)
  this.password = await bcrypt.hash(this.password, salt)
  next()
})

// Método para comparar senha
userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password)
}

// Nunca retornar a senha
userSchema.methods.toPublicJSON = function () {
  const obj = this.toObject()
  delete obj.password
  delete obj.__v
  return obj
}

module.exports = mongoose.model('User', userSchema)
