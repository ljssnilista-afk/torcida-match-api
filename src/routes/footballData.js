/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  footballData.js — Integração com football-data.org API v4   ║
 * ║                                                               ║
 * ║  Endpoints:                                                   ║
 * ║    GET /api/football/matches    → Próximos jogos              ║
 * ║    GET /api/football/standings  → Tabela / classificação      ║
 * ║    GET /api/football/team/:id   → Info completa do time       ║
 * ║                                                               ║
 * ║  Campos garantidos por endpoint:                              ║
 * ║    matches  → crest, utcDate, venue                           ║
 * ║    standings → position, crest, points, form                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 *  Requer: FOOTBALL_DATA_KEY no .env (grátis em football-data.org)
 */

const express = require('express')
const router  = express.Router()

const BASE_URL = 'https://api.football-data.org/v4'
const API_KEY  = process.env.FOOTBALL_DATA_KEY || ''

// ─── Helper: fetch com auth + timeout ─────────────────────────────────────────

async function fdFetch(path, query = {}) {
  const qs  = new URLSearchParams(query).toString()
  const url = `${BASE_URL}${path}${qs ? '?' + qs : ''}`

  const res = await fetch(url, {
    headers: {
      'X-Auth-Token': API_KEY,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err  = new Error(`football-data.org retornou ${res.status}`)
    err.status = res.status
    err.upstream = body.substring(0, 300)
    throw err
  }

  return res.json()
}

// ─── GET /matches — Próximos jogos ────────────────────────────────────────────
//
// Query params:
//   competition  (default: BSA = Brasileirão Série A)
//   status       (default: SCHEDULED)
//   limit        (default: 10)
//   matchday     (número da rodada — opcional)
//   dateFrom     (YYYY-MM-DD — opcional)
//   dateTo       (YYYY-MM-DD — opcional)
//
// Response mapeada:
// {
//   matches: [{
//     id, utcDate, status, matchday, venue,
//     competition: { name, code, emblem },
//     homeTeam:    { id, name, shortName, tla, crest },
//     awayTeam:    { id, name, shortName, tla, crest },
//     score:       { ... }
//   }]
// }

router.get('/matches', async (req, res) => {
  try {
    const {
      competition = 'BSA',
      status      = 'SCHEDULED',
      limit       = '10',
      matchday,
      dateFrom,
      dateTo,
    } = req.query

    const query = { status, limit }
    if (matchday) query.matchday = matchday
    if (dateFrom) query.dateFrom = dateFrom
    if (dateTo)   query.dateTo   = dateTo

    const data = await fdFetch(`/competitions/${competition}/matches`, query)

    // Mapear resposta para o formato que o front precisa
    const matches = (data.matches || []).map(m => ({
      id:          m.id,
      utcDate:     m.utcDate,                        // ✅ Req 2: Data/hora
      status:      m.status,
      matchday:    m.matchday,
      venue:       m.venue || null,                   // ✅ Req 3: Local
      competition: {
        name:   m.competition?.name,
        code:   m.competition?.code,
        emblem: m.competition?.emblem,
      },
      homeTeam: {
        id:        m.homeTeam?.id,
        name:      m.homeTeam?.name,
        shortName: m.homeTeam?.shortName,
        tla:       m.homeTeam?.tla,
        crest:     m.homeTeam?.crest || null,         // ✅ Req 1: Escudo
      },
      awayTeam: {
        id:        m.awayTeam?.id,
        name:      m.awayTeam?.name,
        shortName: m.awayTeam?.shortName,
        tla:       m.awayTeam?.tla,
        crest:     m.awayTeam?.crest || null,         // ✅ Req 1: Escudo
      },
      score: m.score || null,
    }))

    res.json({
      count:   data.resultSet?.count ?? matches.length,
      filters: data.filters,
      matches,
    })
  } catch (err) {
    console.error('[footballData] /matches erro:', err.message)
    res.status(err.status || 500).json({
      error: err.message,
      upstream: err.upstream,
    })
  }
})

// ─── GET /standings — Classificação / Tabela ──────────────────────────────────
//
// Query params:
//   competition (default: BSA)
//   type        (default: TOTAL — opções: TOTAL, HOME, AWAY)
//
// Response mapeada:
// {
//   competition: { name, emblem },
//   season:      { startDate, endDate, currentMatchday },
//   table: [{
//     position, team: { id, name, shortName, crest },
//     playedGames, won, draw, lost, points,
//     goalsFor, goalsAgainst, goalDifference, form
//   }]
// }

router.get('/standings', async (req, res) => {
  try {
    const { competition = 'BSA', type = 'TOTAL' } = req.query

    const data = await fdFetch(`/competitions/${competition}/standings`)

    const standing = (data.standings || []).find(s => s.type === type)
      || data.standings?.[0]

    if (!standing) {
      return res.status(404).json({ error: 'Tabela não encontrada para esta competição' })
    }

    const table = (standing.table || []).map(row => ({
      position:       row.position,                   // ✅ Req 4: Posição
      team: {
        id:        row.team?.id,
        name:      row.team?.name,
        shortName: row.team?.shortName,
        tla:       row.team?.tla,
        crest:     row.team?.crest || null,            // ✅ Req 1: Escudo
      },
      playedGames:    row.playedGames,
      won:            row.won,
      draw:           row.draw,
      lost:           row.lost,
      points:         row.points,
      goalsFor:       row.goalsFor,
      goalsAgainst:   row.goalsAgainst,
      goalDifference: row.goalDifference,
      form:           row.form || null,
    }))

    res.json({
      competition: {
        name:   data.competition?.name,
        emblem: data.competition?.emblem,
      },
      season: {
        startDate:       data.season?.startDate,
        endDate:         data.season?.endDate,
        currentMatchday: data.season?.currentMatchday,
      },
      table,
    })
  } catch (err) {
    console.error('[footballData] /standings erro:', err.message)
    res.status(err.status || 500).json({
      error: err.message,
      upstream: err.upstream,
    })
  }
})

// ─── GET /team/:id — Detalhes de um time ─────────────────────────────────────
//
// Response: { id, name, shortName, tla, crest, address, website, venue, ... }

router.get('/team/:id', async (req, res) => {
  try {
    const data = await fdFetch(`/teams/${req.params.id}`)

    res.json({
      id:        data.id,
      name:      data.name,
      shortName: data.shortName,
      tla:       data.tla,
      crest:     data.crest || null,                   // ✅ Req 1: Escudo
      address:   data.address,
      website:   data.website,
      founded:   data.founded,
      venue:     data.venue || null,                   // ✅ Req 3: Estádio do time
      clubColors: data.clubColors,
      coach:     data.coach ? {
        name:        data.coach.name,
        nationality: data.coach.nationality,
      } : null,
    })
  } catch (err) {
    console.error('[footballData] /team erro:', err.message)
    res.status(err.status || 500).json({
      error: err.message,
      upstream: err.upstream,
    })
  }
})

// ─── GET /competitions — Listar competições disponíveis ───────────────────────

router.get('/competitions', async (req, res) => {
  try {
    const data = await fdFetch('/competitions')

    const competitions = (data.competitions || []).map(c => ({
      id:     c.id,
      name:   c.name,
      code:   c.code,
      area:   c.area?.name,
      emblem: c.emblem,
      season: {
        startDate:       c.currentSeason?.startDate,
        endDate:         c.currentSeason?.endDate,
        currentMatchday: c.currentSeason?.currentMatchday,
      },
    }))

    // Separar brasileiras para destaque
    const brazilian = competitions.filter(c => c.area === 'Brazil')
    const others    = competitions.filter(c => c.area !== 'Brazil')

    res.json({ brazilian, others, total: competitions.length })
  } catch (err) {
    console.error('[footballData] /competitions erro:', err.message)
    res.status(err.status || 500).json({ error: err.message })
  }
})

module.exports = router
