'use strict';
const router = require('express').Router();
const c = require('../controllers/companyDistance.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/company-distances', wrap(c.list));
router.get('/company-distances/options', wrap(c.options));
router.get('/company-distances/sync/status', wrap(c.syncStatus));
router.post('/company-distances/sync', wrap(c.sync));

module.exports = router;
