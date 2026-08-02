'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { hashPassword } = require('../../services/auth/auth.service');
const { publicUser } = require('./auth.controller');

const { User } = models;
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };

async function list(req, res) {
  const users = await User.find({}).sort({ username: 1 }).lean();
  res.json(buildEnvelope(users.map(publicUser)));
}

async function create(req, res) {
  const username = (clean(req.body && req.body.username) || '').toLowerCase();
  const password = req.body && req.body.password;
  const name = clean(req.body && req.body.name);
  const role = clean(req.body && req.body.role) === 'admin' ? 'admin' : 'user';
  if (!username || !password) { const e = new Error('Username and password are required.'); e.status = 400; e.code = 'BAD_REQUEST'; throw e; }
  if (String(password).length < 6) { const e = new Error('Password must be at least 6 characters.'); e.status = 400; e.code = 'BAD_REQUEST'; throw e; }
  const exists = await User.findOne({ username });
  if (exists) { const e = new Error('A user with that username already exists.'); e.status = 409; e.code = 'CONFLICT'; throw e; }
  const user = await User.create({ username, name: name || username, role, active: true, passwordHash: hashPassword(password) });
  res.status(201).json(buildEnvelope(publicUser(user)));
}

async function update(req, res) {
  const user = await User.findById(req.params.id);
  if (!user) { const e = new Error('User not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  const body = req.body || {};
  if (body.name !== undefined) user.name = clean(body.name) || user.username;
  if (body.role !== undefined) user.role = body.role === 'admin' ? 'admin' : 'user';
  if (body.active !== undefined) user.active = !!body.active;
  if (body.password) {
    if (String(body.password).length < 6) { const e = new Error('Password must be at least 6 characters.'); e.status = 400; e.code = 'BAD_REQUEST'; throw e; }
    user.passwordHash = hashPassword(body.password);
  }
  if (String(user._id) === req.user.id && (user.role !== 'admin' || user.active === false)) {
    const e = new Error('You cannot demote or deactivate your own admin account.'); e.status = 400; e.code = 'BAD_REQUEST'; throw e;
  }
  await user.save();
  res.json(buildEnvelope(publicUser(user)));
}

async function remove(req, res) {
  if (String(req.params.id) === req.user.id) {
    const e = new Error('You cannot delete your own account.'); e.status = 400; e.code = 'BAD_REQUEST'; throw e;
  }
  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) { const e = new Error('User not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  res.json(buildEnvelope({ deleted: true, id: req.params.id }));
}

module.exports = { list, create, update, remove };
