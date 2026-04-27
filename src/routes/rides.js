const express  = require('express')
const mongoose = require('mongoose')
const bcrypt   = require('bcryptjs')
const router   = express.Router()
const Ride     = require('../models/Ride')
const Group    = require('../models/Group')
const RideMessage = require('../models/RideMessage')
const User        = require('../models/User')
const Transaction = require('../models/Transaction')
const Notification = require('../models/Notification')
const auth     = require('../middleware/auth')
const requireOnboarding = require('../middleware/requireStripeOnboarding')
const penalties = require('../services/penalties')
const { stripe } = require('../config/stripe')

// ═══════════════════════════════════════════════════════════════════════════════
// Constantes financeiras
// ═══════════════════════════════════════════════════════════════════════════════
const RIDE_FEE_PCT          = 0.08
const CANCEL_DEADLINE_HOURS = 2

// Helper: sanitizar texto
function sanitize(str) {
  if (typeof str !== 'string') return ''
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

function validId(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'ID inválido' })
  }
  next()
}

// 🗑️ Salvar histórico permanente no perfil de todos os participantes
async function saveRideHistory(ride) {
  try {
    const baseEntry = {
      rideId: ride._id,
      homeTeam: ride.game.homeTeam,
      awayTeam: ride.game.awayTeam,
      gameDate: ride.game.date,
      vehicle: ride.vehicle,
      completedAt: new Date(),
    }

    await User.findByIdAndUpdate(ride.driver, {
      $push: {
        rideHistory: { ...baseEntry, role: 'motorista', earned: ride.releasedTotal || 0 }
      }
    })

    const confirmed = ride.passengers.filter(p => ['paid', 'confirmed'].includes(p.status))
    for (const p of confirmed) {
      await User.findByIdAndUpdate(p.user, {
        $push: { rideHistory: { ...baseEntry, role: 'passageiro', paidAmount: p.paidAmount || 0 } }
      })
    }
  } catch (err) {
    console.error('[saveRideHistory]', err.message)
  }
}

// ─── POST /api/rides — criar viagem ──────────────────────────────────────────
//
// 🔒 Requer onboarding Stripe concluído ANTES de criar viagem (qualquer preço).
// Isto evita criar viagens órfãs sem destinatário de pagamento configurado.
router.post('/', auth, requireOnboarding, async (req, res) => {
  try {
    const {
      vehicle, totalSeats, price, memberPrice,
      meetPoint, meetCoords, departureTime, bairro, zona,
      game, groupId,
    } = req.body

    if (!vehicle || !totalSeats || price == null || !meetPoint || !departureTime || !game) {
      return res.status(400).json({ error: 'Campos obrigatórios: vehicle, totalSeats, price, meetPoint, departureTime, game' })
    }
    if (!game.homeTeam || !game.awayTeam || !game.date || !game.stadium) {
      return res.status(400).json({ error: 'Dados do jogo incompletos (homeTeam, awayTeam, date, stadium)' })
    }
    if (!['carro', 'van', 'onibus'].includes(vehicle)) {
      return res.status(400).json({ error: 'Veículo inválido. Use: carro, van ou onibus' })
    }

    if (vehicle !== 'carro') {
      const leaderGroup = await Group.findOne({ leader: req.user.id })
      if (!leaderGroup) {
        return res.status(403).json({ error: 'Apenas líderes de grupo podem ofertar van ou ônibus' })
      }
    }

    const maxSeats = { carro: 4, van: 15, onibus: 50 }
    if (totalSeats < 1 || totalSeats > maxSeats[vehicle]) {
      return res.status(400).json({ error: `Vagas para ${vehicle}: 1 a ${maxSeats[vehicle]}` })
    }

    if (price < 0) return res.status(400).json({ error: 'Preço não pode ser negativo' })

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
      driverStripeAccountId: req.user.stripeAccountId || '', // snapshot
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
    const { team, zona, vehicle, status, code } = req.query

    if (code) {
      const ride = await Ride.findOne({ shareCode: code.toUpperCase() }).lean()
      if (!ride) return res.status(404).json({ error: 'Viagem não encontrada com esse código' })
      return res.json({
        rides: [{
          ...ride,
          availableSeats: ride.totalSeats - ride.passengers.filter(
            p => !['cancelled', 'no_show', 'unvalidated'].includes(p.status)
          ).length,
        }],
        total: 1,
      })
    }

    const filter = { status: status || 'open' }

    if (team) filter.$or = [
      { 'game.homeTeam': { $regex: new RegExp(team, 'i') } },
      { 'game.awayTeam': { $regex: new RegExp(team, 'i') } },
    ]
    if (zona) filter.zona = zona
    if (vehicle) filter.vehicle = vehicle

    filter.departureTime = { $gte: new Date() }

    const rides = await Ride.find(filter).sort({ departureTime: 1 }).limit(50).lean()

    const result = rides.map(r => ({
      ...r,
      availableSeats: r.totalSeats - r.passengers.filter(
        p => !['cancelled', 'no_show', 'unvalidated'].includes(p.status)
      ).length,
    }))

    res.json({ rides: result, total: result.length })
  } catch (err) {
    console.error('[GET /api/rides]', err.message)
    res.status(500).json({ error: 'Erro ao buscar viagens' })
  }
})

// ─── GET /api/rides/mine ─────────────────────────────────────────────────────
router.get('/mine', auth, async (req, res) => {
  try {
    const asDriver = await Ride.find({ driver: req.user.id }).sort({ departureTime: -1 }).limit(20).lean()
    const asPassenger = await Ride.find({ 'passengers.user': req.user.id }).sort({ departureTime: -1 }).limit(20).lean()
    res.json({ asDriver, asPassenger })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar suas viagens' })
  }
})

// ─── GET /api/rides/:id ──────────────────────────────────────────────────────
router.get('/:id', validId, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
    res.json({ ride })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar viagem' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/rides/:id/reserve — RESERVA SIMPLES (não usa Stripe)
//
// ⚠️ DEPRECATED para viagens pagas — use POST /api/payments/create-ride-payment-intent.
// Mantido apenas para reservas de viagens GRATUITAS (price = 0).
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/:id/reserve', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    if (ride.price > 0) {
      return res.status(400).json({
        error: 'Esta viagem é paga. Use o fluxo de pagamento Stripe.',
        code: 'PAID_RIDE_REQUIRES_STRIPE',
        action: 'POST /api/payments/create-ride-payment-intent',
      })
    }

    if (ride.status !== 'open') {
      return res.status(400).json({ error: 'Viagem não está aberta para reservas' })
    }
    if (String(ride.driver) === String(req.user.id)) {
      return res.status(400).json({ error: 'Você é o motorista desta viagem' })
    }

    const alreadyIn = ride.passengers.find(
      p => String(p.user) === String(req.user.id) &&
           !['cancelled', 'no_show', 'unvalidated'].includes(p.status)
    )
    if (alreadyIn) return res.status(400).json({ error: 'Você já tem uma reserva nesta viagem' })

    const active = ride.passengers.filter(
      p => !['cancelled', 'no_show', 'unvalidated'].includes(p.status)
    ).length
    if (active >= ride.totalSeats) return res.status(400).json({ error: 'Não há vagas disponíveis' })

    ride.passengers.push({
      user: req.user.id,
      name: req.user.name,
      handle: req.user.handle || '',
      status: 'confirmed',  // gratuita — confirmação imediata
      paidAmount: 0,
    })

    if (ride.passengers.filter(p => p.status !== 'cancelled').length >= ride.totalSeats) {
      ride.status = 'full'
    }

    await ride.save()
    res.status(201).json({ message: 'Vaga reservada (gratuita)!', ride })
  } catch (err) {
    console.error('[POST /rides/:id/reserve]', err.message)
    res.status(500).json({ error: 'Erro ao reservar vaga' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/rides/:id/cancel-reservation
// CENÁRIOS de cancelamento (TorcidaMATCH_Financeiro_Stripe — seção 7):
//
//   Cenário 1: > 24h antes da saída → estorno 100% (cancel PI)
//   Cenário 2: 2h–24h antes         → captura 30% (multa) + transfer 22% motorista
//   Cenário 3: < 2h ou no-show       → captura 80% + transfer 72% motorista
// ═══════════════════════════════════════════════════════════════════════════════
router.delete('/:id/cancel-reservation', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    const passenger = ride.passengers.find(
      p => String(p.user) === String(req.user.id) &&
           !['cancelled', 'no_show', 'unvalidated', 'confirmed'].includes(p.status)
    )
    if (!passenger) {
      return res.status(400).json({ error: 'Você não tem reserva ativa nesta viagem' })
    }

    const now = new Date()
    const departure = new Date(ride.departureTime)
    const hoursToDeparture = (departure - now) / (1000 * 60 * 60)

    let scenario, refundPct, capturePct, transferPct, severity
    if (hoursToDeparture > 24) {
      scenario = 1; refundPct = 1.00; capturePct = 0;    transferPct = 0;    severity = null
    } else if (hoursToDeparture >= CANCEL_DEADLINE_HOURS) {
      scenario = 2; refundPct = 0.70; capturePct = 0.30; transferPct = 0.22; severity = 'late'
    } else {
      scenario = 3; refundPct = 0.20; capturePct = 0.80; transferPct = 0.72; severity = 'noshow'
    }

    const amount = passenger.escrowAmount || passenger.paidAmount || 0

    // Executar conforme cenário
    if (passenger.paymentIntentId) {
      try {
        if (scenario === 1) {
          // Cancelar PI — estorno automático
          await stripe.paymentIntents.cancel(passenger.paymentIntentId)
        } else {
          // Capturar parcial — Stripe estorna o resto automaticamente
          const captureAmount = Math.round(amount * capturePct)
          await stripe.paymentIntents.capture(passenger.paymentIntentId, {
            amount_to_capture: captureAmount,
          })
          // Transferir parte ao motorista (se aplicável)
          if (transferPct > 0) {
            const driver = await User.findById(ride.driver).select('stripeAccountId')
            if (driver?.stripeAccountId) {
              await stripe.transfers.create({
                amount: Math.round(amount * transferPct),
                currency: 'brl',
                destination: driver.stripeAccountId,
                description: `Compensação cancelamento ${ride.shareCode}`,
                metadata: { rideId: String(ride._id), passengerId: String(req.user.id), scenario: String(scenario) },
              })
            }
          }
        }
      } catch (stripeErr) {
        console.error('[CANCEL-RESERVATION] Stripe:', stripeErr.message)
        return res.status(502).json({ error: 'Erro ao processar cancelamento no Stripe' })
      }
    }

    // Atualizar status
    passenger.status = scenario === 3 ? 'no_show' : 'cancelled'
    ride.escrowTotal -= amount
    if (ride.status === 'full') ride.status = 'open'
    await ride.save()

    // Transações imutáveis
    const refundAmount   = Math.round(amount * refundPct)
    const transferAmount = Math.round(amount * transferPct)
    const platformAmount = amount - refundAmount - transferAmount

    if (refundAmount > 0) {
      await Transaction.create({
        userId: req.user.id, type: 'ride_refund', direction: 'credit',
        amount: refundAmount, status: 'completed',
        description: `Reembolso (cenário ${scenario}) — viagem ${ride.shareCode}`,
        relatedId: ride._id, relatedType: 'ride',
        stripePaymentIntentId: passenger.paymentIntentId,
      }).catch(e => console.error('[CANCEL] tx refund:', e.message))
    }
    if (transferAmount > 0) {
      await Transaction.create({
        userId: ride.driver, type: 'ride_partial', direction: 'credit',
        amount: transferAmount, status: 'completed',
        description: `Compensação (cenário ${scenario}) — viagem ${ride.shareCode}`,
        relatedId: ride._id, relatedType: 'ride',
        stripePaymentIntentId: passenger.paymentIntentId,
      }).catch(e => console.error('[CANCEL] tx transfer:', e.message))
    }
    if (platformAmount > 0) {
      await Transaction.create({
        userId: req.user.id, type: 'platform_fee', direction: 'debit',
        amount: platformAmount, status: 'completed',
        description: `Taxa de cancelamento (cenário ${scenario}) — viagem ${ride.shareCode}`,
        relatedId: ride._id, relatedType: 'ride',
        stripePaymentIntentId: passenger.paymentIntentId,
        appCommission: platformAmount,
      }).catch(e => console.error('[CANCEL] tx fee:', e.message))
    }

    // Penalidade no perfil
    if (severity) {
      await penalties.registerPassengerNoShow(req.user.id, { rideId: ride._id }).catch(() => {})
    }

    // Notificações
    await Notification.create({
      user: req.user.id,
      type: 'reservation_cancelled',
      title: scenario === 1 ? 'Reembolso integral' : `Cancelamento — cenário ${scenario}`,
      message: scenario === 1
        ? `Sua reserva ${ride.shareCode} foi cancelada com 100% de estorno.`
        : `Reembolso de ${Math.round(refundPct * 100)}% processado para ${ride.shareCode}.`,
    }).catch(() => {})

    res.json({
      message: 'Reserva cancelada conforme política.',
      scenario,
      refund:   refundAmount,
      driver:   transferAmount,
      platform: platformAmount,
    })
  } catch (err) {
    console.error('[CANCEL-RESERVATION]', err.message)
    res.status(500).json({ error: 'Erro ao cancelar reserva' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/rides/:id/validate-code
//
// CENÁRIO 6 da tabela: viagem concluída com token validado.
// Motorista digita o código numérico de 6 dígitos do passageiro.
// → Backend valida com bcrypt.compare(código, paymentToken)
// → Captura 100% do PaymentIntent → Stripe deduz 8% e repassa 92% ao motorista
// → Status do passageiro: 'confirmed'
// → +5 pontos de score para o passageiro
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/:id/validate-code', auth, validId, async (req, res) => {
  const { code } = req.body
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Código obrigatório' })
  }
  const normalized = code.trim().toUpperCase()

  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o motorista pode validar códigos' })
    }

    const VALIDATABLE = ['authorized', 'paid']
    let passenger = null

    // 1. Tentar match pelo código numérico (bcrypt) — fluxo NOVO
    if (/^\d{6}$/.test(code.trim())) {
      for (const p of ride.passengers) {
        if (!VALIDATABLE.includes(p.status) || !p.paymentToken) continue
        const ok = await bcrypt.compare(code.trim(), p.paymentToken)
        if (ok) { passenger = p; break }
      }
    }

    // 2. Fallback: match pelo TM-XXXX (legado)
    if (!passenger) {
      passenger = ride.passengers.find(
        p => p.validationCode === normalized && VALIDATABLE.includes(p.status)
      )
    }

    if (!passenger) {
      const already = ride.passengers.find(
        p => (p.validationCode === normalized && p.status === 'confirmed')
      )
      if (already) {
        return res.json({
          message: `${already.name} já foi validado anteriormente.`,
          passengerName: already.name,
          alreadyConfirmed: true,
        })
      }
      return res.status(404).json({ error: 'Código inválido. Verifique e tente novamente.' })
    }

    // Verificar prazo de validade do token
    if (passenger.tokenExpiresAt && new Date() > passenger.tokenExpiresAt) {
      return res.status(400).json({
        error: 'Token expirado. A viagem será processada como sem_validacao automaticamente.',
        code: 'TOKEN_EXPIRED',
      })
    }

    // Capturar PI (escrow → liberado)
    let capturedAmount = passenger.escrowAmount || passenger.paidAmount || 0
    if (passenger.paymentIntentId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(passenger.paymentIntentId)
        if (pi.status === 'requires_capture') {
          const captured = await stripe.paymentIntents.capture(passenger.paymentIntentId)
          capturedAmount = captured.amount_received
        } else if (pi.status === 'succeeded') {
          capturedAmount = pi.amount_received || pi.amount
        }
      } catch (stripeErr) {
        console.error('[VALIDATE-CODE] Stripe retrieve/capture:', stripeErr.message)
      }
    }

    passenger.status = 'confirmed'
    passenger.capturedAt = new Date()
    passenger.processadoEm = new Date()
    await ride.save()

    // Transações imutáveis (motorista creditado pelo Stripe via transfer_data)
    const platformFee  = Math.round(capturedAmount * RIDE_FEE_PCT)
    const driverCredit = capturedAmount - platformFee

    await Transaction.create({
      userId:                ride.driver,
      type:                  'ride_earn',
      direction:             'credit',
      amount:                driverCredit,
      status:                'completed',
      description:           `Embarque confirmado — ${passenger.name} | viagem ${ride.shareCode}`,
      relatedId:             ride._id,
      relatedType:           'ride',
      stripePaymentIntentId: passenger.paymentIntentId,
      appCommission:         platformFee,
    }).catch(e => console.error('[VALIDATE-CODE] tx driver:', e.message))

    await Transaction.findOneAndUpdate(
      { stripePaymentIntentId: passenger.paymentIntentId, type: 'ride_reserve' },
      { status: 'completed' }
    ).catch(() => {})

    // +5 pontos para passageiro
    penalties.registerRideCompleted(passenger.user).catch(() => {})

    // Notificações
    await Promise.allSettled([
      Notification.create({
        user: passenger.user, type: 'ride_code_validated',
        title: 'Embarque confirmado!',
        message: `O motorista confirmou seu embarque na viagem ${ride.shareCode}. Boa viagem! 🚗`,
      }),
      Notification.create({
        user: ride.driver, type: 'ride_payment_captured',
        title: 'Pagamento recebido!',
        message: `R$ ${(driverCredit / 100).toFixed(2)} repassado pelo embarque de ${passenger.name}.`,
        fromUser: passenger.user, fromName: passenger.name,
      }),
    ])

    res.json({
      message: `✅ ${passenger.name} confirmado! R$ ${(driverCredit / 100).toFixed(2)} repassado.`,
      passengerName: passenger.name,
      credited: driverCredit,
      creditedFormatted: `R$ ${(driverCredit / 100).toFixed(2)}`,
    })
  } catch (err) {
    if (err.type === 'StripeInvalidRequestError' && err.code === 'payment_intent_unexpected_state') {
      return res.status(400).json({ error: 'Pagamento não está em estado capturável.' })
    }
    if (err.type?.startsWith('Stripe')) {
      console.error('[VALIDATE-CODE] Stripe:', err.message)
      return res.status(502).json({ error: 'Erro ao processar pagamento.' })
    }
    console.error('[VALIDATE-CODE]', err.message)
    res.status(500).json({ error: 'Erro ao validar código' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/rides/:id/confirm/driver
// Motorista confirma execução da viagem (independente da captura por código).
// Usado quando há passageiros sem código (legado).
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/:id/confirm/driver', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o motorista pode confirmar' })
    }
    if (ride.driverConfirmed) return res.status(400).json({ error: 'Você já confirmou esta viagem' })

    ride.driverConfirmed = true
    ride.driverConfirmedAt = new Date()

    const activePassengers = ride.passengers.filter(p => ['paid', 'confirmed'].includes(p.status))
    const allConfirmed = activePassengers.length > 0 &&
      activePassengers.every(p => p.status === 'confirmed')

    if (allConfirmed) {
      ride.status = 'completed'
      const commission = Math.round(ride.escrowTotal * RIDE_FEE_PCT)
      ride.appCommission = commission
      ride.releasedTotal = ride.escrowTotal - commission
      await saveRideHistory(ride)
    } else {
      ride.status = 'in_progress'
    }

    await ride.save()

    res.json({
      message: ride.status === 'completed' ? 'Viagem concluída!' : 'Confirmação registrada.',
      ride,
    })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao confirmar viagem' })
  }
})

// ─── POST /api/rides/:id/confirm/passenger ───────────────────────────────────
router.post('/:id/confirm/passenger', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })

    const passenger = ride.passengers.find(
      p => String(p.user) === String(req.user.id) && ['paid', 'reserved', 'authorized'].includes(p.status)
    )
    if (!passenger) return res.status(400).json({ error: 'Você não tem reserva ativa nesta viagem' })

    passenger.status = 'confirmed'
    passenger.confirmedAt = new Date()

    const activePassengers = ride.passengers.filter(p => ['paid', 'confirmed', 'authorized'].includes(p.status))
    const allConfirmed = activePassengers.every(p => p.status === 'confirmed')

    if (ride.driverConfirmed && allConfirmed) {
      ride.status = 'completed'
      const commission = Math.round(ride.escrowTotal * RIDE_FEE_PCT)
      ride.appCommission = commission
      ride.releasedTotal = ride.escrowTotal - commission
      await saveRideHistory(ride)
    }

    await ride.save()
    res.json({
      message: ride.status === 'completed' ? 'Viagem concluída!' : 'Confirmação registrada.',
      ride,
    })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao confirmar viagem' })
  }
})

// ─── PUT /api/rides/:id ──────────────────────────────────────────────────────
router.put('/:id', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o motorista pode editar' })
    }
    if (['completed', 'cancelled'].includes(ride.status)) {
      return res.status(400).json({ error: 'Viagem finalizada não pode ser editada' })
    }

    const { vehicle, totalSeats, price, memberPrice, meetPoint, meetCoords, departureTime, bairro, zona } = req.body

    if (vehicle) {
      if (!['carro', 'van', 'onibus'].includes(vehicle)) {
        return res.status(400).json({ error: 'Veículo inválido' })
      }
      if (vehicle !== 'carro') {
        const leaderGroup = await Group.findOne({ leader: req.user.id })
        if (!leaderGroup) return res.status(403).json({ error: 'Apenas líderes podem usar van ou ônibus' })
      }
      ride.vehicle = vehicle
    }

    if (totalSeats != null) {
      const activeCount = ride.passengers.filter(p => p.status !== 'cancelled').length
      if (totalSeats < activeCount) {
        return res.status(400).json({ error: `Não é possível reduzir abaixo de ${activeCount} passageiros confirmados.` })
      }
      const maxSeats = { carro: 4, van: 15, onibus: 50 }
      const veh = vehicle || ride.vehicle
      if (totalSeats < 1 || totalSeats > maxSeats[veh]) {
        return res.status(400).json({ error: `Vagas para ${veh}: 1 a ${maxSeats[veh]}` })
      }
      ride.totalSeats = totalSeats
      if (activeCount >= totalSeats) ride.status = 'full'
      else if (ride.status === 'full') ride.status = 'open'
    }

    if (price != null) {
      if (price < 0) return res.status(400).json({ error: 'Preço inválido' })
      ride.price = Math.round(price)
    }
    if (memberPrice !== undefined) {
      ride.memberPrice = memberPrice != null ? Math.round(memberPrice) : null
    }
    if (meetPoint) ride.meetPoint = sanitize(meetPoint)
    if (meetCoords) ride.meetCoords = meetCoords
    if (departureTime) ride.departureTime = new Date(departureTime)
    if (bairro !== undefined) ride.bairro = sanitize(bairro || '')
    if (zona !== undefined) ride.zona = sanitize(zona || '')

    await ride.save()
    res.json({ message: 'Viagem atualizada!', ride })
  } catch (err) {
    console.error('[PUT /rides/:id]', err.message)
    res.status(500).json({ error: 'Erro ao editar viagem' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/rides/:id  →  Motorista cancela a viagem (Cenário 5)
// Estorno 100% para todos os passageiros + penalidade no perfil do motorista
// ═══════════════════════════════════════════════════════════════════════════════
router.delete('/:id', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o motorista pode cancelar' })
    }
    if (ride.status === 'completed') {
      return res.status(400).json({ error: 'Viagem já concluída' })
    }

    // É no dia do jogo? penalidade dupla
    const now = new Date()
    const sameDay = (
      now.getFullYear() === ride.game.date.getFullYear() &&
      now.getMonth()    === ride.game.date.getMonth() &&
      now.getDate()     === ride.game.date.getDate()
    )

    // Estornar todos os passageiros (cenário 5)
    for (const p of ride.passengers) {
      if (['cancelled', 'no_show', 'unvalidated', 'confirmed'].includes(p.status)) continue
      if (p.paymentIntentId) {
        try {
          const pi = await stripe.paymentIntents.retrieve(p.paymentIntentId)
          if (pi.status === 'requires_capture') {
            await stripe.paymentIntents.cancel(p.paymentIntentId)
          } else if (pi.status === 'succeeded') {
            await stripe.refunds.create({ payment_intent: p.paymentIntentId })
          }
        } catch (e) {
          console.error('[DELETE-RIDE] estorno:', e.message)
        }
      }
      p.status = 'cancelled'

      await Transaction.create({
        userId: p.user, type: 'ride_refund', direction: 'credit',
        amount: p.escrowAmount || p.paidAmount || 0, status: 'completed',
        description: `Estorno integral — motorista cancelou ${ride.shareCode}`,
        relatedId: ride._id, relatedType: 'ride',
        stripePaymentIntentId: p.paymentIntentId,
      }).catch(() => {})

      Notification.create({
        user: p.user, type: 'ride_cancelled_by_driver',
        title: 'Viagem cancelada pelo motorista',
        message: `A viagem ${ride.shareCode} foi cancelada. Reembolso integral processado.`,
      }).catch(() => {})
    }

    ride.status = 'cancelled'
    ride.escrowTotal = 0
    await ride.save()

    // Penalidade no motorista
    await penalties.registerDriverCancellation(req.user.id, {
      rideId: ride._id,
      severity: sameDay ? 'sameday' : 'late',
    }).catch(() => {})

    res.json({ message: 'Viagem cancelada. Passageiros reembolsados integralmente.', ride })
  } catch (err) {
    console.error('[DELETE /rides/:id]', err.message)
    res.status(500).json({ error: 'Erro ao cancelar viagem' })
  }
})

// ─── PATCH /api/rides/:id/passengers/:passengerId/return ────────────────────
router.patch('/:id/passengers/:passengerId/return', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o motorista pode avaliar a volta' })
    }
    if (!['in_progress', 'completed'].includes(ride.status)) {
      return res.status(400).json({ error: 'Avaliação só após início da viagem' })
    }

    const passenger = ride.passengers.id(req.params.passengerId)
    if (!passenger || passenger.status === 'cancelled') {
      return res.status(404).json({ error: 'Passageiro não encontrado' })
    }

    const { approved, note = '' } = req.body
    if (typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'Campo "approved" obrigatório' })
    }

    passenger.returnApproved    = approved
    passenger.returnNote        = String(note).slice(0, 200)
    passenger.returnEvaluatedAt = new Date()
    await ride.save()

    res.json({
      message: approved ? `${passenger.name} aprovado para a volta!` : `${passenger.name} sem volta garantida.`,
      passenger,
    })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao avaliar volta' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// 💬 Chat da viagem
// ═══════════════════════════════════════════════════════════════════════════════
function canAccessRideChat(ride, userId) {
  if (String(ride.driver) === String(userId)) return true
  return ride.passengers.some(
    p => String(p.user) === String(userId) && ['paid', 'confirmed', 'authorized'].includes(p.status)
  )
}

router.get('/:id/messages', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
    if (!canAccessRideChat(ride, req.user.id)) {
      return res.status(403).json({ error: 'Apenas motorista e passageiros confirmados' })
    }
    const messages = await RideMessage.find({ ride: req.params.id }).sort({ createdAt: 1 }).limit(100).lean()
    res.json({ messages })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar mensagens' })
  }
})

router.post('/:id/messages', validId, auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
    if (!canAccessRideChat(ride, req.user.id)) {
      return res.status(403).json({ error: 'Apenas motorista e passageiros confirmados' })
    }

    const text = sanitize((req.body.text || '').trim())
    if (!text || text.length > 1000) {
      return res.status(400).json({ error: 'Mensagem inválida (1-1000 caracteres)' })
    }

    const message = await RideMessage.create({
      ride: req.params.id, sender: req.user.id, senderName: req.user.name,
      text, type: 'text', expiresAt: ride.expiresAt || null,
    })

    if (req.app.locals.wsRideBroadcast) {
      req.app.locals.wsRideBroadcast(req.params.id, { type: 'ride-message', message: message.toObject() })
    }
    res.status(201).json({ message: message.toObject() })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao enviar mensagem' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/rides/:id/confirm-legacy
// Confirma manualmente passageiros sem código (reservas antigas)
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/:id/confirm-legacy', auth, validId, async (req, res) => {
  const { passengerId } = req.body
  if (!passengerId) return res.status(400).json({ error: 'passengerId obrigatório' })

  try {
    const ride = await Ride.findById(req.params.id)
    if (!ride) return res.status(404).json({ error: 'Viagem não encontrada' })
    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Apenas o motorista pode confirmar embarques' })
    }

    const passenger = ride.passengers.id(passengerId)
    if (!passenger) return res.status(404).json({ error: 'Passageiro não encontrado' })
    if (passenger.status === 'confirmed') {
      return res.json({ message: `${passenger.name} já foi confirmado.`, alreadyConfirmed: true })
    }
    if (!['authorized', 'paid', 'reserved'].includes(passenger.status)) {
      return res.status(400).json({ error: 'Status não permite confirmação' })
    }

    let capturedAmount = passenger.paidAmount || 0
    if (passenger.paymentIntentId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(passenger.paymentIntentId)
        if (pi.status === 'requires_capture') {
          const captured = await stripe.paymentIntents.capture(passenger.paymentIntentId)
          capturedAmount = captured.amount_received
        } else if (pi.status === 'succeeded') {
          capturedAmount = pi.amount_received || pi.amount
        }
      } catch (e) { console.error('[CONFIRM-LEGACY]', e.message) }
    }

    passenger.status = 'confirmed'
    passenger.capturedAt = new Date()
    await ride.save()

    const platformFee = Math.round(capturedAmount * RIDE_FEE_PCT)
    const driverCredit = capturedAmount - platformFee

    if (driverCredit > 0) {
      await Transaction.create({
        userId: ride.driver, type: 'ride_earn', direction: 'credit',
        amount: driverCredit, status: 'completed',
        description: `Embarque manual — ${passenger.name} | viagem ${ride.shareCode}`,
        relatedId: ride._id, relatedType: 'ride',
        stripePaymentIntentId: passenger.paymentIntentId || '',
        appCommission: platformFee,
      }).catch(() => {})
    }

    res.json({
      message: `✅ ${passenger.name} confirmado!`,
      passengerName: passenger.name,
      credited: driverCredit,
    })
  } catch (err) {
    console.error('[CONFIRM-LEGACY]', err.message)
    res.status(500).json({ error: 'Erro ao confirmar embarque' })
  }
})

module.exports = router
