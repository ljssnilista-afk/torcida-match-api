const express  = require('express')
const router   = express.Router()
const Group    = require('../models/Group')
const auth     = require('../middleware/auth')

// ─── POST /api/grupos — criar grupo ──────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const { name, team, bairro, zona, description, meetPoint, privacy, approvalRequired } = req.body
    const userId = req.user.id

    // Verifica se usuário já é líder de algum grupo
    const existing = await Group.findOne({ leader: userId })
    if (existing) {
      return res.status(400).json({ error: 'Você já é líder de um grupo. Limite de 1 grupo por usuário.' })
    }

    // Verifica duplicidade nome+time+bairro
    const duplicate = await Group.findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
      team,
      bairro: { $regex: new RegExp(`^${bairro.trim()}$`, 'i') },
    })
    if (duplicate) {
      return res.status(400).json({ error: 'Já existe um grupo com esse nome para esse time e bairro.' })
    }

    const group = await Group.create({
      name:             name.trim(),
      team,
      bairro:           bairro.trim(),
      zona,
      description:      description?.trim() || '',
      meetPoint:        meetPoint.trim(),
      privacy:          privacy || 'public',
      approvalRequired: !!approvalRequired,
      leader:           userId,
      members:          [userId],
    })

    res.status(201).json({ group, message: 'Grupo criado com sucesso!' })
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Já existe um grupo com esse nome para esse time e bairro.' })
    }
    console.error('[POST /api/grupos]', err.message)
    res.status(500).json({ error: 'Erro ao criar grupo' })
  }
})

// ─── GET /api/grupos — listar grupos públicos ─────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { team, bairro, zona } = req.query
    const filter = { privacy: 'public' }
    if (team)   filter.team   = { $regex: new RegExp(team, 'i') }
    if (bairro) filter.bairro = { $regex: new RegExp(bairro, 'i') }
    if (zona)   filter.zona   = zona

    const groups = await Group.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('leader', 'name handle')

    res.json({ groups, total: groups.length })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar grupos' })
  }
})

module.exports = router
