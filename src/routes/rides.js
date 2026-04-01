const express  = require('express')
const mongoose = require('mongoose')
const router   = express.Router()
const Ride     = require('../models/Ride')
const Group    = require('../models/Group')
const auth     = require('../middleware/auth')

// Helper: sanitizar texto
function sanitize(str) {
  if (typeof str !== 'string') return ''
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

// Helper: validar ObjectId
function validId(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'ID inválido' })
  }
  next()
}

// ─── POST /api/rides — criar viagem ──────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const {
      vehicle, totalSeats, price, memberPrice,
      meetPoint, meetCoords, departureTime, bairro, zona,
      game, groupId,
    } = req.body

    // Validações básicas
    if (!vehicle || !totalSeats || price == null || !meetPoint || !departureTime || !game) {
      return res.status(400).json({ error: 'Campos obrigatórios: vehicle, totalSeats, price, meetPoint, departureTime, game' })
    }
    if (!game.homeTeam || !game.awayTeam || !game.date || !game.stadium) {
      return res.status(400).json({ error: 'Dados do jogo incompletos (homeTeam, awayTeam, date, stadium)' })
    }
    if (!['carro', 'van', 'onibus'].includes(vehicle)) {
      return res.status(400).json({ error: 'Veículo inválido. Use: carro, van ou onibus' })
    }

    // Van/ônibus: só líderes de grupo
    if (vehicle !== 'carro') {
      const leaderGroup = await Group.findOne({ leader: req.user.id })
      if (!leaderGroup) {
        return res.status(403).json({ error: 'Apenas líderes de grupo podem ofertar van ou ônibus' })
      }
    }

    // Limites de vagas por veículo
    const maxSeats = { carro: 4, van: 15, onibus: 50 }
    if (totalSeats < 1 || totalSeats > maxSeats[vehicle]) {
      return res.status(400).json({ error: `Vagas para ${vehicle}: 1 a ${maxSeats[vehicle]}` })
    }

    // Preço mínimo
    if (price < 0) {
      return res.status(400).json({ error: 'Preço não pode ser negativo' })
    }

    // Montar grupo associado (se líder)
    let group = null
    let groupName = ''
    if (groupId) {
      group = await Group.findById(groupId)
      if (!group || String(group.leader) !== String(req.user.id)) {
        return res.status(403).json({ error: 'Você não é líder desse grupo' })
      }
      groupName = group.name
    }

    const ride = await Ride.create({
      driver: req.user.id,
      driverName: req.user.name,
      driverHandle: req.user.handle || '',
      group: group?._id || null,
      groupName,
      game: {
        homeTeam: sanitize(game.homeTeam),
        awayTeam: sanitize(game.awayTeam),
        date: new Date(game.date),
        stadium: sanitize(game.stadium),
      },
      vehicle,
      totalSeats,
      price: Math.round(price),
      memberPrice: memberPrice != null ? Math.round(memberPrice) : null,
      meetPoint: sanitize(meetPoint),
      meetCoords: meetCoords || {},
      departureTime: new Date(departureTime),
      bairro: sanitize(bairro || ''),
      zona: sanitize(zona || ''),
    })

    res.status(201).json({ ride, message: 'Viagem criada com sucesso!' })
  } catch (err) {
    console.error('[POST /api/rides]', err.message)
    res.status(500).json({ error: 'Erro ao criar viagem' })
  }
})

// ─── GET /api/rides — listar viagens ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { team, zona, vehicle, status } = req.query
    const filter = { status: status || 'open' }

    if (team) filter.$or = [
      { 'game.homeTeam': { $regex: new RegExp(team, 'i') } },
      { 'game.awayTeam': { $regex: new RegExp(team, 'i') } },
    ]
    if (zona) filter.zona = zona
    if (vehicle) filter.vehicle = vehicle

    // Só viagens futuras
    filter.departureTime = { $gte: new Date() }

    const rides = await Ride.find(filter)
      .sort({ departureTime: 1 })
      .limit(50)
      .lean()

    // Adicionar availableSeats ao resultado
    const result = rides.map(r => ({
      ...r,
      availableSeats: r.totalSeats - r.passengers.filter(p => p.status !== 'cancelled').length,
    }))

    res.json({ rides: result, total: result.length })
  } catch (err) {
    console.error('[GET /api/rides]', err.message)
    res.status(500).json({ error: 'Erro ao buscar viagens' })
  }
})

// ─── GET /api/rides/mine — minhas viagens (motorista e passageiro) ───────────
router.get('/mine', auth, async (req, res) => {
  try {
    const asDriver = await Ride.find({ driver: req.user.id })
      .sort({ departureTime: -1 })
      .limit(20)
      .lean()

    const asPassenger = await Ride.find({ 'passengers.user': req.user.id })
      .sort({ departureTime: -1 })
      .limit(20)
      .lean()

    res.json({ asDriver, asPassenger })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar suas viagens' })
  }
})

// ─── GET /api/rides/:id — detalhes ───────────────────────────────────────────
router.get('/:id', validId, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
    res.json({ ride })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar viagem' })
  }
})

// ─── POST /api/rides/:id/reserve — reservar vaga ────────────────────────────
router.post('/:id/reserve', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    if (ride.status !== 'open') {
      return res.status(400).json({ error: 'Viagem não está aberta para reservas' })
    }

    // Não pode reservar na própria viagem
    if (String(ride.driver) === String(req.user.id)) {
      return res.status(400).json({ error: 'Você é o motorista desta viagem' })
    }

    // Já reservou?
    const alreadyIn = ride.passengers.find(
      p => String(p.user) === String(req.user.id) && p.status !== 'cancelled'
    )
    if (alreadyIn) {
      return res.status(400).json({ error: 'Você já tem uma reserva nesta viagem' })
    }

    // Vagas disponíveis
    const active = ride.passengers.filter(p => p.status !== 'cancelled').length
    if (active >= ride.totalSeats) {
      return res.status(400).json({ error: 'Não há vagas disponíveis' })
    }

    // Verificar se é membro do grupo do motorista (preço diferenciado)
    let isMember = false
    let finalPrice = ride.price

    if (ride.group) {
      const group = await Group.findById(ride.group)
      if (group && group.members.map(String).includes(String(req.user.id))) {
        isMember = true
        if (ride.memberPrice != null) {
          finalPrice = ride.memberPrice
        }
      }
    }

    // Adicionar passageiro
    ride.passengers.push({
      user: req.user.id,
      name: req.user.name,
      handle: req.user.handle || '',
      status: 'paid',         // simulado — pagamento instantâneo
      paidAmount: finalPrice,
      isMember,
    })

    // Escrow: acumular pagamento preso
    ride.escrowTotal += finalPrice

    // Se lotou, mudar status
    const newActive = ride.passengers.filter(p => p.status !== 'cancelled').length
    if (newActive >= ride.totalSeats) {
      ride.status = 'full'
    }

    await ride.save()

    res.status(201).json({
      message: isMember
        ? `Reserva confirmada! Preço de membro: R$ ${(finalPrice / 100).toFixed(2)}`
        : `Reserva confirmada! R$ ${(finalPrice / 100).toFixed(2)}`,
      ride,
      paidAmount: finalPrice,
      isMember,
    })
  } catch (err) {
    console.error('[POST /rides/:id/reserve]', err.message)
    res.status(500).json({ error: 'Erro ao reservar vaga' })
  }
})

// ─── DELETE /api/rides/:id/cancel-reservation — passageiro desiste ──────────
router.delete('/:id/cancel-reservation', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    const passenger = ride.passengers.find(
      p => String(p.user) === String(req.user.id) && p.status !== 'cancelled'
    )
    if (!passenger) {
      return res.status(400).json({ error: 'Você não tem reserva ativa nesta viagem' })
    }

    // Reembolsar escrow (simulado)
    ride.escrowTotal -= passenger.paidAmount
    passenger.status = 'cancelled'

    // Se estava full, voltar para open
    if (ride.status === 'full') {
      ride.status = 'open'
    }

    await ride.save()

    res.json({ message: 'Reserva cancelada. Reembolso simulado processado.', ride })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao cancelar reserva' })
  }
})

// ─── POST /api/rides/:id/confirm/driver — motorista confirma viagem ─────────
router.post('/:id/confirm/driver', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o motorista pode confirmar' })
    }

    if (ride.driverConfirmed) {
      return res.status(400).json({ error: 'Você já confirmou esta viagem' })
    }

    ride.driverConfirmed = true
    ride.driverConfirmedAt = new Date()

    // Verificar se todos os passageiros ativos também confirmaram
    const activePassengers = ride.passengers.filter(p => p.status === 'paid' || p.status === 'confirmed')
    const allPassengersConfirmed = activePassengers.length > 0 &&
      activePassengers.every(p => p.status === 'confirmed')

    if (allPassengersConfirmed) {
      // Ambos os lados confirmaram → concluir viagem
      ride.status = 'completed'

      // Liberar escrow (simulado): 80% motorista, 20% app
      const commission = Math.round(ride.escrowTotal * 0.20)
      ride.appCommission = commission
      ride.releasedTotal = ride.escrowTotal - commission
    } else {
      ride.status = 'in_progress'
    }

    await ride.save()

    res.json({
      message: ride.status === 'completed'
        ? `Viagem concluída! R$ ${(ride.releasedTotal / 100).toFixed(2)} liberado (simulado).`
        : 'Confirmação registrada. Aguardando passageiros confirmarem.',
      ride,
    })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao confirmar viagem' })
  }
})

// ─── POST /api/rides/:id/confirm/passenger — passageiro confirma viagem ─────
router.post('/:id/confirm/passenger', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    const passenger = ride.passengers.find(
      p => String(p.user) === String(req.user.id) && (p.status === 'paid' || p.status === 'reserved')
    )
    if (!passenger) {
      return res.status(400).json({ error: 'Você não tem reserva ativa nesta viagem' })
    }

    if (passenger.status === 'confirmed') {
      return res.status(400).json({ error: 'Você já confirmou esta viagem' })
    }

    passenger.status = 'confirmed'
    passenger.confirmedAt = new Date()

    // Verificar se motorista também confirmou e TODOS passageiros ativos confirmaram
    const activePassengers = ride.passengers.filter(p => p.status === 'paid' || p.status === 'confirmed')
    const allConfirmed = activePassengers.every(p => p.status === 'confirmed')

    if (ride.driverConfirmed && allConfirmed) {
      ride.status = 'completed'

      const commission = Math.round(ride.escrowTotal * 0.20)
      ride.appCommission = commission
      ride.releasedTotal = ride.escrowTotal - commission
    }

    await ride.save()

    res.json({
      message: ride.status === 'completed'
        ? `Viagem concluída! Crédito liberado pro motorista (simulado).`
        : 'Confirmação registrada. Aguardando outras confirmações.',
      ride,
    })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao confirmar viagem' })
  }
})

// ─── DELETE /api/rides/:id — motorista cancela viagem ────────────────────────
router.delete('/:id', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o motorista pode cancelar' })
    }

    if (ride.status === 'completed') {
      return res.status(400).json({ error: 'Viagem já concluída, não pode ser cancelada' })
    }

    // Reembolsar todos os passageiros ativos (simulado)
    ride.passengers.forEach(p => {
      if (p.status !== 'cancelled') {
        p.status = 'cancelled'
      }
    })

    ride.status = 'cancelled'
    ride.escrowTotal = 0

    await ride.save()

    res.json({ message: 'Viagem cancelada. Todos os passageiros foram reembolsados (simulado).', ride })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao cancelar viagem' })
  }
})

module.exports = router
