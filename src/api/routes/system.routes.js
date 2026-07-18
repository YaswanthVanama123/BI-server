'use strict';
const router = require('express').Router();
const wrap = require('../middleware/asyncHandler');
const c = require('../controllers/system.controller');

router.get('/system/connections', wrap(c.connections));

module.exports = router;
