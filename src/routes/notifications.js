const express = require('express')
const router = express.Router()
const Notification = require('../models/Notification')
const auth = require('../middleware/auth')

// ─── GET /api/notifications — listar minhas notificações ─────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const notifications = await Notification.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()

    res.json({ notifications })
  } catch (err) {
    console.error('[GET /notifications]', err.message)
    res.status(500).json({ error: 'Erro ao buscar notificações' })
  }
})

// ─── GET /api/notifications/unread-count — contagem de não lidas ─────────────
router.get('/unread-count', auth, async (req, res) => {
  try {
    const count = await Notification.countDocuments({ user: req.user.id, read: false })
    res.json({ count })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao contar notificações' })
  }
})

// ─── POST /api/notifications/:id/read — marcar como lida ────────────────────
router.post('/:id/read', auth, async (req, res) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { read: true }
    )
    res.json({ message: 'Marcada como lida' })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao marcar notificação' })
  }
})

// ─── POST /api/notifications/read-all — marcar todas como lidas ──────────────
router.post('/read-all', auth, async (req, res) => {
  try {
    await Notification.updateMany({ user: req.user.id, read: false }, { read: true })
    res.json({ message: 'Todas marcadas como lidas' })
  } catch (err) {
    res.status(500).json({ error: 'Erro ao marcar notificações' })
  }
})

module.exports = router
