const express = require('express')
const router = express.Router()

const BSD_BASE  = 'https://sports.bzzoiro.com'
const BSD_TOKEN = 'e06ac9d43652a8adb1f8997bc4f9c4575db1353f'

// Proxy genérico: GET /api/bsd/* → BSD API
router.get('/*', async (req, res) => {
  try {
    const path  = req.params[0] || ''
    const query = new URLSearchParams(req.query).toString()
    
    // Suporta tanto /api/* quanto /img/*
    const isImg = path.startsWith('img/')
    const base  = isImg ? BSD_BASE : `${BSD_BASE}/api`
    const url   = `${base}/${path}${query ? '?' + query : ''}`

    const response = await fetch(url, {
      headers: { Authorization: `Token ${BSD_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    })

    // Para imagens, retorna o buffer direto
    if (isImg) {
      const buffer = await response.arrayBuffer()
      const contentType = response.headers.get('content-type') || 'image/png'
      res.setHeader('Content-Type', contentType)
      res.setHeader('Cache-Control', 'public, max-age=86400')
      return res.send(Buffer.from(buffer))
    }

    // Valida se a resposta é JSON antes de parsear
    const contentType = response.headers.get('content-type') || ''

    if (!response.ok) {
      const body = await response.text()
      console.error(`[BSD Proxy] HTTP ${response.status} para ${url}`)
      console.error(`[BSD Proxy] Content-Type: ${contentType}`)
      console.error(`[BSD Proxy] Body (primeiros 200 chars): ${body.substring(0, 200)}`)
      return res.status(response.status).json({
        error: `BSD API retornou ${response.status}`,
        upstream_status: response.status,
      })
    }

    if (!contentType.includes('application/json')) {
      const body = await response.text()
      console.error(`[BSD Proxy] Resposta não-JSON para ${url}`)
      console.error(`[BSD Proxy] Content-Type: ${contentType}`)
      console.error(`[BSD Proxy] Body (primeiros 200 chars): ${body.substring(0, 200)}`)
      return res.status(502).json({
        error: 'BSD API retornou resposta não-JSON (possível manutenção ou bloqueio)',
        upstream_content_type: contentType,
      })
    }

    const data = await response.json()
    res.status(response.status).json(data)
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError'
    console.error('[BSD Proxy]', isTimeout ? 'Timeout (8s)' : err.message)
    res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'BSD API não respondeu a tempo' : 'Erro ao consultar BSD API'
    })
  }
})

module.exports = router
