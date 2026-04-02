const express  = require('express')
const mongoose = require('mongoose')
const User     = require('../models/User')
const Group    = require('../models/Group')
const Ride     = require('../models/Ride')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

// ─── GET /api/profile/me ──────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  res.json({ user: req.user.toPublicJSON() })
})

// ─── GET /api/profile/me/stats ────────────────────────────────────────────────
// 📊 NOVO — Calcula stats reais do usuário a partir do MongoDB
router.get('/me/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id

    // Grupos que o usuário participa
    const grupos = await Group.countDocuments({ members: userId })

    // Viagens oferecidas (como motorista)
    const viagensOferecidas = await Ride.countDocuments({ driver: userId })

    // Viagens feitas (como passageiro, status paid ou confirmed)
    const viagensFeitas = await Ride.countDocuments({
      'passengers.user': userId,
      'passengers.status': { $in: ['paid', 'confirmed'] },
    })

    // Viagens concluídas (como motorista) — para calcular ganhos
    const viagensConcluidas = await Ride.find({
      driver: userId,
      status: 'completed',
    }).select('releasedTotal appCommission escrowTotal')

    const totalGanho = viagensConcluidas.reduce((sum, r) => sum + (r.releasedTotal || 0), 0)
    const totalComissao = viagensConcluidas.reduce((sum, r) => sum + (r.appCommission || 0), 0)

    // Avaliação média (futuro — por enquanto null)
    const avaliacaoMedia = null

    // Atividades recentes (últimas 10 viagens como motorista ou passageiro)
    const recentAsDriver = await Ride.find({ driver: userId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('game vehicle totalSeats status createdAt driverName')
      .lean()

    const recentAsPassenger = await Ride.find({ 'passengers.user': userId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('game vehicle driverName status createdAt')
      .lean()

    // Combinar e ordenar por data
    const atividades = [
      ...recentAsDriver.map(r => ({ ...r, role: 'motorista' })),
      ...recentAsPassenger.map(r => ({ ...r, role: 'passageiro' })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10)

    res.json({
      stats: {
        grupos,
        viagensOferecidas,
        viagensFeitas,
        viagensConcluidas: viagensConcluidas.length,
        totalGanho,           // centavos
        totalComissao,        // centavos
        avaliacaoMedia,
      },
      atividades,
    })
  } catch (err) {
    console.error('[GET /profile/me/stats]', err.message)
    res.status(500).json({ error: 'Erro ao buscar estatísticas' })
  }
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
