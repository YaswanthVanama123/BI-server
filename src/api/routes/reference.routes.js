'use strict';
const router = require('express').Router();
const c = require('../controllers/reference.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/customers', wrap(c.customers));
router.post('/customers/accounts/sync', wrap(c.accountSync));
router.get('/customers/accounts/sync/status', wrap(c.accountSyncStatus));
router.get('/customers/:id/account', wrap(c.customerAccount));
router.get('/customers/:id/pricing', wrap(c.customerPricing));
router.get('/routes', wrap(c.routes));
router.get('/employees', wrap(c.employees));
router.get('/service-categories', wrap(c.serviceCategories));

module.exports = router;
