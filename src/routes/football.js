// src/routes/football.js
const express = require('express');
const axios = require('axios');
const router = express.Router();

// URL base da API externa (ajuste conforme sua fonte)
const EXTERNAL_API_URL = 'https://sports.bzzoiro.com/api/events/';

router.get('/events', async (req, res) => {
  try {
    const { team, status, date_from, date_to } = req.query;
    // Construa a query string para a API externa
    const params = new URLSearchParams();
    if (team) params.append('team', team);
    if (status) params.append('status', status);
    if (date_from) params.append('date_from', date_from);
    if (date_to) params.append('date_to', date_to);
    
    const response = await axios.get(`${EXTERNAL_API_URL}?${params.toString()}`, {
      headers: {
        'Authorization': `Token ${process.env.FOOTBALL_API_KEY}`
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Erro ao consultar API externa:', error.message);
    res.status(error.response?.status || 500).json({
      error: 'Erro ao buscar dados de futebol'
    });
  }
});

module.exports = router;