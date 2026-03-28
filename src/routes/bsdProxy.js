const express = require('express')
const router = express.Router()

const BSD_BASE = 'https://sports.bzzoiro.com/api'
const BSD_TOKEN = 'e06ac9d43652a8adb1f8997bc4f9c4575db1353f'

// Proxy genérico: GET /api/bsd/* → BSD API
router.get('/*', async (req, res) => {
  try {
    const path = req.params[0] || ''
    const query = new URLSearchParams(req.query).toString()
    const url = `${BSD_BASE}/${path}${query ? '?' + query : ''}`

    const response = await fetch(url, {
      headers: { Authorization: `Token ${BSD_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    })

    const data = await response.json()
    res.status(response.status).json(data)
  } catch (err) {
    console.error('[BSD Proxy]', err.message)
    res.status(500).json({ error: 'Erro ao consultar BSD API' })
  }
})

module.exports = router
