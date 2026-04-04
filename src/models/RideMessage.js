const mongoose = require('mongoose')

const RideMessageSchema = new mongoose.Schema({
  ride:       { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true, index: true },
  sender:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String, required: true },
  text:       { type: String, required: true, maxlength: 1000 },
  type:       { type: String, enum: ['text', 'system'], default: 'text' },

  // 🗑️ TTL — excluída junto com a viagem (7 dias após o jogo)
  expiresAt:  { type: Date, default: null },
}, { timestamps: true })

// 🗑️ TTL index — exclusão automática
RideMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

module.exports = mongoose.model('RideMessage', RideMessageSchema)
