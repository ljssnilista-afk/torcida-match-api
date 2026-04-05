const mongoose = require('mongoose')

const InviteSchema = new mongoose.Schema({
  // Tipo: grupo ou viagem
  type:        { type: String, enum: ['group', 'ride'], required: true },

  // Referência ao grupo ou viagem
  group:       { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
  ride:        { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },

  // Quem enviou o convite
  sender:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName:  { type: String, required: true },

  // Quem recebe (convite direto) — null se for convite por link
  recipient:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Método: link público ou direto para usuário
  method:      { type: String, enum: ['link', 'direct'], default: 'direct' },

  // Status
  status:      { type: String, enum: ['pending', 'accepted', 'rejected', 'expired'], default: 'pending' },

  // Metadata para exibição
  targetName:  { type: String, default: '' },  // nome do grupo ou "Jogo X vs Y"
  message:     { type: String, default: '', maxlength: 200 },

  expiresAt:   { type: Date, default: null },
}, { timestamps: true })

// Índices
InviteSchema.index({ recipient: 1, status: 1 })
InviteSchema.index({ group: 1, recipient: 1 })
InviteSchema.index({ ride: 1, recipient: 1 })
InviteSchema.index({ sender: 1 })

module.exports = mongoose.model('Invite', InviteSchema)
