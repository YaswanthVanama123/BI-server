'use strict';
const router = require('express').Router();
const c = require('../controllers/routeUsers.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/route-users', wrap(c.list));

module.exports = router;
