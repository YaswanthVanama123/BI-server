'use strict';
const { verifyToken } = require('../../services/auth/auth.service');

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function requireAuth(req, res, next) {
  const payload = verifyToken(bearer(req));
  if (!payload) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required.' } });
  }
  req.user = { id: payload.sub, username: payload.username, name: payload.name, role: payload.role };
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin access required.' } });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
