const express  = require('express')
const mongoose = require('mongoose')
const router   = express.Router()
const Invite   = require('../models/Invite')
const Group    = require('../models/Group')
const Ride     = require('../models/Ride')
const User     = require('../models/User')
const auth     = require('../middleware/auth')

function validId(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'ID inválido' })
  }
  next()
}

// ─── GET /api/invites/mine — meus convites pendentes ─────────────────────────
router.get('/mine', auth, async (req, res) => {
  try {
    const invites = await Invite.find({
      recipient: req.user.id,
      status: 'pending',
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()

    res.json({ invites })
  } catch (err) {
    console.error('[GET /invites/mine]', err.message)
    res.status(500).json({ error: 'Erro ao buscar convites' })
  }
})

// ─── POST /api/invites/group/:id — convidar usuário para grupo ───────────────
router.post('/group/:id', validId, auth, async (req, res) => {
  try {
    const { handle } = req.body
    if (!handle) return res.status(400).json({ error: 'Informe o handle do usuário' })

    const group = await Group.findById(req.params.id)
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' })

    // Só líder ou membro pode convidar
    const isMember = group.members.map(String).includes(String(req.user.id))
    if (!isMember) return res.status(403).json({ error: 'Você não é membro deste grupo' })

    // Buscar destinatário por handle
    const cleanHandle = handle.replace('@', '').toLowerCase().trim()
    const recipient = await User.findOne({ handle: cleanHandle })
    if (!recipient) return res.status(404).json({ error: `Usuário @${cleanHandle} não encontrado` })

    // Verificar se já é membro
    if (group.members.map(String).includes(String(recipient._id))) {
      return res.status(400).json({ error: `@${cleanHandle} já é membro do grupo` })
    }

    // Verificar convite duplicado pendente
    const existing = await Invite.findOne({
      group: group._id, recipient: recipient._id, status: 'pending',
    })
    if (existing) return res.status(400).json({ error: 'Convite já enviado para este usuário' })

    const invite = await Invite.create({
      type: 'group',
      group: group._id,
      sender: req.user.id,
      senderName: req.user.name,
      recipient: recipient._id,
      method: 'direct',
      targetName: group.name,
      message: req.body.message || '',
    })

    res.status(201).json({ message: `Convite enviado para @${cleanHandle}!`, invite })
  } catch (err) {
    console.error('[POST /invites/group/:id]', err.message)
    res.status(500).json({ error: 'Erro ao enviar convite' })
  }
})

// ─── POST /api/invites/ride/:id — convidar usuário para viagem ───────────────
router.post('/ride/:id', validId, auth, async (req, res) => {
  try {
    const { handle } = req.body
    if (!handle) return res.status(400).json({ error: 'Informe o handle do usuário' })

    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    // Só motorista pode convidar
    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o motorista pode convidar' })
    }

    // Verificar vagas
    const activeCount = ride.passengers.filter(p => p.status !== 'cancelled').length
    if (activeCount >= ride.totalSeats) {
      return res.status(400).json({ error: 'Viagem lotada, sem vagas disponíveis' })
    }

    const cleanHandle = handle.replace('@', '').toLowerCase().trim()
    const recipient = await User.findOne({ handle: cleanHandle })
    if (!recipient) return res.status(404).json({ error: `Usuário @${cleanHandle} não encontrado` })

    // Verificar se já é passageiro
    const alreadyPassenger = ride.passengers.some(
      p => String(p.user) === String(recipient._id) && p.status !== 'cancelled'
    )
    if (alreadyPassenger) return res.status(400).json({ error: `@${cleanHandle} já está nesta viagem` })

    // Verificar convite duplicado
    const existing = await Invite.findOne({
      ride: ride._id, recipient: recipient._id, status: 'pending',
    })
    if (existing) return res.status(400).json({ error: 'Convite já enviado para este usuário' })

    const invite = await Invite.create({
      type: 'ride',
      ride: ride._id,
      sender: req.user.id,
      senderName: req.user.name,
      recipient: recipient._id,
      method: 'direct',
      targetName: `${ride.game.homeTeam} × ${ride.game.awayTeam}`,
      message: req.body.message || '',
      expiresAt: ride.expiresAt || null,
    })

    res.status(201).json({ message: `Convite enviado para @${cleanHandle}!`, invite })
  } catch (err) {
    console.error('[POST /invites/ride/:id]', err.message)
    res.status(500).json({ error: 'Erro ao enviar convite' })
  }
})

// ─── POST /api/invites/:id/accept — aceitar convite ──────────────────────────
router.post('/:id/accept', validId, auth, async (req, res) => {
  try {
    const invite = await Invite.findById(req.params.id)
    if (!invite) return res.status(404).json({ error: 'Convite não encontrado' })

    if (String(invite.recipient) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Este convite não é para você' })
    }
    if (invite.status !== 'pending') {
      return res.status(400).json({ error: `Convite já ${invite.status === 'accepted' ? 'aceito' : 'rejeitado'}` })
    }

    // ── Aceitar convite de grupo ──
    if (invite.type === 'group' && invite.group) {
      const group = await Group.findById(invite.group)
      if (!group) { invite.status = 'expired'; await invite.save(); return res.status(404).json({ error: 'Grupo não existe mais' }) }

      // Se grupo privado com aprovação, marcar como pendente de aprovação do líder
      if (group.privacy === 'private' && group.approvalRequired) {
        invite.status = 'accepted' // usuário aceitou, mas líder precisa aprovar
        await invite.save()
        return res.json({ message: 'Solicitação enviada ao líder para aprovação.', invite })
      }

      // Entrada direta
      if (!group.members.map(String).includes(String(req.user.id))) {
        group.members.push(req.user.id)
        await group.save()
      }

      invite.status = 'accepted'
      await invite.save()
      return res.json({ message: `Você entrou no grupo ${group.name}!`, invite })
    }

    // ── Aceitar convite de viagem ──
    if (invite.type === 'ride' && invite.ride) {
      const ride = await Ride.findById(invite.ride)
      if (!ride) { invite.status = 'expired'; await invite.save(); return res.status(404).json({ error: 'Viagem não existe mais' }) }

      const activeCount = ride.passengers.filter(p => p.status !== 'cancelled').length
      if (activeCount >= ride.totalSeats) {
        invite.status = 'expired'
        await invite.save()
        return res.status(400).json({ error: 'Viagem lotada' })
      }

      // Verificar se já é passageiro
      const already = ride.passengers.some(p => String(p.user) === String(req.user.id) && p.status !== 'cancelled')
      if (!already) {
        // Verificar se é membro do grupo do motorista (para preço de membro)
        let isMember = false
        if (ride.group) {
          const g = await Group.findById(ride.group)
          if (g) isMember = g.members.map(String).includes(String(req.user.id))
        }

        const paidAmount = isMember && ride.memberPrice != null ? ride.memberPrice : ride.price
        ride.passengers.push({
          user: req.user.id,
          name: req.user.name,
          handle: req.user.handle || '',
          status: 'paid',
          paidAmount,
          isMember,
          reservedAt: new Date(),
        })
        ride.escrowTotal += paidAmount

        if (ride.passengers.filter(p => p.status !== 'cancelled').length >= ride.totalSeats) {
          ride.status = 'full'
        }
        await ride.save()
      }

      invite.status = 'accepted'
      await invite.save()
      return res.json({ message: 'Reserva confirmada via convite!', invite })
    }

    res.status(400).json({ error: 'Tipo de convite inválido' })
  } catch (err) {
    console.error('[POST /invites/:id/accept]', err.message)
    res.status(500).json({ error: 'Erro ao aceitar convite' })
  }
})

// ─── POST /api/invites/:id/reject — rejeitar convite ─────────────────────────
router.post('/:id/reject', validId, auth, async (req, res) => {
  try {
    const invite = await Invite.findById(req.params.id)
    if (!invite) return res.status(404).json({ error: 'Convite não encontrado' })

    if (String(invite.recipient) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Este convite não é para você' })
    }
    if (invite.status !== 'pending') {
      return res.status(400).json({ error: 'Convite já processado' })
    }

    invite.status = 'rejected'
    await invite.save()
    res.json({ message: 'Convite recusado.', invite })
  } catch (err) {
    console.error('[POST /invites/:id/reject]', err.message)
    res.status(500).json({ error: 'Erro ao rejeitar convite' })
  }
})

// ─── POST /api/invites/join/:code — entrar por código (grupo) ────────────────
router.post('/join/:code', auth, async (req, res) => {
  try {
    const group = await Group.findOne({ code: req.params.code.padStart(7, '0') })
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado com esse código' })

    // Já é membro?
    if (group.members.map(String).includes(String(req.user.id))) {
      return res.json({ message: 'Você já é membro deste grupo!', group })
    }

    // Grupo lotado?
    if (group.members.length >= group.maxMembers) {
      return res.status(400).json({ error: 'Grupo lotado' })
    }

    // Grupo privado com aprovação?
    if (group.privacy === 'private' && group.approvalRequired) {
      // Criar convite pendente para o líder aprovar
      const existing = await Invite.findOne({ group: group._id, recipient: req.user.id, status: 'pending' })
      if (existing) return res.status(400).json({ error: 'Solicitação já enviada, aguarde aprovação' })

      await Invite.create({
        type: 'group', group: group._id,
        sender: req.user.id, senderName: req.user.name,
        recipient: group.leader, method: 'link',
        targetName: group.name,
        message: `${req.user.name} quer entrar no grupo via código`,
      })
      return res.json({ message: 'Solicitação enviada ao líder para aprovação!' })
    }

    // Entrada direta
    group.members.push(req.user.id)
    await group.save()
    res.json({ message: `Você entrou no grupo ${group.name}!`, group })
  } catch (err) {
    console.error('[POST /invites/join/:code]', err.message)
    res.status(500).json({ error: 'Erro ao entrar no grupo' })
  }
})

module.exports = router
