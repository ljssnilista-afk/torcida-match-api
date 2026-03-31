require('dotenv').config()
const express    = require('express')
const mongoose   = require('mongoose')
const cors       = require('cors')
const http       = require('http')
const { WebSocketServer } = require('ws')
const jwt        = require('jsonwebtoken')        // 🔒 NOVO — para validar JWT no WebSocket
const helmet     = require('helmet')               // 🔒 NOVO — headers de segurança
const rateLimit  = require('express-rate-limit')   // 🔒 NOVO — proteção contra brute force

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
  // 🔒 NOVO — Validar JWT na conexão WebSocket
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const token = url.searchParams.get('token')

    if (!token) {
      ws.close(4001, 'Token não fornecido')
      return
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    ws.userId = decoded.id // armazena o userId no socket para uso futuro
  } catch (err) {
    ws.close(4001, 'Token inválido ou expirado')
    return
  }

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

// ─── Segurança ────────────────────────────────────────────────────────────────
app.use(helmet()) // 🔒 NOVO — headers de segurança (X-Content-Type-Options, etc.)

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    const allowed = [
      process.env.CLIENT_URL,
      'http://localhost:5173',
      'http://localhost:3000',
    ]
    // 🔒 MELHORADO — removido wildcard *.vercel.app e *.railway.app
    // Só permite seu domínio específico + localhost
    if (!origin || allowed.includes(origin)) cb(null, true)
    else cb(new Error('Bloqueado pelo CORS'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// 🔒 MELHORADO — body parser com limite de tamanho
app.use(express.json({ limit: '500kb' }))
app.use(express.urlencoded({ extended: true, limit: '500kb' }))

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// 🔒 NOVO — limite global: 100 requisições por minuto por IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em 1 minuto.' },
})
app.use('/api/', globalLimiter)

// 🔒 NOVO — limite de auth: 10 tentativas por 15 minutos por IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
})
app.use('/api/auth/login', authLimiter)
app.use('/api/auth/register', authLimiter)

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) =>
  res.json({ status: 'OK', message: 'API funcionando!' })) // 🔒 Removido env da resposta

app.use('/api/auth',    authRoutes)
app.use('/api/profile', profileRoutes)
app.use('/api/bsd',     bsdProxy)
app.use('/api/grupos',  gruposRoutes)
app.use('/api/news',    newsRoutes)

app.get('/health', (req, res) =>
  res.json({ status: 'ok', app: 'TorcidaMatch API', time: new Date().toISOString() }))

app.use((req, res) =>
  res.status(404).json({ error: `Rota ${req.method} ${req.path} não encontrada` }))

// ─── Error Handler Global ────────────────────────────────────────────────────
// 🔒 NOVO — captura erros sem vazar stack traces
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message)
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Erro interno do servidor'
      : err.message,
  })
})

// ─── Conexão ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB conectado')
    server.listen(PORT, () => {
      console.log(`🚀 TorcidaMatch API rodando na porta ${PORT}`)
      console.log(`🔌 WebSocket ativo (com autenticação JWT)`) // 🔒 Atualizado
    })
  })
  .catch(err => {
    console.error('❌ Erro MongoDB:', err.message)
    process.exit(1)
  })
