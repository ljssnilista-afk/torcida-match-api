const express = require('express')
const router  = express.Router()

// GET /api/news?team=Botafogo
router.get('/', async (req, res) => {
  const team = req.query.team || 'Botafogo'

  const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(team + ' futebol')}&hl=pt-BR&gl=BR&ceid=BR:pt-419`

  try {
    const response = await fetch(feedUrl, {
      headers: { 'User-Agent': 'TorcidaMatch/1.0' },
      signal: AbortSignal.timeout(7000),
    })

    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const xml = await response.text()

    // Parse manual do RSS (sem dependência extra)
    const items = []
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    let match

    while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
      const block = match[1]

      const title   = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block))?.[1] || ''
      const link    = (/<link>(.*?)<\/link>/.exec(block))?.[1] || ''
      const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(block))?.[1] || ''
      const source  = (/<source[^>]*>(.*?)<\/source>/.exec(block))?.[1] || 'Google News'

      // Limpa HTML entities
      const cleanTitle = title
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/ - [^-]+$/, '') // Remove " - Fonte" do final
        .trim()

      if (cleanTitle) {
        items.push({ title: cleanTitle, link, pubDate, source })
      }
    }

    if (items.length === 0) {
      return res.status(404).json({ error: 'Sem notícias', items: [] })
    }

    res.json({ items, team, total: items.length })
  } catch (err) {
    console.error('[GET /api/news]', err.message)
    res.status(500).json({ error: 'Erro ao buscar notícias', items: [] })
  }
})

module.exports = router
