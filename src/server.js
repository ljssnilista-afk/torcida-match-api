require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')

const authRoutes    = require('./routes/auth')
const profileRoutes = require('./routes/profile')

const app  = express()
const PORT = process.env.PORT || 3001

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.CLIENT_URL ?? 'http://localhost:5173',
    /\.railway\.app$/,   // Railway deploy
    /\.onrender\.com$/,  // Render deploy
  ],
  credentials: true,
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes)
app.use('/api/profile', profileRoutes)

// Health check (Railway/Render usam isso para verificar se o serviço está vivo)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app:    'TorcidaMatch API',
    time:   new Date().toISOString(),
  })
})

// 404
app.use((req, res) => {
  res.status(404).json({ error: `Rota ${req.method} ${req.path} não encontrada` })
})

// ─── Conecta ao MongoDB e sobe o servidor ─────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB conectado')
    app.listen(PORT, () => {
      console.log(`🚀 TorcidaMatch API rodando na porta ${PORT}`)
    })
  })
  .catch((err) => {
    console.error('❌ Erro ao conectar ao MongoDB:', err.message)
    process.exit(1)
  })
