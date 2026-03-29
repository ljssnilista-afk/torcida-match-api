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
const newsRoutes    = require('./routes/news')

const app    = express()
const server = http.createServer(app)
const PORT   = process.env.PORT || 3001

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss   = new WebSocketServer({ server, path: '/ws/grupos' })
const rooms = new Map()

wss.on('connection', (ws, req) => {
  const grupoId = req.url.split('/ws/grupos/')[1]?.split('?')[0]
  if (!grupoId) return ws.close()
  if (!rooms.has(grupoId)) rooms.set(grupoId, new Set())
  rooms.get(grupoId).add(ws)
  ws.on('close', () => {
    rooms.get(grupoId)?.delete(ws)
    if (rooms.get(grupoId)?.size === 0) rooms.delete(grupoId)
  })
  ws.on('error', () => rooms.get(grupoId)?.delete(ws))
})

app.locals.wsBroadcast = (grupoId, payload) => {
  const clients = rooms.get(grupoId)
  if (!clients) return
  const data = JSON.stringify(payload)
  for (const ws of clients) if (ws.readyState === 1) ws.send(data)
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    const allowed = [
      process.env.CLIENT_URL,
      'http://localhost:5173',
      'http://localhost:3000',
    ]
    if (!origin || allowed.includes(origin)
      || origin.endsWith('.railway.app')
      || origin.endsWith('.onrender.com')
      || origin.endsWith('.vercel.app')) cb(null, true)
    else cb(new Error('Bloqueado pelo CORS'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) =>
  res.json({ status: 'OK', message: 'API funcionando!', env: process.env.NODE_ENV }))

app.use('/api/auth',    authRoutes)
app.use('/api/profile', profileRoutes)
app.use('/api/bsd',     bsdProxy)
app.use('/api/grupos',  gruposRoutes)
app.use('/api/news',    newsRoutes)

app.get('/health', (req, res) =>
  res.json({ status: 'ok', app: 'TorcidaMatch API', time: new Date().toISOString() }))

app.use((req, res) =>
  res.status(404).json({ error: `Rota ${req.method} ${req.path} não encontrada` }))

// ─── Conexão ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB conectado')
    server.listen(PORT, () => {
      console.log(`🚀 TorcidaMatch API rodando na porta ${PORT}`)
      console.log(`🔌 WebSocket ativo`)
    })
  })
  .catch(err => {
    console.error('❌ Erro MongoDB:', err.message)
    process.exit(1)
  })
