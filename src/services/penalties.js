/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Sistema de Penalidades + Score de Confiabilidade
 * (TorcidaMATCH_Financeiro_Stripe — seção 10)
 *
 * Score público:
 *   +5  Viagem concluída com token validado
 *   −10 Cancelamento tardio (2h–24h)
 *   −20 No-show
 *   −30 Motorista cancela no dia do jogo
 *
 * Penalidades automáticas:
 *
 * Motorista
 *   1º cancelamento: aviso registrado
 *   2º cancelamento em 30 dias: badge amarelo
 *   3º cancelamento: suspensão 7 dias para CRIAR viagens
 *   5º cancelamento: conta sob revisão (accountUnderReview = true)
 *   Cancelamento no dia: penalidade dupla
 *
 * Passageiro
 *   2 no-shows em 60 dias: aviso
 *   3 no-shows: bloqueio 14 dias para reservas
 *   Chargeback indevido: suspensão imediata
 * ═══════════════════════════════════════════════════════════════════════════════
 */
const User = require('../models/User')
const Notification = require('../models/Notification')

const SCORE_DELTAS = {
  ride_completed:      +5,
  late_cancellation:   -10,
  no_show:             -20,
  driver_sameday:      -30,
  chargeback:          -50,
}

/**
 * Aplicar delta no score (clamp 0..200) — operação atômica via $inc.
 */
async function adjustScore(userId, reason) {
  const delta = SCORE_DELTAS[reason]
  if (delta === undefined) return null

  // $inc + saturação
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { score: delta } },
    { new: true, select: 'score' }
  )
  if (!user) return null

  // Saturar score em [0, 200]
  if (user.score < 0 || user.score > 200) {
    user.score = Math.max(0, Math.min(200, user.score))
    await user.save()
  }
  return user.score
}

/**
 * Registrar cancelamento de motorista e aplicar penalidades automáticas.
 *
 * @param {ObjectId} userId    motorista
 * @param {Object}   meta      { rideId, severity: 'late' | 'sameday' | 'noshow' }
 */
async function registerDriverCancellation(userId, meta = {}) {
  const { rideId, severity = 'late' } = meta
  const now = new Date()

  const user = await User.findById(userId)
  if (!user) return null

  // Adiciona ao histórico recente (90 dias)
  user.cancelamentos = (user.cancelamentos || 0) + 1
  user.cancelamentosRecentes = (user.cancelamentosRecentes || []).filter(
    c => now - c.at < 90 * 24 * 60 * 60 * 1000
  )
  user.cancelamentosRecentes.push({ at: now, role: 'driver', severity, rideId })

  // Conta cancelamentos nos últimos 30 dias
  const last30 = user.cancelamentosRecentes.filter(
    c => c.role === 'driver' && (now - c.at < 30 * 24 * 60 * 60 * 1000)
  ).length

  // Score
  if (severity === 'sameday') {
    user.score = Math.max(0, (user.score || 0) - 30)
  } else if (severity === 'late') {
    user.score = Math.max(0, (user.score || 0) - 10)
  }

  // Penalidades automáticas
  let action = null
  if (user.cancelamentos >= 5) {
    user.accountUnderReview = true
    user.suspensionReason = '5+ cancelamentos — conta sob revisão'
    action = 'review'
  } else if (last30 >= 3) {
    user.suspendedUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    user.suspensionReason = '3 cancelamentos em 30 dias — suspensão 7 dias'
    action = 'suspend_7d'
  } else if (last30 >= 2) {
    action = 'badge_yellow'
  } else {
    action = 'warning'
  }

  await user.save()

  // Notificação
  await Notification.create({
    user: userId,
    type: 'driver_penalty',
    title: action === 'suspend_7d' ? 'Conta suspensa por 7 dias'
        : action === 'review' ? 'Conta sob revisão'
        : action === 'badge_yellow' ? 'Aviso: 2º cancelamento em 30 dias'
        : 'Cancelamento registrado',
    message: user.suspensionReason || 'Cancelamento registrado no seu histórico.',
  }).catch(() => {})

  return { action, score: user.score, last30, total: user.cancelamentos }
}

/**
 * Registrar no-show de passageiro.
 */
async function registerPassengerNoShow(userId, meta = {}) {
  const { rideId } = meta
  const now = new Date()

  const user = await User.findById(userId)
  if (!user) return null

  user.noShows = (user.noShows || 0) + 1
  user.cancelamentosRecentes = (user.cancelamentosRecentes || []).filter(
    c => now - c.at < 90 * 24 * 60 * 60 * 1000
  )
  user.cancelamentosRecentes.push({ at: now, role: 'passenger', severity: 'noshow', rideId })

  user.score = Math.max(0, (user.score || 0) - 20)

  // 3 no-shows em 60 dias → bloqueio 14 dias
  const last60NoShows = user.cancelamentosRecentes.filter(
    c => c.role === 'passenger' && c.severity === 'noshow' && (now - c.at < 60 * 24 * 60 * 60 * 1000)
  ).length

  let action = 'warning'
  if (last60NoShows >= 3) {
    user.suspendedUntil = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
    user.suspensionReason = '3 no-shows em 60 dias — bloqueio 14 dias para reservas'
    action = 'block_14d'
  } else if (last60NoShows >= 2) {
    action = 'warning_strong'
  }

  await user.save()

  await Notification.create({
    user: userId,
    type: 'passenger_penalty',
    title: action === 'block_14d' ? 'Reservas bloqueadas por 14 dias' : 'Aviso de no-show',
    message: user.suspensionReason || 'No-show registrado no seu perfil.',
  }).catch(() => {})

  return { action, score: user.score, last60: last60NoShows, total: user.noShows }
}

/**
 * Registrar chargeback (disputa com o banco) — suspensão imediata.
 */
async function registerChargeback(userId, meta = {}) {
  const user = await User.findById(userId)
  if (!user) return null

  user.score = Math.max(0, (user.score || 0) - 50)
  user.accountUnderReview = true
  user.suspendedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  user.suspensionReason = 'Chargeback aberto — conta suspensa para revisão manual'
  await user.save()

  await Notification.create({
    user: userId,
    type: 'chargeback_opened',
    title: 'Conta suspensa',
    message: 'Foi aberto um chargeback no seu pagamento. Sua conta foi suspensa para revisão.',
  }).catch(() => {})

  return { action: 'suspend_chargeback', score: user.score }
}

/**
 * Registrar viagem concluída com token validado (+5 score).
 */
async function registerRideCompleted(userId) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { score: SCORE_DELTAS.ride_completed } },
    { new: true, select: 'score' }
  )
  if (user && user.score > 200) {
    user.score = 200
    await user.save()
  }
  return user?.score
}

module.exports = {
  adjustScore,
  registerDriverCancellation,
  registerPassengerNoShow,
  registerChargeback,
  registerRideCompleted,
  SCORE_DELTAS,
}
