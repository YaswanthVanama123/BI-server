'use strict';
const router = require('express').Router();
const wrap = require('../middleware/asyncHandler');
const requireDb = require('../middleware/requireDb');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const auth = require('../controllers/auth.controller');
const users = require('../controllers/users.controller');

router.post('/auth/login', requireDb, wrap(auth.login));
router.get('/auth/me', requireDb, requireAuth, wrap(auth.me));
router.get('/users', requireDb, requireAuth, requireAdmin, wrap(users.list));
router.post('/users', requireDb, requireAuth, requireAdmin, wrap(users.create));
router.patch('/users/:id', requireDb, requireAuth, requireAdmin, wrap(users.update));
router.delete('/users/:id', requireDb, requireAuth, requireAdmin, wrap(users.remove));

module.exports = router;
