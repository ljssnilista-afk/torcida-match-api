const mongoose = require('mongoose')

const MessageSchema = new mongoose.Schema({
  grupo:      { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  sender:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String, required: true },
  text:       { type: String, required: true, maxlength: 1000 },
  type:       { type: String, enum: ['text', 'system'], default: 'text' },
}, { timestamps: true })

module.exports = mongoose.model('Message', MessageSchema)
