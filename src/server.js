require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')

const authRoutes    = require('./routes/auth')
const profileRoutes = require('./routes/profile')
const bsdProxy      = require('./routes/bsdProxy')

const app  = express()
// Railway usa a variável de ambiente PORT, se não houver, usa 3001
const PORT = process.env.PORT || 3001

// ─── Middleware ───────────────────────────────────────────────────────────────

// Unificando o CORS: configuramos para aceitar o que estiver no .env ou localhost
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = [
      process.env.CLIENT_URL,
      'http://localhost:5173', // Vite padrão
      'http://localhost:3000'  // CRA padrão
    ];
    
    // Permite requisições sem origin (como aplicativos mobile ou ferramentas de teste)
    // ou se a origin estiver na lista, ou se terminar em .railway.app
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.railway.app') || origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error('Bloqueado pelo CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ─── Rotas ────────────────────────────────────────────────────────────────────

// Status rápido para teste
app.get('/api/status', (req, res) => {
  res.json({ status: 'OK', message: 'API funcionando!', env: process.env.NODE_ENV });
});

app.use('/api/auth',    authRoutes)
app.use('/api/profile', profileRoutes)
app.use('/api/bsd',     bsdProxy)

// Health check para Railway
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'TorcidaMatch API',
    time: new Date().toISOString(),
  })
})

// 404 - Deve ser a última rota
app.use((req, res) => {
  res.status(404).json({ error: `Rota ${req.method} ${req.path} não encontrada` })
})

// ─── Conexão ──────────────────────────────────────────────────────────────────
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
