const mongoose = require('mongoose')

const PassengerSchema = new mongoose.Schema({
  user:             { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:             { type: String, required: true },
  handle:           { type: String, default: '' },
  // ─── Status de pagamento do passageiro ────────────────────────────────────
  // reserved   = legado
  // authorized = PaymentIntent autorizado, aguardando captura (escrow)
  // paid       = legado / pagamentos imediatos
  // confirmed  = código validado, pagamento capturado e repassado
  // cancelled  = reserva cancelada (estorno via Stripe)
  // no_show    = passageiro não embarcou — captura parcial
  // unvalidated= token expirou sem validação — split 46/46/8
  status: {
    type: String,
    enum: ['reserved', 'authorized', 'paid', 'confirmed', 'cancelled', 'no_show', 'unvalidated'],
    default: 'reserved',
  },
  capturedAt:       { type: Date, default: null },
  paidAmount:       { type: Number, default: 0 },          // centavos
  isMember:         { type: Boolean, default: false },
  confirmedAt:      { type: Date, default: null },
  reservedAt:       { type: Date, default: Date.now },

  // ─── Volta condicional ───────────────────────────────────────────────────
  returnApproved:    { type: Boolean, default: null },
  returnNote:        { type: String, default: '' },
  returnEvaluatedAt: { type: Date, default: null },

  // ─── Código de validação ──────────────────────────────────────────────────
  // validationCode  : 4-letter token (legado, "TM-XXXX")
  // paymentToken    : NOVO — bcrypt hash do código de 6 dígitos numéricos
  //                  (nunca armazenamos o código bruto)
  validationCode:    { type: String, default: '' },
  paymentToken:      { type: String, default: '' },         // bcrypt hash
  paymentIntentId:   { type: String, default: '' },

  // ─── Snapshots financeiros (imutáveis após reserva) ───────────────────────
  escrowAmount:      { type: Number, default: 0 },          // valor preso (centavos)
  platformFee:       { type: Number, default: 0 },          // 8% calculado na reserva
  tokenExpiresAt:    { type: Date, default: null },         // game.date + 24h
  cancellationDeadline: { type: Date, default: null },      // departureTime - 2h

  // ─── Idempotência do cron ─────────────────────────────────────────────────
  processadoEm:      { type: Date, default: null },         // null até processado
})

const RideSchema = new mongoose.Schema({
  // ─── Motorista ──────────────────────────────────
  driver:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driverName:     { type: String, required: true },
  driverHandle:   { type: String, default: '' },
  driverStripeAccountId: { type: String, default: '' }, // snapshot — segurança contra troca

  // ─── Grupo (opcional — caravanas de líderes) ────
  group:          { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
  groupName:      { type: String, default: '' },

  // ─── Jogo vinculado ─────────────────────────────
  game: {
    homeTeam:     { type: String, required: true },
    awayTeam:     { type: String, required: true },
    date:         { type: Date, required: true },
    stadium:      { type: String, required: true },
  },

  // ─── Veículo ────────────────────────────────────
  vehicle:        { type: String, enum: ['carro', 'van', 'onibus'], required: true },
  totalSeats:     { type: Number, required: true, min: 1, max: 50 },

  // ─── Preço ──────────────────────────────────────
  price:          { type: Number, required: true, min: 0 },
  memberPrice:    { type: Number, default: null },

  // ─── Logística ──────────────────────────────────
  meetPoint:      { type: String, required: true },
  meetCoords: {
    lat:          { type: Number, default: null },
    lng:          { type: Number, default: null },
  },
  departureTime:  { type: Date, required: true },
  bairro:         { type: String, default: '' },
  zona:           { type: String, default: '' },

  // ─── Passageiros ────────────────────────────────
  passengers:     [PassengerSchema],

  // ─── Status da viagem ───────────────────────────
  status: {
    type: String,
    enum: ['open', 'full', 'in_progress', 'completed', 'cancelled'],
    default: 'open',
  },
  driverConfirmed:   { type: Boolean, default: false },
  driverConfirmedAt: { type: Date, default: null },

  // ─── Financeiro ─────────────────────────────────
  escrowTotal:    { type: Number, default: 0 },
  releasedTotal:  { type: Number, default: 0 },
  appCommission:  { type: Number, default: 0 },

  // 🆔 Código compartilhável (ex: V-48273)
  shareCode:      { type: String, unique: true, sparse: true },

  // 🗑️ TTL — exclusão automática 7 dias após o jogo
  expiresAt:      { type: Date, default: null },

}, { timestamps: true })

// ─── Virtuals ─────────────────────────────────────
RideSchema.virtual('availableSeats').get(function () {
  const active = this.passengers.filter(
    p => !['cancelled', 'no_show', 'unvalidated'].includes(p.status)
  ).length
  return this.totalSeats - active
})

RideSchema.virtual('isCaravan').get(function () {
  return this.vehicle === 'van' || this.vehicle === 'onibus'
})

RideSchema.set('toJSON',   { virtuals: true })
RideSchema.set('toObject', { virtuals: true })

// ─── Índices ──────────────────────────────────────
RideSchema.index({ 'game.date': 1, status: 1 })
RideSchema.index({ driver: 1 })
RideSchema.index({ zona: 1, bairro: 1 })
RideSchema.index({ shareCode: 1 })

// 🔎 Cron de tokens expirados — query principal
RideSchema.index({ 'passengers.status': 1, 'passengers.tokenExpiresAt': 1 })

// 🗑️ TTL index
RideSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

// 🆔 + 🗑️ Pre-save: gerar shareCode + calcular expiresAt
RideSchema.pre('save', async function (next) {
  if (!this.shareCode) {
    const Ride = mongoose.model('Ride')
    let code, exists = true
    while (exists) {
      const num = String(Math.floor(10000 + Math.random() * 90000))
      code = `V-${num}`
      exists = await Ride.findOne({ shareCode: code }).lean()
    }
    this.shareCode = code
  }
  if (this.game?.date && !this.expiresAt) {
    this.expiresAt = new Date(new Date(this.game.date).getTime() + 7 * 24 * 60 * 60 * 1000)
  }
  next()
})

module.exports = mongoose.model('Ride', RideSchema)
