// routes/auth.js
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { stripe } = require('../config/stripe');

const router = express.Router();

// ─── Função para gerar JWT ───────────────────────────────────────────────
function generateToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// ─── Helper: criar Stripe Customer (não-bloqueante) ──────────────────────
// Roda em background — qualquer falha do Stripe NÃO impede o registro.
// O customer é exigido apenas no momento de salvar cartão / pagar mensalidade.
async function ensureStripeCustomer(user) {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  try {
    const customer = await stripe.customers.create({
      email: user.email,
      name:  user.name,
      metadata: {
        userId: String(user._id),
        handle: user.handle,
      },
    });
    user.stripeCustomerId = customer.id;
    await user.save();
    console.log(`[AUTH] Stripe Customer criado: ${customer.id} → user ${user._id}`);
    return customer.id;
  } catch (err) {
    console.error('[AUTH] Falha ao criar Stripe Customer (continuando):', err.message);
    return null;
  }
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
    if (password.length < 8) {
      return res.status(400).json({ error: 'Senha deve ter no mínimo 8 caracteres' });
    }

    const cleanHandle = handle.replace(/^@/, '').toLowerCase().trim();
    const cleanEmail = email.toLowerCase().trim();

    const existing = await User.findOne({
      $or: [{ email: cleanEmail }, { handle: cleanHandle }],
    });
    if (existing) {
      if (existing.email === cleanEmail) {
        return res.status(400).json({ error: 'E-mail já cadastrado', field: 'email' });
      }
      return res.status(400).json({ error: `@${cleanHandle} já está em uso`, field: 'handle' });
    }

    const user = new User({
      name: name.trim(),
      age: parseInt(age),
      bairro: bairro.trim(),
      zona: zona.trim(),
      handle: cleanHandle,
      email: cleanEmail,
      password,
      team: team ?? '',
      teamId: teamId ?? '',
      teamEmoji: teamEmoji ?? '',
    });

    await user.save();

    // ─── Criar Stripe Customer (passageiro pode salvar cartão depois) ────
    // Não bloqueia o registro se o Stripe falhar — é re-tentável.
    ensureStripeCustomer(user).catch(() => {});

    const token = generateToken(user._id);

    res.status(201).json({
      message: 'Usuário criado com sucesso',
      token,
      user: user.toPublicJSON(),
    });
  } catch (err) {
    console.error('[POST /register]', err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
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

    // Migração: garantir Stripe Customer para usuários antigos
    if (!user.stripeCustomerId) {
      ensureStripeCustomer(user).catch(() => {});
    }

    const token = generateToken(user._id);

    res.json({
      message: 'Login realizado com sucesso',
      token,
      user: user.toPublicJSON(),
    });
  } catch (err) {
    console.error('[POST /login]', err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ─── POST /api/auth/refresh ──────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token não fornecido' })
    }

    const token = authHeader.split(' ')[1]
    let decoded

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET)
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        decoded = jwt.decode(token)
        if (!decoded?.id) {
          return res.status(401).json({ error: 'Token inválido' })
        }
        const expiredAt = decoded.exp * 1000
        const gracePeriod = 7 * 24 * 60 * 60 * 1000
        if (Date.now() - expiredAt > gracePeriod) {
          return res.status(401).json({ error: 'Token expirado além do período de renovação. Faça login novamente.' })
        }
      } else {
        return res.status(401).json({ error: 'Token inválido' })
      }
    }

    const user = await User.findById(decoded.id).select('-password')
    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado' })
    }

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
    console.error('[GET /check-handle]', err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ─── POST /api/auth/ensure-stripe-customer ──────────────────────────────
// Endpoint de migração / fallback. Útil para usuários antigos que não têm
// stripeCustomerId. Idempotente.
router.post('/ensure-stripe-customer', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Não autenticado' })
    }
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET)
    const user = await User.findById(decoded.id)
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })

    const customerId = await ensureStripeCustomer(user)
    if (!customerId) {
      return res.status(502).json({ error: 'Falha ao criar conta de pagamento' })
    }
    res.json({ stripeCustomerId: customerId })
  } catch (err) {
    console.error('[POST /ensure-stripe-customer]', err.message)
    res.status(500).json({ error: 'Erro interno' })
  }
})

module.exports = router;
