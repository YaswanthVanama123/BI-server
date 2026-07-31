'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { verifyPassword, signToken } = require('../../services/auth/auth.service');

const { User } = models;
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const publicUser = (u) => ({ id: String(u._id), username: u.username, name: u.name || u.username, role: u.role, active: u.active !== false, lastLoginAt: u.lastLoginAt || null });

async function login(req, res) {
  const username = (clean(req.body && req.body.username) || '').toLowerCase();
  const password = req.body && req.body.password;
  if (!username || !password) {
    const e = new Error('Username and password are required.'); e.status = 400; e.code = 'BAD_REQUEST'; throw e;
  }
  const user = await User.findOne({ username });
  if (!user || user.active === false || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' } });
  }
  user.lastLoginAt = new Date();
  await user.save();
  const token = signToken({ sub: String(user._id), username: user.username, name: user.name || user.username, role: user.role });
  res.json(buildEnvelope({ token, user: publicUser(user) }));
}

async function me(req, res) {
  const user = await User.findById(req.user.id);
  if (!user || user.active === false) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Session no longer valid.' } });
  }
  res.json(buildEnvelope(publicUser(user)));
}

module.exports = { login, me, publicUser };
