'use strict';
const router = require('express').Router();
const c = require('../controllers/routeCalendar.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/route-calendar', wrap(c.routeCalendar));

module.exports = router;
