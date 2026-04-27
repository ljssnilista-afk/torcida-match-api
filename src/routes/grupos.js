const express  = require('express')
const mongoose = require('mongoose')
const router   = express.Router()
const Group    = require('../models/Group')
const Message  = require('../models/Message')
const Notification = require('../models/Notification')
const User     = require('../models/User')
const auth     = require('../middleware/auth')
const { stripe } = require('../config/stripe')

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
//
// 🔒 Se o grupo for PRIVADO PAGO (membershipFee >= 100), o líder precisa ter
//    concluído o onboarding Stripe ANTES — caso contrário não há para onde
//    repassar a mensalidade.
//
//    Grupos públicos / privados gratuitos: criação livre, sem onboarding.
router.post('/', auth, async (req, res) => {
  try {
    const { name, team, bairro, zona, description, meetPoint, privacy, approvalRequired, groupType, membershipFee } = req.body
    const userId = req.user.id

    const existing = await Group.findOne({ leader: userId })
    if (existing) return res.status(400).json({ error: 'Você já é líder de um grupo.' })

    // 🔒 sanitizar inputs de texto
    const cleanName = sanitize(name?.trim())
    const cleanBairro = sanitize(bairro?.trim())
    const cleanMeetPoint = sanitize(meetPoint?.trim())

    const duplicate = await Group.findOne({
      name:   { $regex: new RegExp(`^${cleanName}$`, 'i') },
      team,
      bairro: { $regex: new RegExp(`^${cleanBairro}$`, 'i') },
    })
    if (duplicate) return res.status(400).json({ error: 'Já existe um grupo com esse nome para esse time e bairro.' })

    const fee = (typeof membershipFee === 'number' && membershipFee >= 100) ? Math.round(membershipFee) : 0

    // 🔒 BLOQUEIO ONBOARDING — grupo pago exige Connected Account ativa
    if (fee > 0) {
      const leader = await User.findById(userId).select(
        'stripeAccountId stripeOnboardingDone chargesEnabled accountUnderReview suspendedUntil'
      )
      if (leader?.accountUnderReview) {
        return res.status(403).json({ error: 'Conta sob revisão. Entre em contato com o suporte.', code: 'ACCOUNT_UNDER_REVIEW' })
      }
      if (leader?.suspendedUntil && leader.suspendedUntil > new Date()) {
        return res.status(403).json({ error: 'Conta suspensa.', code: 'ACCOUNT_SUSPENDED', suspendedUntil: leader.suspendedUntil })
      }
      if (!leader?.stripeAccountId || !leader.stripeOnboardingDone || !leader.chargesEnabled) {
        return res.status(403).json({
          error: 'Para criar um grupo PAGO você precisa concluir o cadastro financeiro primeiro.',
          code: 'ONBOARDING_REQUIRED',
          action: 'POST /api/connect/onboard',
        })
      }
    }

    const group = await Group.create({
      name: cleanName, team, bairro: cleanBairro, zona,
      description: sanitize(description?.trim() || ''),
      meetPoint: cleanMeetPoint,
      privacy: privacy || 'public',
      approvalRequired: !!approvalRequired,
      groupType: ['misto','organizada','familia','feminino','jovem'].includes(groupType) ? groupType : 'misto',
      membershipFee: fee,
      isPago: fee > 0,
      leader: userId,
      leaderStripeAccountId: req.user.stripeAccountId || '',
      members: [userId],
    })

    // Criar Product + Price já no Stripe se grupo é pago
    if (fee > 0) {
      try {
        if (!group.stripeProductId) {
          const product = await stripe.products.create({
            name: `Mensalidade ${group.name}`,
            metadata: { groupId: String(group._id), leaderId: String(userId) },
          })
          group.stripeProductId = product.id
        }
        if (!group.stripePriceId) {
          const price = await stripe.prices.create({
            product:    group.stripeProductId,
            unit_amount: fee,
            currency:   'brl',
            recurring:  { interval: 'month' },
            metadata:   { groupId: String(group._id) },
          })
          group.stripePriceId = price.id
        }
        await group.save()
      } catch (e) {
        console.error('[GRUPOS] Falha ao criar Product/Price Stripe (grupo criado):', e.message)
      }
    }

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

    // ── PÚBLICO: líder aprova manualmente ──
    if (group.privacy === 'public') {
      group.pendingMembers.push({
        user:   req.user.id,
        name:   req.user.name,
        handle: req.user.handle || '',
        status: 'pendingApproval',
      })
      await group.save()

      await Notification.create({
        user:     group.leader,
        type:     'group_join_request',
        title:    'Nova solicitação de entrada',
        message:  `${req.user.name} quer entrar no grupo ${group.name}`,
        group:    group._id,
        fromUser: req.user.id,
        fromName: req.user.name,
      })

      return res.json({
        message: 'Solicitação enviada! Aguardando aprovação do líder.',
        status: 'pendingApproval',
      })
    }

    // ── PRIVADO — sempre exige pagamento ──
    if (group.privacy === 'private') {
      // Grupo privado SEMPRE requer pagamento (mínimo R$ 1,00)
      // Se membershipFee não foi definido corretamente, bloqueia a entrada
      if (group.membershipFee < 100) {
        return res.status(400).json({
          error: 'Este grupo privado não tem mensalidade configurada. Peça ao líder para definir o valor.',
          status: 'error',
        })
      }

      group.pendingMembers.push({
        user:   req.user.id,
        name:   req.user.name,
        handle: req.user.handle || '',
        status: 'pendingPayment',
      })
      await group.save()

      return res.json({
        message: `Pague a mensalidade de R$ ${(group.membershipFee / 100).toFixed(2).replace('.', ',')} para entrar no grupo.`,
        status:  'pendingPayment',
        fee:     group.membershipFee,
      })
    }
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

    // 🔒 BLOQUEIO ONBOARDING — virou grupo pago? exige onboarding
    if (updates.membershipFee != null && updates.membershipFee >= 100) {
      const leader = await User.findById(req.user.id).select(
        'stripeAccountId stripeOnboardingDone chargesEnabled accountUnderReview suspendedUntil'
      )
      if (!leader?.stripeAccountId || !leader.stripeOnboardingDone || !leader.chargesEnabled) {
        return res.status(403).json({
          error: 'Para definir mensalidade você precisa concluir o cadastro financeiro primeiro.',
          code: 'ONBOARDING_REQUIRED',
          action: 'POST /api/connect/onboard',
        })
      }
    }

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
router.delete('/:id/sair', validId, auth, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })

    const userId = String(req.user.id)
    const isLeader = String(group.leader) === userId

    // Líder não pode sair sem transferir liderança ou excluir o grupo
    if (isLeader) {
      return res.status(400).json({
        error: 'Você é o líder deste grupo. Transfira a liderança para outro membro ou exclua o grupo antes de sair.',
        code: 'LEADER_CANNOT_LEAVE',
      })
    }

    group.members = group.members.filter(m => String(m) !== userId)
    await group.save()

    await Message.create({
      grupo: group._id, sender: req.user.id, senderName: req.user.name,
      text: `${req.user.name} saiu do grupo`, type: 'system',
    })

    res.json({ message: 'Você saiu do grupo' })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sair do grupo' })
  }
})

// ─── POST /api/grupos/:id/transfer/:userId — transferir liderança ───────────
router.post('/:id/transfer/:userId', validId, auth, async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })

    if (String(group.leader) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o líder pode transferir a liderança' })
    }

    const newLeaderId = req.params.userId
    const isMember = group.members.map(String).includes(newLeaderId)
    if (!isMember) {
      return res.status(400).json({ error: 'O novo líder precisa ser membro do grupo' })
    }

    if (String(newLeaderId) === String(req.user.id)) {
      return res.status(400).json({ error: 'Você já é o líder' })
    }

    const oldLeaderName = req.user.name
    group.leader = newLeaderId
    await group.save()

    // Buscar nome do novo líder
    const User = require('../models/User')
    const newLeader = await User.findById(newLeaderId).select('name')

    await Message.create({
      grupo: group._id, sender: req.user.id, senderName: oldLeaderName,
      text: `${oldLeaderName} transferiu a liderança para ${newLeader?.name || 'novo líder'}`,
      type: 'system',
    })

    // Notificar novo líder
    await Notification.create({
      user: newLeaderId,
      type: 'group_leadership_transfer',
      title: 'Você é o novo líder!',
      message: `${oldLeaderName} transferiu a liderança do grupo ${group.name} para você.`,
      group: group._id,
      fromUser: req.user.id,
      fromName: oldLeaderName,
    })

    res.json({ message: `Liderança transferida para ${newLeader?.name || 'novo líder'}` })
  } catch (err) {
    console.error('[POST /grupos/:id/transfer]', err.message)
    res.status(500).json({ error: 'Erro ao transferir liderança' })
  }
})

module.exports = router
