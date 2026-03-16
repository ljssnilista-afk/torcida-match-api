const express = require('express')
const jwt = require('jsonwebtoken')
const User = require('../models/User')

const router = express.Router()

// ─── Gera JWT ──────────────────────────────────────────────────────────────────
function generateToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '30d' })
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, age, bairro, zona, handle, email, password, team, teamId, teamEmoji } = req.body

    // Validações básicas
    if (!name || !age || !bairro || !zona || !handle || !email || !password) {
      return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' })
    }
    if (age < 13 || age > 100) {
      return res.status(400).json({ error: 'Idade inválida' })
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' })
    }

    // Limpa o @ do handle se vier com ele
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim()

    // Verifica duplicidade
    const existing = await User.findOne({
      $or: [
        { email: email.toLowerCase().trim() },
        { handle: cleanHandle },
      ]
    })
    if (existing) {
      if (existing.email === email.toLowerCase().trim()) {
        return res.status(400).json({ error: 'E-mail já cadastrado', field: 'email' })
      }
      return res.status(400).json({ error: `@${cleanHandle} já está em uso`, field: 'handle' })
    }

    // Cria usuário
    const user = await User.create({
      name:      name.trim(),
      age:       parseInt(age),
      bairro:    bairro.trim(),
      zona:      zona.trim(),
      handle:    cleanHandle,
      email:     email.toLowerCase().trim(),
      password,
      team:      team ?? '',
      teamId:    teamId ?? '',
      teamEmoji: teamEmoji ?? '',
    })

    const token = generateToken(user._id)

    res.status(201).json({
      message: 'Usuário criado com sucesso',
      token,
      user: user.toPublicJSON(),
    })
  } catch (err) {
    console.error('[POST /register]', err)
    res.status(500).json({ error: 'Erro interno do servidor' })
  }
})

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios' })
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() })
    if (!user) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos' })
    }

    const isMatch = await user.comparePassword(password)
    if (!isMatch) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos' })
    }

    const token = generateToken(user._id)

    res.json({
      message: 'Login realizado com sucesso',
      token,
      user: user.toPublicJSON(),
    })
  } catch (err) {
    console.error('[POST /login]', err)
    res.status(500).json({ error: 'Erro interno do servidor' })
  }
})

// ─── GET /api/auth/check-handle/:handle ───────────────────────────────────────
// Verifica disponibilidade do handle em tempo real
router.get('/check-handle/:handle', async (req, res) => {
  try {
    const handle = req.params.handle.replace(/^@/, '').toLowerCase().trim()
    if (!handle || handle.length < 3) {
      return res.status(400).json({ error: 'Handle inválido' })
    }
    const existing = await User.findOne({ handle })
    res.json({ available: !existing, handle: `@${handle}` })
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' })
  }
})

module.exports = router
