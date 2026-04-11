const express  = require('express')
const mongoose = require('mongoose')
const router   = express.Router()
const Group    = require('../models/Group')
const Message  = require('../models/Message')
const Notification = require('../models/Notification')
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
    const { name, team, bairro, zona, description, meetPoint, privacy, approvalRequired, groupType } = req.body
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
      groupType: ['misto','organizada','familia','feminino','jovem'].includes(groupType) ? groupType : 'misto',
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

    const filter = {}
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
router.post('/:id/entrar', validId, auth, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })

    const userId = String(req.user.id)
    const already = group.members.map(String).includes(userId)
    if (already) return res.status(400).json({ error: 'Você já é membro' })

    // Verificar se já está pendente
    const alreadyPending = group.pendingMembers?.some(p => String(p.user) === userId)
    if (alreadyPending) return res.status(400).json({ error: 'Solicitação já enviada, aguarde' })

    if (group.members.length >= group.maxMembers) return res.status(400).json({ error: 'Grupo cheio' })

    // ── GRUPO PÚBLICO: líder precisa aprovar ──
    if (group.privacy === 'public') {
      group.pendingMembers.push({
        user: req.user.id,
        name: req.user.name,
        handle: req.user.handle || '',
        status: 'pendingApproval',
      })
      await group.save()

      // Notificar o líder
      await Notification.create({
        user: group.leader,
        type: 'group_join_request',
        title: 'Nova solicitação de entrada',
        message: `${req.user.name} quer entrar no grupo ${group.name}`,
        group: group._id,
        fromUser: req.user.id,
        fromName: req.user.name,
      })

      return res.json({ message: 'Solicitação enviada! O líder precisa aprovar sua entrada.', status: 'pendingApproval' })
    }

    // ── GRUPO PRIVADO: entrada direta, mas precisa pagar ──
    if (group.membershipFee > 0) {
      group.pendingMembers.push({
        user: req.user.id,
        name: req.user.name,
        handle: req.user.handle || '',
        status: 'pendingPayment',
      })
      await group.save()
      return res.json({
        message: `Entrada confirmada! Pague a mensalidade de R$ ${(group.membershipFee / 100).toFixed(2).replace('.', ',')} para acessar o grupo.`,
        status: 'pendingPayment',
        fee: group.membershipFee,
      })
    }

    // ── GRUPO PRIVADO GRATUITO: entrada direta ──
    group.members.push(req.user.id)
    await group.save()

    await Message.create({
      grupo: group._id, sender: req.user.id, senderName: req.user.name,
      text: `${req.user.name} entrou no grupo`, type: 'system',
    })

    if (req.app.locals.wsBroadcast) {
      req.app.locals.wsBroadcast(group._id.toString(), {
        type: 'member_joined',
        data: { _id: req.user.id, name: req.user.name, handle: req.user.handle },
      })
    }

    res.json({ message: 'Entrou no grupo!', status: 'active', group })
  } catch (err) {
    console.error('[POST /grupos/:id/entrar]', err.message)
    res.status(500).json({ error: 'Erro ao entrar no grupo' })
  }
})

// ─── POST /api/grupos/:id/approve/:userId — líder aprova membro ──────────────
router.post('/:id/approve/:userId', validId, auth, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })
    if (String(group.leader) !== String(req.user.id)) return res.status(403).json({ error: 'Apenas o líder pode aprovar' })

    const pending = group.pendingMembers?.find(p => String(p.user) === req.params.userId)
    if (!pending) return res.status(404).json({ error: 'Solicitação não encontrada' })

    // Se tem mensalidade, mudar para pendingPayment
    if (group.membershipFee > 0) {
      pending.status = 'pendingPayment'
      await group.save()

      await Notification.create({
        user: req.params.userId,
        type: 'group_payment_pending',
        title: 'Entrada aprovada!',
        message: `Sua entrada no grupo ${group.name} foi aprovada. Pague a mensalidade para acessar.`,
        group: group._id,
        fromUser: req.user.id,
        fromName: req.user.name,
      })

      return res.json({ message: 'Aprovado! Membro precisa pagar a mensalidade.', status: 'pendingPayment' })
    }

    // Sem mensalidade: ativar direto
    group.pendingMembers = group.pendingMembers.filter(p => String(p.user) !== req.params.userId)
    group.members.push(req.params.userId)
    await group.save()

    await Notification.create({
      user: req.params.userId,
      type: 'group_approved',
      title: 'Entrada aprovada!',
      message: `Você foi aceito no grupo ${group.name}. Bem-vindo!`,
      group: group._id,
      fromUser: req.user.id,
      fromName: req.user.name,
    })

    await Message.create({
      grupo: group._id, sender: req.params.userId, senderName: pending.name,
      text: `${pending.name} entrou no grupo`, type: 'system',
    })

    res.json({ message: `${pending.name} aprovado e adicionado ao grupo!`, status: 'active' })
  } catch (err) {
    console.error('[POST /grupos/:id/approve]', err.message)
    res.status(500).json({ error: 'Erro ao aprovar membro' })
  }
})

// ─── POST /api/grupos/:id/reject/:userId — líder rejeita membro ─────────────
router.post('/:id/reject/:userId', validId, auth, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })
    if (String(group.leader) !== String(req.user.id)) return res.status(403).json({ error: 'Apenas o líder pode rejeitar' })

    group.pendingMembers = group.pendingMembers.filter(p => String(p.user) !== req.params.userId)
    await group.save()

    await Notification.create({
      user: req.params.userId,
      type: 'group_rejected',
      title: 'Solicitação recusada',
      message: `Sua solicitação para o grupo ${group.name} foi recusada.`,
      group: group._id,
      fromUser: req.user.id,
      fromName: req.user.name,
    })

    res.json({ message: 'Solicitação rejeitada.' })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao rejeitar' })
  }
})

// ─── POST /api/grupos/:id/pay — membro confirma pagamento (simulado) ─────────
router.post('/:id/pay', validId, auth, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })

    const pending = group.pendingMembers?.find(
      p => String(p.user) === String(req.user.id) && p.status === 'pendingPayment'
    )
    if (!pending) return res.status(400).json({ error: 'Nenhum pagamento pendente encontrado' })

    // Simular pagamento aprovado → ativar membro
    group.pendingMembers = group.pendingMembers.filter(p => String(p.user) !== String(req.user.id))
    group.members.push(req.user.id)
    await group.save()

    await Message.create({
      grupo: group._id, sender: req.user.id, senderName: req.user.name,
      text: `${req.user.name} entrou no grupo (pagamento confirmado)`, type: 'system',
    })

    if (req.app.locals.wsBroadcast) {
      req.app.locals.wsBroadcast(group._id.toString(), {
        type: 'member_joined',
        data: { _id: req.user.id, name: req.user.name, handle: req.user.handle },
      })
    }

    res.json({ message: 'Pagamento confirmado! Você agora é membro ativo.', status: 'active' })
  } catch (err) {
    console.error('[POST /grupos/:id/pay]', err.message)
    res.status(500).json({ error: 'Erro ao processar pagamento' })
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

    const allowed = ['name', 'description', 'bairro', 'zona', 'meetPoint', 'privacy', 'approvalRequired', 'photo', 'groupType', 'membershipFee', 'location']
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
    if (updates.groupType && !['misto', 'organizada', 'familia', 'feminino', 'jovem'].includes(updates.groupType)) {
      return res.status(400).json({ error: 'Tipo de grupo inválido' })
    }

    // Validação de localização
    if (updates.location) {
      if (typeof updates.location.lat !== 'number' || typeof updates.location.lng !== 'number') {
        return res.status(400).json({ error: 'Coordenadas inválidas' })
      }
    }

    // Validação de foto (mesma do perfil)
    if (updates.photo) {
      const validTypes = /^data:image\/(jpeg|jpg|png|webp);base64,/
      if (!validTypes.test(updates.photo)) {
        return res.status(400).json({ error: 'Formato de imagem inválido' })
      }
      const base64Data = updates.photo.split(',')[1]
      if (!base64Data || Buffer.byteLength(base64Data, 'base64') > 800 * 1024) {
        return res.status(400).json({ error: 'Imagem muito grande (máx 800KB)' })
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
