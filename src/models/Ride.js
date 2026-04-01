const mongoose = require('mongoose')

const PassengerSchema = new mongoose.Schema({
  user:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:           { type: String, required: true },
  handle:         { type: String, default: '' },
  status:         { type: String, enum: ['reserved', 'paid', 'confirmed', 'cancelled'], default: 'reserved' },
  paidAmount:     { type: Number, default: 0 },         // quanto pagou (simulado)
  isMember:       { type: Boolean, default: false },     // era membro do grupo do motorista?
  confirmedAt:    { type: Date, default: null },         // quando o passageiro confirmou a viagem
  reservedAt:     { type: Date, default: Date.now },
})

const RideSchema = new mongoose.Schema({
  // ─── Motorista ──────────────────────────────────
  driver:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driverName:     { type: String, required: true },
  driverHandle:   { type: String, default: '' },

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
  price:          { type: Number, required: true, min: 0 },        // preço normal por vaga (centavos)
  memberPrice:    { type: Number, default: null },                  // preço para membros do grupo (centavos)

  // ─── Logística ──────────────────────────────────
  meetPoint:      { type: String, required: true },                 // ponto de encontro
  meetCoords: {
    lat:          { type: Number, default: null },
    lng:          { type: Number, default: null },
  },
  departureTime:  { type: Date, required: true },                   // horário de saída
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

  // ─── Financeiro (simulado) ──────────────────────
  escrowTotal:    { type: Number, default: 0 },          // total preso no app
  releasedTotal:  { type: Number, default: 0 },          // total liberado pro motorista
  appCommission:  { type: Number, default: 0 },          // 20% retido pelo app

}, { timestamps: true })

// ─── Virtuals ─────────────────────────────────────
RideSchema.virtual('availableSeats').get(function () {
  const active = this.passengers.filter(p => p.status !== 'cancelled').length
  return this.totalSeats - active
})

RideSchema.virtual('isCaravan').get(function () {
  return this.vehicle === 'van' || this.vehicle === 'onibus'
})

// Incluir virtuals no JSON
RideSchema.set('toJSON', { virtuals: true })
RideSchema.set('toObject', { virtuals: true })

// ─── Índices ──────────────────────────────────────
RideSchema.index({ 'game.date': 1, status: 1 })
RideSchema.index({ driver: 1 })
RideSchema.index({ zona: 1, bairro: 1 })

module.exports = mongoose.model('Ride', RideSchema)
