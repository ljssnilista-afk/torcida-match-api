const jwt = require('jsonwebtoken')
const User = require('../models/User')

module.exports = async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(decoded.id).select('-password')
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' })
    req.user = user
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' })
  }
}
