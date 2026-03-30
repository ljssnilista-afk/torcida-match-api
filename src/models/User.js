const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')

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

    memberSince: { type: Date, default: Date.now },
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
