const express  = require('express')
const mongoose = require('mongoose')
const router   = express.Router()
const Group    = require('../models/Group')
const Message  = require('../models/Message')
const auth     = require('../middleware/auth')

// 🔒 NOVO — helper de sanitização anti-XSS
function sanitize(str) {
  if (typeof str !== 'string') return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

// 🔒 NOVO — middleware para validar ObjectId
function validId(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'ID inválido' })
  }
  next()
}

// 🔒 NOVO — middleware para verificar se é membro do grupo
async function requireMember(req, res, next) {
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })

    const isMember = group.members.map(String).includes(String(req.user.id))
    if (!isMember) return res.status(403).json({ error: 'Você não é membro deste grupo' })

    req.group = group // disponível nas rotas seguintes
    next()
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' })
  }
}

// ─── POST /api/grupos — criar grupo ──────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const { name, team, bairro, zona, description, meetPoint, privacy, approvalRequired } = req.body
    const userId = req.user.id

    const existing = await Group.findOne({ leader: userId })
    if (existing) return res.status(400).json({ error: 'Você já é líder de um grupo.' })

    // 🔒 MELHORADO — sanitizar inputs de texto
    const cleanName = sanitize(name?.trim())
    const cleanBairro = sanitize(bairro?.trim())
    const cleanMeetPoint = sanitize(meetPoint?.trim())

    const duplicate = await Group.findOne({
      name:   { $regex: new RegExp(`^${cleanName}$`, 'i') },
      team,
      bairro: { $regex: new RegExp(`^${cleanBairro}$`, 'i') },
    })
    if (duplicate) return res.status(400).json({ error: 'Já existe um grupo com esse nome para esse time e bairro.' })

    const group = await Group.create({
      name: cleanName, team, bairro: cleanBairro, zona,
      description: sanitize(description?.trim() || ''),
      meetPoint: cleanMeetPoint,
      privacy: privacy || 'public',
      approvalRequired: !!approvalRequired,
      leader: userId,
      members: [userId],
    })

    await Message.create({
      grupo: group._id, sender: userId,
      senderName: req.user.name || 'Líder',
      text: `Grupo "${group.name}" criado! Bem-vindo! 🎉`,
      type: 'system',
    })

    res.status(201).json({ group, message: 'Grupo criado com sucesso!' })
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Grupo duplicado.' })
    console.error('[POST /api/grupos]', err.message) // 🔒 Só err.message
    res.status(500).json({ error: 'Erro ao criar grupo' })
  }
})

// ─── GET /api/grupos — listar ─────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { team, bairro, zona, code } = req.query

    // 🆔 Busca por código do grupo
    if (code) {
      const group = await Group.findOne({ code: code.padStart(7, '0') }).populate('leader', 'name handle')
      if (!group) return res.status(404).json({ error: 'Grupo não encontrado com esse código' })
      return res.json({ groups: [group], total: 1 })
    }

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
router.get('/:id', validId, async (req, res) => {                    // 🔒 validId
  try {
    const group = await Group.findById(req.params.id).populate('leader', 'name handle')
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })
    res.json({ group })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar grupo' })
  }
})

// ─── GET /api/grupos/:id/membros ──────────────────────────────────────────────
router.get('/:id/membros', validId, auth, requireMember, async (req, res) => {  // 🔒 validId + auth + requireMember
  try {
    const group = await Group.findById(req.params.id).populate('members', 'name handle')
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })
    res.json({ members: group.members })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar membros' })
  }
})

// ─── GET /api/grupos/:id/mensagens ────────────────────────────────────────────
router.get('/:id/mensagens', validId, auth, requireMember, async (req, res) => {  // 🔒 validId + auth + requireMember
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 100)    // 🔒 Trava máximo em 100
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
router.post('/:id/mensagens', validId, auth, requireMember, async (req, res) => {  // 🔒 validId + requireMember (já tinha a checagem inline, agora é middleware)
  try {
    const { text } = req.body
    if (!text?.trim()) return res.status(400).json({ error: 'Mensagem vazia' })

    const msg = await Message.create({
      grupo:      req.group._id,                          // 🔒 Usa req.group do middleware
      sender:     req.user.id,
      senderName: req.user.name,
      text:       sanitize(text.trim()),                  // 🔒 Sanitizar mensagem
      type:       'text',
    })

    if (req.app.locals.wsBroadcast) {
      req.app.locals.wsBroadcast(req.group._id.toString(), {
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
router.post('/:id/entrar', validId, auth, async (req, res) => {      // 🔒 validId
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })
    if (group.members.length >= group.maxMembers) return res.status(400).json({ error: 'Grupo cheio' })

    const already = group.members.map(String).includes(String(req.user.id))
    if (already) return res.status(400).json({ error: 'Você já é membro' })

    group.members.push(req.user.id)
    await group.save()

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

// ─── PUT /api/grupos/:id — líder edita grupo ────────────────────────────────
router.put('/:id', validId, auth, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })

    if (String(group.leader) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o líder pode editar o grupo' })
    }

    const allowed = ['name', 'description', 'bairro', 'zona', 'meetPoint', 'privacy', 'approvalRequired', 'photo']
    const updates = {}

    allowed.forEach(field => {
      if (req.body[field] !== undefined) {
        if (typeof req.body[field] === 'string' && field !== 'photo') {
          updates[field] = sanitize(req.body[field])
        } else {
          updates[field] = req.body[field]
        }
      }
    })

    // Validações
    if (updates.name !== undefined) {
      updates.name = updates.name.trim()
      if (updates.name.length < 3 || updates.name.length > 50) {
        return res.status(400).json({ error: 'Nome deve ter entre 3 e 50 caracteres' })
      }
    }
    if (updates.description !== undefined && updates.description.length > 140) {
      return res.status(400).json({ error: 'Descrição deve ter no máximo 140 caracteres' })
    }
    if (updates.privacy && !['public', 'private'].includes(updates.privacy)) {
      return res.status(400).json({ error: 'Privacidade inválida' })
    }

    // Validação de foto (mesma do perfil)
    if (updates.photo) {
      const validTypes = /^data:image\/(jpeg|jpg|png|webp);base64,/
      if (!validTypes.test(updates.photo)) {
        return res.status(400).json({ error: 'Formato de imagem inválido' })
      }
      const base64Data = updates.photo.split(',')[1]
      if (!base64Data || Buffer.byteLength(base64Data, 'base64') > 300 * 1024) {
        return res.status(400).json({ error: 'Imagem muito grande (máx 300KB)' })
      }
    }

    const updated = await Group.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('leader', 'name handle')

    res.json({ message: 'Grupo atualizado!', group: updated })
  } catch (err) {
    console.error('[PUT /api/grupos/:id]', err.message)
    res.status(500).json({ error: 'Erro ao editar grupo' })
  }
})

// ─── DELETE /api/grupos/:id/sair ─────────────────────────────────────────────
router.delete('/:id/sair', validId, auth, async (req, res) => {      // 🔒 validId
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
