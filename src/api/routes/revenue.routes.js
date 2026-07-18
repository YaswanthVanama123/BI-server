'use strict';
const router = require('express').Router();
const c = require('../controllers/revenue.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/revenue/by-category', wrap(c.byCategory));
router.get('/revenue/by-route', wrap(c.byRoute));
router.get('/revenue/by-customer', wrap(c.byCustomer));
router.get('/revenue/per-stop', wrap(c.perStop));

module.exports = router;
