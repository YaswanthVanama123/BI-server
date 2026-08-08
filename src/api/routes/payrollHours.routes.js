'use strict';
const router = require('express').Router();
const c = require('../controllers/payrollHours.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/payroll-hours', wrap(c.payrollHours));

module.exports = router;
