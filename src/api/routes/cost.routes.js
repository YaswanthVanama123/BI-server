'use strict';
const router = require('express').Router();
const c = require('../controllers/cost.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/payroll/cost', wrap(c.payrollCost));
router.get('/cost/labor-per-stop', wrap(c.laborPerStop));
router.get('/routes/:routeCode/profitability', wrap(c.routeProfitability));
router.get('/customers/:id/profitability', wrap(c.customerProfitability));

module.exports = router;
