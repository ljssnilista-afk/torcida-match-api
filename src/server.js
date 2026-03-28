require('dotenv').config()
const express    = require('express')
const mongoose   = require('mongoose')
const cors       = require('cors')
const http       = require('http')
const { WebSocketServer } = require('ws')

const authRoutes    = require('./routes/auth')
const profileRoutes = require('./routes/profile')
const bsdProxy      = require('./routes/bsdProxy')
const gruposRoutes  = require('./routes/grupos')

const app    = express()
const server = http.createServer(app)
const PORT   = process.env.PORT || 3001

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws/grupos' })

// Mapa: grupoId → Set de clientes WS conectados
const rooms = new Map()

wss.on('connection', (ws, req) => {
  // Extrai ID do grupo da URL: /ws/grupos/:id
  const grupoId = req.url.split('/ws/grupos/')[1]?.split('?')[0]
  if (!grupoId) return ws.close()

  if (!rooms.has(grupoId)) rooms.set(grupoId, new Set())
  rooms.get(grupoId).add(ws)
  console.log(`[WS] Cliente conectado ao grupo ${grupoId} (${rooms.get(grupoId).size} total)`)

  ws.on('close', () => {
    rooms.get(grupoId)?.delete(ws)
    if (rooms.get(grupoId)?.size === 0) rooms.delete(grupoId)
  })

  ws.on('error', () => rooms.get(grupoId)?.delete(ws))
})

// Função broadcast disponível nas rotas via app.locals
app.locals.wsBroadcast = (grupoId, payload) => {
  const clients = rooms.get(grupoId)
  if (!clients) return
  const data = JSON.stringify(payload)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data)
  }
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: function (origin, callback) {
    const allowed = [
      process.env.CLIENT_URL,
      'http://localhost:5173',
      'http://localhost:3000',
    ]
    if (!origin || allowed.includes(origin)
      || origin.endsWith('.railway.app')
      || origin.endsWith('.onrender.com')
      || origin.endsWith('.vercel.app')) {
      callback(null, true)
    } else {
      callback(new Error('Bloqueado pelo CORS'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ status: 'OK', message: 'API funcionando!', env: process.env.NODE_ENV })
})

app.use('/api/auth',    authRoutes)
app.use('/api/profile', profileRoutes)
app.use('/api/bsd',     bsdProxy)
app.use('/api/grupos',  gruposRoutes)

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'TorcidaMatch API', time: new Date().toISOString() })
})

app.use((req, res) => {
  res.status(404).json({ error: `Rota ${req.method} ${req.path} não encontrada` })
})

// ─── Conexão ──────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB conectado')
    server.listen(PORT, () => {
      console.log(`🚀 TorcidaMatch API rodando na porta ${PORT}`)
      console.log(`🔌 WebSocket ativo em ws://localhost:${PORT}/ws/grupos`)
    })
  })
  .catch((err) => {
    console.error('❌ Erro ao conectar ao MongoDB:', err.message)
    process.exit(1)
  })
