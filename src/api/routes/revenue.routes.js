'use strict';
const router = require('express').Router();
const c = require('../controllers/revenue.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/revenue/by-category', wrap(c.byCategory));
router.get('/revenue/category-detail', wrap(c.categoryDetail));
router.get('/revenue/by-route', wrap(c.byRoute));
router.get('/revenue/route-detail', wrap(c.routeDetail));
router.get('/revenue/drill', wrap(c.drill));
router.get('/customer-overview', wrap(c.customersOverview));
router.get('/revenue/by-customer', wrap(c.byCustomer));
router.get('/revenue/customer/:id', wrap(c.customerDetail));
router.get('/revenue/per-stop', wrap(c.perStop));
router.get('/items/frequency', wrap(c.itemFrequency));

module.exports = router;
