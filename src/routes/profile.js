const express  = require('express')
const mongoose = require('mongoose')
const User     = require('../models/User')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

// ─── GET /api/profile/me ──────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  res.json({ user: req.user.toPublicJSON() })
})

// ─── GET /api/profile/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    // 🔒 NOVO — validar ObjectId antes de buscar
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'ID inválido' })
    }

    const user = await User.findById(req.params.id).select('-password -email -__v')
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })
    res.json({ user })
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── PUT /api/profile/me ──────────────────────────────────────────────────────
router.put('/me', authMiddleware, async (req, res) => {
  try {
    // 🔒 MELHORADO — removido 'email' da whitelist (troca de email precisa de verificação por e-mail)
    const allowed = ['name', 'age', 'bairro', 'zona', 'photo']
    const updates = {}

    allowed.forEach(field => {
      if (req.body[field] !== undefined) updates[field] = req.body[field]
    })

    // 🔒 MELHORADO — validação de foto mais rigorosa
    if (updates.photo) {
      // Verificar formato: deve ser data URI de imagem
      const validTypes = /^data:image\/(jpeg|jpg|png|webp);base64,/
      if (!validTypes.test(updates.photo)) {
        return res.status(400).json({ error: 'Formato de imagem inválido. Use JPEG, PNG ou WebP.' })
      }

      // Verificar tamanho real do binário (base64 é ~33% maior)
      const base64Data = updates.photo.split(',')[1]
      if (!base64Data) {
        return res.status(400).json({ error: 'Imagem corrompida.' })
      }

      const sizeInBytes = Buffer.byteLength(base64Data, 'base64')
      const maxSize = 300 * 1024 // 🔒 300KB (antes era 5MB — muito alto)

      if (sizeInBytes > maxSize) {
        return res.status(400).json({
          error: `Imagem muito grande (${Math.round(sizeInBytes / 1024)}KB). Máximo: ${maxSize / 1024}KB.`
        })
      }
    }

    // Validações
    if (updates.age && (updates.age < 13 || updates.age > 100)) {
      return res.status(400).json({ error: 'Idade inválida' })
    }
    if (updates.name) {
      updates.name = updates.name.trim()
      if (updates.name.length < 2 || updates.name.length > 50) {  // 🔒 NOVO — limites de tamanho
        return res.status(400).json({ error: 'Nome deve ter entre 2 e 50 caracteres' })
      }
      updates.initials = updates.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password')

    res.json({ message: 'Perfil atualizado', user: user.toPublicJSON() })
  } catch (err) {
    console.error('[PUT /profile/me]', err.message) // 🔒 Só err.message
    res.status(500).json({ error: 'Erro interno' })
  }
})

module.exports = router
