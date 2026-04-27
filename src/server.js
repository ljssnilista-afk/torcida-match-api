require('dotenv').config()
const express    = require('express')
const mongoose   = require('mongoose')
const cors       = require('cors')
const http       = require('http')
const { WebSocketServer } = require('ws')
const jwt        = require('jsonwebtoken')
const helmet     = require('helmet')
const rateLimit  = require('express-rate-limit')

const authRoutes    = require('./routes/auth')
const profileRoutes = require('./routes/profile')
const bsdProxy      = require('./routes/bsdProxy')
const gruposRoutes  = require('./routes/grupos')
const newsRoutes    = require('./routes/news')
const ridesRoutes   = require('./routes/rides')
const invitesRoutes = require('./routes/invites')
const notificationsRoutes = require('./routes/notifications')
const footballDataRoutes  = require('./routes/footballData')
const paymentsRoutes = require('./routes/payments')
const webhookRoutes  = require('./routes/webhook')
const connectRoutes  = require('./routes/connect')
const walletRoutes   = require('./routes/wallet')
const Group         = require('./models/Group')
const Ride          = require('./models/Ride')
const { startExpiredTokensCron } = require('./cron/expiredTokens')

const app    = express()
const server = http.createServer(app)
const PORT   = process.env.PORT || 3001

// ─── WebSocket — Grupos ───────────────────────────────────────────────────────
const wss   = new WebSocketServer({ noServer: true })
const rooms = new Map()

// ─── WebSocket — Viagens ──────────────────────────────────────────────────────
const wssRides   = new WebSocketServer({ noServer: true })
const rideRooms  = new Map()

// HTTP upgrade handler — roteia para o WebSocket correto
server.on('upgrade', (req, socket, head) => {
  const url = req.url || ''
  if (url.startsWith('/ws/grupos/')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  } else if (url.startsWith('/ws/rides/')) {
    wssRides.handleUpgrade(req, socket, head, ws => wssRides.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

wss.on('connection', async (ws, req) => {
  let userId
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const token = url.searchParams.get('token')

    if (!token) {
      ws.close(4001, 'Token não fornecido')
      return
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    userId = decoded.id
    ws.userId = userId
  } catch (err) {
    ws.close(4001, 'Token inválido ou expirado')
    return
  }

  const grupoId = req.url.split('/ws/grupos/')[1]?.split('?')[0]
  if (!grupoId) return ws.close()
  try {
    const group = await Group.findById(grupoId)
    if (!group) {
      ws.close(4002, 'Grupo não encontrado')
      return
    }

    const isMember = group.members.map(String).includes(String(userId))
    if (!isMember) {
      ws.close(4003, 'Você não é membro deste grupo')
      return
    }
  } catch (err) {
    ws.close(4002, 'Erro ao verificar grupo')
    return
  }

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

// ─── WebSocket Rides — conexão ────────────────────────────────────────────────
wssRides.on('connection', async (ws, req) => {
  let userId
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const token = url.searchParams.get('token')
    if (!token) { ws.close(4001, 'Token não fornecido'); return }
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    userId = decoded.id
    ws.userId = userId
  } catch (err) {
    ws.close(4001, 'Token inválido ou expirado')
    return
  }

  const rideId = req.url.split('/ws/rides/')[1]?.split('?')[0]
  if (!rideId) return ws.close()
  try {
    const ride = await Ride.findById(rideId)
    if (!ride) { ws.close(4002, 'Viagem não encontrada'); return }

    const isDriver = String(ride.driver) === String(userId)
    const isPassenger = ride.passengers.some(
      p => String(p.user) === String(userId) && ['paid', 'confirmed'].includes(p.status)
    )

    if (!isDriver && !isPassenger) {
      ws.close(4003, 'Apenas motorista e passageiros confirmados podem acessar o chat')
      return
    }
  } catch (err) {
    ws.close(4002, 'Erro ao verificar viagem')
    return
  }

  if (!rideRooms.has(rideId)) rideRooms.set(rideId, new Set())
  rideRooms.get(rideId).add(ws)

  ws.on('close', () => {
    rideRooms.get(rideId)?.delete(ws)
    if (rideRooms.get(rideId)?.size === 0) rideRooms.delete(rideId)
  })
  ws.on('error', () => rideRooms.get(rideId)?.delete(ws))
})

app.locals.wsRideBroadcast = (rideId, payload) => {
  const clients = rideRooms.get(rideId)
  if (!clients) return
  const data = JSON.stringify(payload)
  for (const ws of clients) if (ws.readyState === 1) ws.send(data)
}

// ─── Segurança ────────────────────────────────────────────────────────────────
app.use(helmet())

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    const allowed = [
      process.env.CLIENT_URL,
      'http://localhost:5173',
      'http://localhost:3000',
      'https://torcidamatch.vercel.app',
    ]
    // Permitir também subdomínios Vercel (previews de deploy)
    if (!origin || allowed.includes(origin) || origin?.endsWith('.vercel.app')) cb(null, true)
    else cb(new Error('Bloqueado pelo CORS'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRoutes)
app.use(express.json({ limit: '500kb' }))
app.use(express.urlencoded({ extended: true, limit: '500kb' }))

// 🔧 Trust proxy — necessário no Railway/Vercel para rate limiting funcionar
app.set('trust proxy', 1)

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em 1 minuto.' },
})
app.use('/api/', globalLimiter)
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
  res.json({ status: 'OK', message: 'API funcionando!' }))

app.use('/api/auth',    authRoutes)
app.use('/api/profile', profileRoutes)
app.use('/api/bsd',     bsdProxy)
app.use('/api/grupos',  gruposRoutes)
app.use('/api/news',    newsRoutes)
app.use('/api/rides',   ridesRoutes)
app.use('/api/invites', invitesRoutes)
app.use('/api/notifications', notificationsRoutes)
app.use('/api/football',      footballDataRoutes)
app.use('/api/payments',      paymentsRoutes)
app.use('/api/connect',       connectRoutes)
app.use('/api/wallet',        walletRoutes)

app.get('/health', (req, res) =>
  res.json({ status: 'ok', app: 'TorcidaMatch API', time: new Date().toISOString() }))

app.use((req, res) =>
  res.status(404).json({ error: `Rota ${req.method} ${req.path} não encontrada` }))

// ─── Error Handler Global ────────────────────────────────────────────────────
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
      console.log(`🔌 WebSocket ativo (com autenticação JWT)`)

      // ⏰ Cron — tokens expirados (Cenário 4: split 46/46/8)
      const cron = startExpiredTokensCron()
      if (cron) console.log('⏰ Cron de tokens expirados ativo (intervalo 1h)')
    })
  })
  .catch(err => {
    console.error('❌ Erro MongoDB:', err.message)
    process.exit(1)
  })
