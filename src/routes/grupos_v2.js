const express = require('express')
const router  = express.Router()
const Group   = require('../models/Group')
const Message = require('../models/Message')
const auth    = require('../middleware/auth')

// ─── POST /api/grupos — criar grupo ──────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const { name, team, bairro, zona, description, meetPoint, privacy, approvalRequired } = req.body
    const userId = req.user.id

    const existing = await Group.findOne({ leader: userId })
    if (existing) return res.status(400).json({ error: 'Você já é líder de um grupo.' })

    const duplicate = await Group.findOne({
      name:   { $regex: new RegExp(`^${name.trim()}$`, 'i') },
      team,
      bairro: { $regex: new RegExp(`^${bairro.trim()}$`, 'i') },
    })
    if (duplicate) return res.status(400).json({ error: 'Já existe um grupo com esse nome para esse time e bairro.' })

    const group = await Group.create({
      name: name.trim(), team, bairro: bairro.trim(), zona,
      description: description?.trim() || '',
      meetPoint: meetPoint.trim(),
      privacy: privacy || 'public',
      approvalRequired: !!approvalRequired,
      leader: userId,
      members: [userId],
    })

    // Mensagem de sistema de boas-vindas
    await Message.create({
      grupo: group._id, sender: userId,
      senderName: req.user.name || 'Líder',
      text: `Grupo "${group.name}" criado! Bem-vindo! 🎉`,
      type: 'system',
    })

    res.status(201).json({ group, message: 'Grupo criado com sucesso!' })
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Grupo duplicado.' })
    console.error('[POST /api/grupos]', err)
    res.status(500).json({ error: 'Erro ao criar grupo' })
  }
})

// ─── GET /api/grupos — listar ─────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { team, bairro, zona } = req.query
    const filter = { privacy: 'public' }
    if (team)   filter.team   = { $regex: new RegExp(team, 'i') }
    if (bairro) filter.bairro = { $regex: new RegExp(bairro, 'i') }
    if (zona)   filter.zona   = zona

    const groups = await Group.find(filter).sort({ createdAt: -1 }).limit(50).populate('leader', 'name handle')
    res.json({ groups, total: groups.length })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar grupos' })
  }
})

// ─── GET /api/grupos/:id — detalhes ──────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const group = await Group.findById(req.params.id).populate('leader', 'name handle')
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })
    res.json({ group })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar grupo' })
  }
})

// ─── GET /api/grupos/:id/membros ──────────────────────────────────────────────
router.get('/:id/membros', async (req, res) => {
  try {
    const group = await Group.findById(req.params.id).populate('members', 'name handle')
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })
    res.json({ members: group.members })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar membros' })
  }
})

// ─── GET /api/grupos/:id/mensagens ────────────────────────────────────────────
router.get('/:id/mensagens', async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit) || 50
    const skip   = parseInt(req.query.skip)  || 0
    const messages = await Message.find({ grupo: req.params.id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
    res.json({ messages: messages.reverse() })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar mensagens' })
  }
})

// ─── POST /api/grupos/:id/mensagens ──────────────────────────────────────────
router.post('/:id/mensagens', auth, async (req, res) => {
  try {
    const { text } = req.body
    if (!text?.trim()) return res.status(400).json({ error: 'Mensagem vazia' })

    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })

    const isMember = group.members.map(String).includes(String(req.user.id))
    if (!isMember) return res.status(403).json({ error: 'Você não é membro deste grupo' })

    const msg = await Message.create({
      grupo:      group._id,
      sender:     req.user.id,
      senderName: req.user.name,
      text:       text.trim(),
      type:       'text',
    })

    // Emitir via WebSocket (se disponível)
    if (req.app.locals.wsBroadcast) {
      req.app.locals.wsBroadcast(group._id.toString(), {
        type: 'message',
        data: { ...msg.toObject(), senderId: req.user.id },
      })
    }

    res.status(201).json({ message: msg })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao enviar mensagem' })
  }
})

// ─── POST /api/grupos/:id/entrar ──────────────────────────────────────────────
router.post('/:id/entrar', auth, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })
    if (group.members.length >= group.maxMembers) return res.status(400).json({ error: 'Grupo cheio' })

    const already = group.members.map(String).includes(String(req.user.id))
    if (already) return res.status(400).json({ error: 'Você já é membro' })

    group.members.push(req.user.id)
    await group.save()

    // Mensagem de sistema
    const msg = await Message.create({
      grupo: group._id, sender: req.user.id,
      senderName: req.user.name,
      text: `${req.user.name} entrou no grupo`,
      type: 'system',
    })

    if (req.app.locals.wsBroadcast) {
      req.app.locals.wsBroadcast(group._id.toString(), {
        type: 'member_joined',
        data: { _id: req.user.id, name: req.user.name, handle: req.user.handle },
      })
    }

    res.json({ message: 'Entrou no grupo!', group })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao entrar no grupo' })
  }
})

// ─── DELETE /api/grupos/:id/sair ─────────────────────────────────────────────
router.delete('/:id/sair', auth, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })

    group.members = group.members.filter(m => String(m) !== String(req.user.id))
    await group.save()
    res.json({ message: 'Você saiu do grupo' })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sair do grupo' })
  }
})

module.exports = router
