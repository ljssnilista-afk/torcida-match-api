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

    // 🗑️ Histórico permanente de viagens (sobrevive à exclusão TTL)
    rideHistory:        [RideHistorySchema],

    memberSince: { type: Date, default: Date.now },

    // ═══════════════════════════════════════════════════════════════════════════
    // STRIPE — Arquitetura Financeira (alinhada com TorcidaMATCH_Financeiro_Stripe)
    // ═══════════════════════════════════════════════════════════════════════════

    // ─── Connected Account (Express) — motoristas e líderes recebem aqui ──────
    stripeAccountId:      { type: String, default: null, index: true },
    stripeOnboardingDone: { type: Boolean, default: false },
    // alias semântico exigido pelo doc — espelha stripeOnboardingDone
    stripeOnboarded:      { type: Boolean, default: false, index: true },
    // capacidades reais conforme Stripe (atualizadas via webhook)
    chargesEnabled:       { type: Boolean, default: false },
    payoutsEnabled:       { type: Boolean, default: false },

    // ─── Customer (passageiro/membro paga com cartão salvo) ───────────────────
    stripeCustomerId: { type: String, default: null, index: true },

    // ─── Sistema de Penalidades / Score de Confiabilidade ─────────────────────
    // Score público inicial = 100 (decai/aumenta conforme histórico)
    score:             { type: Number, default: 100, min: 0, max: 200 },
    cancelamentos:     { type: Number, default: 0 }, // contador acumulado
    cancelamentosRecentes: [{
      at:       { type: Date, default: Date.now },
      role:     { type: String, enum: ['driver', 'passenger'] },
      severity: { type: String, enum: ['warning', 'late', 'sameday', 'noshow'] },
      rideId:   { type: mongoose.Schema.Types.ObjectId },
    }],
    noShows:           { type: Number, default: 0 },
    suspendedUntil:    { type: Date, default: null },     // bloqueio temporário
    suspensionReason:  { type: String, default: '' },
    accountUnderReview:{ type: Boolean, default: false }, // chargeback / 5+ cancels

    // ─── Carteira (legado — espelho real fica no Stripe; manter saldo p/ retro-compat) ─
    walletBalance: { type: Number, default: 0 }, // centavos — apenas legado/MVP

    // ─── Chave PIX (retro-compat) — produção real usa external_account no Stripe ─
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

// Manter stripeOnboarded em sincronia com stripeOnboardingDone
userSchema.pre('save', function (next) {
  if (this.isModified('stripeOnboardingDone')) {
    this.stripeOnboarded = this.stripeOnboardingDone
  }
  if (this.isModified('stripeOnboarded') && !this.isModified('stripeOnboardingDone')) {
    this.stripeOnboardingDone = this.stripeOnboarded
  }
  next()
})

// Método para comparar senha
userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password)
}

// Helper: usuário pode receber pagamentos? (motorista/líder)
userSchema.methods.canReceivePayments = function () {
  return !!(this.stripeAccountId && this.stripeOnboardingDone && this.chargesEnabled)
}

// Helper: usuário está suspenso?
userSchema.methods.isSuspended = function () {
  return this.suspendedUntil && this.suspendedUntil > new Date()
}

// Nunca retornar a senha
userSchema.methods.toPublicJSON = function () {
  const obj = this.toObject()
  delete obj.password
  delete obj.__v
  return obj
}

module.exports = mongoose.model('User', userSchema)
