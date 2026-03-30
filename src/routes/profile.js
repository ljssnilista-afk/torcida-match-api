const express = require('express')
const User = require('../models/User')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

// ─── GET /api/profile/me ──────────────────────────────────────────────────────
// Retorna o perfil do usuário logado (requer token)
router.get('/me', authMiddleware, async (req, res) => {
  res.json({ user: req.user.toPublicJSON() })
})

// ─── GET /api/profile/:id ─────────────────────────────────────────────────────
// Retorna perfil público de qualquer usuário por ID
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password -email -__v')
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })
    res.json({ user })
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── PUT /api/profile/me ──────────────────────────────────────────────────────
// Atualiza o perfil do usuário logado
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const allowed = ['name', 'age', 'bairro', 'zona', 'email', 'photo']
    const updates = {}

    allowed.forEach(field => {
      if (req.body[field] !== undefined) updates[field] = req.body[field]
    })

    // Validação da foto (base64 ~5MB = ~7MB string)
    if (updates.photo && updates.photo.length > 7 * 1024 * 1024) {
      return res.status(400).json({ error: 'Imagem muito grande. Máximo 5MB.' })
    }

    // Validações
    if (updates.age && (updates.age < 13 || updates.age > 100)) {
      return res.status(400).json({ error: 'Idade inválida' })
    }
    if (updates.email) {
      const existing = await User.findOne({
        email: updates.email.toLowerCase(),
        _id: { $ne: req.user._id }
      })
      if (existing) return res.status(400).json({ error: 'E-mail já em uso', field: 'email' })
      updates.email = updates.email.toLowerCase().trim()
    }
    if (updates.name) {
      updates.name = updates.name.trim()
      // Recalcula initials
      updates.initials = updates.name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase()
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password')

    res.json({ message: 'Perfil atualizado', user: user.toPublicJSON() })
  } catch (err) {
    console.error('[PUT /profile/me]', err)
    res.status(500).json({ error: 'Erro interno' })
  }
})

module.exports = router
