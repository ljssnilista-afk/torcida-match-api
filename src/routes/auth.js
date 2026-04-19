// routes/auth.js
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

// ─── Função para gerar JWT ───────────────────────────────────────────────
function generateToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '7d' }); // 🔒 Reduzido de 30d para 7d
}

// ─── POST /api/auth/register ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, age, bairro, zona, handle, email, password, team, teamId, teamEmoji } = req.body;

    // Validações básicas
    if (!name || !age || !bairro || !zona || !handle || !email || !password) {
      return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos' });
    }
    if (age < 13 || age > 100) {
      return res.status(400).json({ error: 'Idade inválida' });
    }
    if (password.length < 8) { // 🔒 Aumentado de 6 para 8 caracteres
      return res.status(400).json({ error: 'Senha deve ter no mínimo 8 caracteres' });
    }

    // Normalização
    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const cleanEmail = email.toLowerCase().trim();

    // Verifica duplicidade
    const existing = await User.findOne({
      $or: [{ email: cleanEmail }, { handle: cleanHandle }],
    });
    if (existing) {
      if (existing.email === cleanEmail) {
        return res.status(400).json({ error: 'E-mail já cadastrado', field: 'email' });
      }
      return res.status(400).json({ error: `@${cleanHandle} já está em uso`, field: 'handle' });
    }

    // Cria usuário (usando new + save para garantir execução do hook pre('save'))
    const user = new User({
      name: name.trim(),
      age: parseInt(age),
      bairro: bairro.trim(),
      zona: zona.trim(),
      handle: cleanHandle,
      email: cleanEmail,
      password, // será criptografada pelo pre('save')
      team: team ?? '',
      teamId: teamId ?? '',
      teamEmoji: teamEmoji ?? '',
    });

    await user.save(); // garante que o hook de criptografia rode

    const token = generateToken(user._id);

    res.status(201).json({
      message: 'Usuário criado com sucesso',
      token,
      user: user.toPublicJSON(),
    });
  } catch (err) {
    console.error('[POST /register]', err.message); // 🔒 Removido err.stack do log (Railway mostra nos logs internos)
    res.status(500).json({ error: 'Erro interno do servidor' }); // 🔒 Removido details: err.message
  }
});

// ─── POST /api/auth/login ───────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });
    }

    const token = generateToken(user._id);

    res.json({
      message: 'Login realizado com sucesso',
      token,
      user: user.toPublicJSON(),
    });
  } catch (err) {
    console.error('[POST /login]', err.message); // 🔒 Removido err.stack
    res.status(500).json({ error: 'Erro interno do servidor' }); // 🔒 Removido details
  }
});

// ─── POST /api/auth/refresh ──────────────────────────────────────────────
// Renova o token se ainda for válido (ou expirado há menos de 7 dias)
router.post('/refresh', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token não fornecido' })
    }

    const token = authHeader.split(' ')[1]
    let decoded

    try {
      // Tenta verificar normalmente (token ainda válido)
      decoded = jwt.verify(token, process.env.JWT_SECRET)
    } catch (err) {
      // Se expirou, decodifica sem verificar expiração para checar a janela de graça
      if (err.name === 'TokenExpiredError') {
        decoded = jwt.decode(token)
        if (!decoded?.id) {
          return res.status(401).json({ error: 'Token inválido' })
        }
        // Janela de graça: permite renovar até 7 dias após expiração
        const expiredAt = decoded.exp * 1000
        const gracePeriod = 7 * 24 * 60 * 60 * 1000 // 7 dias
        if (Date.now() - expiredAt > gracePeriod) {
          return res.status(401).json({ error: 'Token expirado além do período de renovação. Faça login novamente.' })
        }
      } else {
        return res.status(401).json({ error: 'Token inválido' })
      }
    }

    // Verifica se o usuário ainda existe
    const user = await User.findById(decoded.id).select('-password')
    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado' })
    }

    // Gera novo token
    const newToken = generateToken(user._id)

    res.json({
      message: 'Token renovado com sucesso',
      token: newToken,
      user: user.toPublicJSON(),
    })
  } catch (err) {
    console.error('[POST /refresh]', err.message)
    res.status(500).json({ error: 'Erro interno do servidor' })
  }
})

// ─── GET /api/auth/check-handle/:handle ─────────────────────────────────
router.get('/check-handle/:handle', async (req, res) => {
  try {
    const handle = req.params.handle.replace(/^@/, '').toLowerCase().trim();
    if (!handle || handle.length < 3) {
      return res.status(400).json({ error: 'Handle inválido' });
    }
    const existing = await User.findOne({ handle });
    res.json({ available: !existing, handle: `@${handle}` });
  } catch (err) {
    console.error('[GET /check-handle]', err.message); // 🔒 Removido err.stack
    res.status(500).json({ error: 'Erro interno do servidor' }); // 🔒 Removido details
  }
});

module.exports = router;
