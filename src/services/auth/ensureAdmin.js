'use strict';
const { models } = require('../../models');
const { hashPassword } = require('./auth.service');
const logger = require('../../utils/logger');

const log = logger.child('auth');
const { User } = models;

// Ensures the default admin exists (admin / Admin@123). Idempotent — never overwrites an existing admin.
async function ensureDefaultAdmin() {
  try {
    const existing = await User.findOne({ username: 'admin' });
    if (existing) return;
    await User.create({
      username: 'admin',
      name: 'Administrator',
      role: 'admin',
      active: true,
      passwordHash: hashPassword('Admin@123'),
    });
    log.info('created default admin user (admin / Admin@123) — change the password after first login');
  } catch (e) {
    log.warn(`could not ensure default admin: ${e.message}`);
  }
}

module.exports = { ensureDefaultAdmin };
