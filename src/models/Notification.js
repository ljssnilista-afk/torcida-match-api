const mongoose = require('mongoose')

const NotificationSchema = new mongoose.Schema({
  // Quem recebe a notificação
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Tipo e conteúdo
  type:       { type: String, enum: [
    'group_join_request',     // alguém quer entrar no seu grupo
    'group_approved',         // líder aprovou sua entrada
    'group_rejected',         // líder rejeitou sua entrada
    'group_payment_pending',  // aprovado, precisa pagar
    'ride_invite',            // convite para viagem
    'ride_confirmed',         // viagem confirmada
    'ride_cancelled',         // viagem cancelada
    'general',                // notificação genérica
  ], required: true },

  title:      { type: String, required: true },
  message:    { type: String, required: true },
  read:       { type: Boolean, default: false },

  // Referências opcionais para navegação
  group:      { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
  ride:       { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },
  fromUser:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  fromName:   { type: String, default: '' },

}, { timestamps: true })

// Índice para buscar notificações não lidas rapidamente
NotificationSchema.index({ user: 1, read: 1, createdAt: -1 })

module.exports = mongoose.model('Notification', NotificationSchema)
