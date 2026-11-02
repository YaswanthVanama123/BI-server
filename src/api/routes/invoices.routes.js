'use strict';
const router = require('express').Router();
const c = require('../controllers/invoices.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/invoices', wrap(c.closedInvoices));
router.post('/invoices/refresh-lines', wrap(c.refreshLines));
router.get('/invoices/refresh-lines/status', wrap(c.refreshLinesStatus));
router.get('/invoices/:invoiceNumber', wrap(c.invoiceDetail));

module.exports = router;
