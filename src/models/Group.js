const mongoose = require('mongoose')

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
  members:          [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  maxMembers:       { type: Number, default: 100 },
}, { timestamps: true })

// Índice para evitar duplicidade de nome+time+bairro
GroupSchema.index({ name: 1, team: 1, bairro: 1 }, { unique: true })

module.exports = mongoose.model('Group', GroupSchema)
