/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  TEST — football-data.org API v4                                ║
 * ║  Verifica os 4 requisitos do TorcidaMatch:                      ║
 * ║    1. Escudo dos times (crest)                                  ║
 * ║    2. Horário e data do próximo jogo (utcDate)                  ║
 * ║    3. Local exato do jogo (venue)                               ║
 * ║    4. Posição na tabela (standings)                             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 *  Uso:  FOOTBALL_API_KEY=<sua_key> node src/tests/test-football-data-api.js
 *  Free tier: 10 req/min — o script respeita esse limite.
 */

const BASE = 'https://api.football-data.org/v4'

// A free-tier key é obrigatória (cadastro grátis em football-data.org)
const API_KEY = process.env.FOOTBALL_API_KEY || ''

const headers = {
  'X-Auth-Token': API_KEY,
  'Content-Type': 'application/json',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OK  = '\x1b[32m✅ PASS\x1b[0m'
const FAIL = '\x1b[31m❌ FAIL\x1b[0m'
const WARN = '\x1b[33m⚠️  WARN\x1b[0m'
const INFO = '\x1b[36mℹ️  INFO\x1b[0m'

function sep(title) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('═'.repeat(60))
}

async function fetchAPI(path) {
  const url = `${BASE}${path}`
  console.log(`${INFO} GET ${url}`)

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} — ${body.substring(0, 200)}`)
  }

  return res.json()
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Resultados ───────────────────────────────────────────────────────────────

const results = {
  escudos: { status: false, details: '' },
  horario: { status: false, details: '' },
  local:   { status: false, details: '' },
  tabela:  { status: false, details: '' },
}

// ─── TESTE 1 — Próximos jogos (Brasileirão Série A — BSA) ────────────────────

async function testScheduledMatches() {
  sep('TESTE 1 — Próximos Jogos Agendados (Brasileirão)')

  try {
    const data = await fetchAPI('/competitions/BSA/matches?status=SCHEDULED&limit=5')

    console.log(`\n  Filtros aplicados:`, JSON.stringify(data.filters, null, 2))
    console.log(`  Total de jogos encontrados: ${data.resultSet?.count ?? '?'}`)

    if (!data.matches || data.matches.length === 0) {
      console.log(`${WARN} Nenhum jogo agendado encontrado para o Brasileirão.`)
      console.log(`${INFO} Isso pode significar que a temporada ainda não começou.`)
      console.log(`${INFO} Vamos tentar outra competição (Premier League)...`)
      return null // sinal para tentar outra liga
    }

    const match = data.matches[0]
    console.log(`\n  Primeiro jogo encontrado:`)
    console.log(`  ──────────────────────────`)

    // 1. ESCUDOS
    const homeCrest = match.homeTeam?.crest
    const awayCrest = match.awayTeam?.crest
    if (homeCrest && awayCrest) {
      results.escudos.status = true
      results.escudos.details = `Home: ${homeCrest}\n    Away: ${awayCrest}`
      console.log(`  ${OK} Escudo Home: ${homeCrest}`)
      console.log(`  ${OK} Escudo Away: ${awayCrest}`)
    } else {
      results.escudos.details = 'Campo "crest" não encontrado no objeto do time'
      console.log(`  ${FAIL} Escudo Home: ${homeCrest ?? 'AUSENTE'}`)
      console.log(`  ${FAIL} Escudo Away: ${awayCrest ?? 'AUSENTE'}`)
    }

    // 2. DATA / HORÁRIO
    const utcDate = match.utcDate
    if (utcDate) {
      const dateObj = new Date(utcDate)
      const brDate = dateObj.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      results.horario.status = true
      results.horario.details = `UTC: ${utcDate} → BR: ${brDate}`
      console.log(`  ${OK} Data/Hora UTC: ${utcDate}`)
      console.log(`  ${OK} Data/Hora BR:  ${brDate}`)
    } else {
      results.horario.details = 'Campo "utcDate" não encontrado'
      console.log(`  ${FAIL} Campo utcDate AUSENTE`)
    }

    // 3. LOCAL / VENUE
    const venue = match.venue
    if (venue) {
      results.local.status = true
      results.local.details = venue
      console.log(`  ${OK} Local (venue): ${venue}`)
    } else {
      results.local.status = false
      results.local.details = 'Campo "venue" retornou null/undefined'
      console.log(`  ${WARN} Campo venue: ${venue ?? 'null'} — pode estar vazio para jogos futuros`)
    }

    // Info extra
    console.log(`\n  Detalhes adicionais:`)
    console.log(`    Competição: ${match.competition?.name}`)
    console.log(`    Rodada:     ${match.matchday}`)
    console.log(`    Status:     ${match.status}`)
    console.log(`    Home:       ${match.homeTeam?.name} (id: ${match.homeTeam?.id})`)
    console.log(`    Away:       ${match.awayTeam?.name} (id: ${match.awayTeam?.id})`)

    // Listar mais jogos
    if (data.matches.length > 1) {
      console.log(`\n  Próximos ${Math.min(5, data.matches.length)} jogos:`)
      console.log(`  ${'─'.repeat(50)}`)
      data.matches.slice(0, 5).forEach((m, i) => {
        const d = new Date(m.utcDate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        console.log(`  ${i + 1}. ${m.homeTeam?.name} vs ${m.awayTeam?.name}`)
        console.log(`     ${d} | ${m.venue ?? 'Local não informado'} | Rodada ${m.matchday}`)
      })
    }

    return data
  } catch (err) {
    console.log(`  ${FAIL} Erro: ${err.message}`)
    return null
  }
}

// ─── TESTE 1B — Fallback: outra competição ───────────────────────────────────

async function testFallbackMatches() {
  sep('TESTE 1B — Fallback: Premier League (PL)')

  try {
    const data = await fetchAPI('/competitions/PL/matches?status=SCHEDULED&limit=5')

    if (!data.matches || data.matches.length === 0) {
      console.log(`  ${FAIL} Nenhum jogo agendado encontrado em nenhuma liga.`)
      return null
    }

    const match = data.matches[0]

    // Escudos
    const homeCrest = match.homeTeam?.crest
    const awayCrest = match.awayTeam?.crest
    if (homeCrest && awayCrest) {
      results.escudos.status = true
      results.escudos.details = `Home: ${homeCrest}\n    Away: ${awayCrest}`
    }

    // Data/Hora
    if (match.utcDate) {
      results.horario.status = true
      results.horario.details = `UTC: ${match.utcDate}`
    }

    // Venue
    if (match.venue) {
      results.local.status = true
      results.local.details = match.venue
    }

    console.log(`  Jogo: ${match.homeTeam?.name} vs ${match.awayTeam?.name}`)
    console.log(`  Data: ${match.utcDate}`)
    console.log(`  Venue: ${match.venue ?? 'null'}`)
    console.log(`  Crests: ${homeCrest ? 'SIM' : 'NÃO'} / ${awayCrest ? 'SIM' : 'NÃO'}`)

    return data
  } catch (err) {
    console.log(`  ${FAIL} Erro: ${err.message}`)
    return null
  }
}

// ─── TESTE 2 — Standings / Tabela ────────────────────────────────────────────

async function testStandings() {
  sep('TESTE 2 — Tabela / Classificação (Brasileirão)')

  try {
    const data = await fetchAPI('/competitions/BSA/standings')

    if (!data.standings || data.standings.length === 0) {
      console.log(`  ${WARN} Nenhum standing encontrado para BSA. Tentando PL...`)
      await delay(6500) // respeitar rate limit
      return testStandingsFallback()
    }

    const total = data.standings.find(s => s.type === 'TOTAL')
    if (!total || !total.table?.length) {
      console.log(`  ${FAIL} Tabela TOTAL não encontrada`)
      return
    }

    console.log(`\n  Competição: ${data.competition?.name}`)
    console.log(`  Temporada:  ${data.season?.startDate} → ${data.season?.endDate}`)
    console.log(`  Rodada:     ${data.season?.currentMatchday ?? '?'}`)

    // Verificar campos da tabela
    const first = total.table[0]
    const hasPosition = first.position !== undefined
    const hasCrest    = first.team?.crest !== undefined
    const hasPoints   = first.points !== undefined
    const hasForm     = first.form !== undefined

    if (hasPosition) {
      results.tabela.status = true
      results.tabela.details = `Top 5 disponível com posição, pontos e escudos`
    }

    console.log(`\n  Campos disponíveis na tabela:`)
    console.log(`    position:     ${hasPosition ? OK : FAIL}`)
    console.log(`    team.crest:   ${hasCrest ? OK : FAIL}`)
    console.log(`    points:       ${hasPoints ? OK : FAIL}`)
    console.log(`    form:         ${hasForm ? OK : FAIL}`)
    console.log(`    goalsFor:     ${first.goalsFor !== undefined ? OK : FAIL}`)
    console.log(`    goalsAgainst: ${first.goalsAgainst !== undefined ? OK : FAIL}`)
    console.log(`    goalDiff:     ${first.goalDifference !== undefined ? OK : FAIL}`)

    // Top 5
    console.log(`\n  TOP 5:`)
    console.log(`  ${'─'.repeat(55)}`)
    console.log(`  Pos | Time                         | Pts | J  | Form`)
    console.log(`  ${'─'.repeat(55)}`)
    total.table.slice(0, 5).forEach(row => {
      const pos  = String(row.position).padStart(3)
      const name = (row.team?.shortName || row.team?.name || '?').padEnd(28)
      const pts  = String(row.points).padStart(3)
      const gp   = String(row.playedGames).padStart(2)
      const form = row.form || '-'
      console.log(`  ${pos} | ${name} | ${pts} | ${gp} | ${form}`)
    })

    // Escudo do líder
    if (hasCrest) {
      console.log(`\n  ${OK} Escudo do líder: ${first.team?.crest}`)
    }

    return data
  } catch (err) {
    console.log(`  ${FAIL} Erro: ${err.message}`)
  }
}

async function testStandingsFallback() {
  sep('TESTE 2B — Tabela Fallback (Premier League)')

  try {
    const data = await fetchAPI('/competitions/PL/standings')
    const total = data.standings?.find(s => s.type === 'TOTAL')

    if (!total?.table?.length) {
      console.log(`  ${FAIL} Tabela não disponível em nenhuma liga`)
      return
    }

    const first = total.table[0]
    if (first.position !== undefined) {
      results.tabela.status = true
      results.tabela.details = 'Standings disponível (testado via PL)'
    }

    console.log(`  Top 3 PL:`)
    total.table.slice(0, 3).forEach(row => {
      console.log(`  ${row.position}. ${row.team?.name} — ${row.points}pts`)
    })
  } catch (err) {
    console.log(`  ${FAIL} Erro: ${err.message}`)
  }
}

// ─── TESTE 3 — Ligas disponíveis (free tier) ─────────────────────────────────

async function testAvailableCompetitions() {
  sep('TESTE 3 — Competições Disponíveis (free tier)')

  try {
    const data = await fetchAPI('/competitions')

    const comps = data.competitions || []
    console.log(`  Total de competições: ${comps.length}`)

    // Filtrar brasileiras
    const brazil = comps.filter(c => c.area?.name === 'Brazil')
    console.log(`\n  Competições brasileiras:`)
    if (brazil.length > 0) {
      brazil.forEach(c => {
        console.log(`    • ${c.name} (code: ${c.code}, id: ${c.id})`)
        console.log(`      Temporada: ${c.currentSeason?.startDate} → ${c.currentSeason?.endDate}`)
      })
    } else {
      console.log(`    ${WARN} Nenhuma competição brasileira no free tier`)
    }

    // Listar todas
    console.log(`\n  Todas as competições disponíveis:`)
    console.log(`  ${'─'.repeat(50)}`)
    comps.forEach(c => {
      console.log(`    ${c.code?.padEnd(5) || '?    '} | ${c.name} (${c.area?.name})`)
    })

    return data
  } catch (err) {
    console.log(`  ${FAIL} Erro: ${err.message}`)
  }
}

// ─── TESTE 4 — Endpoint /matches (global) ────────────────────────────────────

async function testGlobalMatches() {
  sep('TESTE 4 — Endpoint /matches (global, sem filtro)')

  try {
    const data = await fetchAPI('/matches')

    console.log(`  Jogos retornados: ${data.matches?.length ?? 0}`)
    console.log(`  ResultSet: ${JSON.stringify(data.resultSet)}`)

    if (data.matches?.length > 0) {
      const m = data.matches[0]
      console.log(`\n  Exemplo:`)
      console.log(`    ${m.homeTeam?.name} vs ${m.awayTeam?.name}`)
      console.log(`    Data:  ${m.utcDate}`)
      console.log(`    Venue: ${m.venue ?? 'null'}`)
      console.log(`    Crest Home: ${m.homeTeam?.crest ?? 'null'}`)
      console.log(`    Crest Away: ${m.awayTeam?.crest ?? 'null'}`)
      console.log(`    Competição: ${m.competition?.name}`)
    }
  } catch (err) {
    console.log(`  ${FAIL} Erro: ${err.message}`)
  }
}

// ─── RELATÓRIO FINAL ─────────────────────────────────────────────────────────

function printReport() {
  sep('RELATÓRIO FINAL — football-data.org v4')

  const items = [
    { req: '1. Escudo dos times (crest)',        ...results.escudos },
    { req: '2. Horário / data do jogo (utcDate)', ...results.horario },
    { req: '3. Local exato (venue)',              ...results.local },
    { req: '4. Posição na tabela (standings)',    ...results.tabela },
  ]

  let allPass = true
  items.forEach(item => {
    const icon = item.status ? OK : FAIL
    console.log(`\n  ${icon} ${item.req}`)
    if (item.details) console.log(`    ${item.details}`)
    if (!item.status) allPass = false
  })

  console.log(`\n${'═'.repeat(60)}`)
  if (allPass) {
    console.log(`  ${OK} TODOS os 4 requisitos são atendidos pela API!`)
  } else {
    const failCount = items.filter(i => !i.status).length
    console.log(`  ${WARN} ${4 - failCount}/4 requisitos atendidos.`)
    items.filter(i => !i.status).forEach(i => {
      console.log(`  ${FAIL} Faltando: ${i.req}`)
    })
  }

  console.log(`\n  Observações importantes:`)
  console.log(`    • Free tier: 10 requisições/minuto`)
  console.log(`    • Brasileirão (BSA) está incluso no free tier`)
  console.log(`    • Escudos são URLs SVG hospedadas no football-data.org`)
  console.log(`    • Venue pode ser null em jogos muito distantes`)
  console.log(`    • Standings requer endpoint separado (/competitions/{code}/standings)`)
  console.log(`    • Posição na tabela NÃO vem no endpoint /matches`)
  console.log('═'.repeat(60))
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '╔' + '═'.repeat(58) + '╗')
  console.log('║  football-data.org API v4 — Teste TorcidaMatch            ║')
  console.log('╚' + '═'.repeat(58) + '╝')

  if (!API_KEY) {
    console.log(`\n  ${FAIL} FOOTBALL_API_KEY não definida!`)
    console.log(`  Cadastre-se GRÁTIS em: https://www.football-data.org/client/register`)
    console.log(`  Depois rode: FOOTBALL_API_KEY=<key> node src/tests/test-football-data-api.js\n`)
    console.log(`  ${INFO} Rodando mesmo assim (vai retornar 403 na maioria)...\n`)
  }

  // Teste 1: Próximos jogos
  const bsaMatches = await testScheduledMatches()
  await delay(6500)

  // Fallback se BSA não tiver jogos
  if (!bsaMatches || !bsaMatches.matches?.length) {
    await testFallbackMatches()
    await delay(6500)
  }

  // Teste 2: Tabela
  await testStandings()
  await delay(6500)

  // Teste 3: Competições disponíveis
  await testAvailableCompetitions()
  await delay(6500)

  // Teste 4: Endpoint global /matches
  await testGlobalMatches()

  // Relatório
  printReport()
}

main().catch(err => {
  console.error(`\n${FAIL} Erro fatal:`, err.message)
  process.exit(1)
})
