'use strict';
const router = require('express').Router();
const c = require('../controllers/governance.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/data-quality/issues', wrap(c.dqIssues));
router.patch('/data-quality/issues/:id', wrap(c.resolveDqIssue));
router.get('/service-items/unmapped', wrap(c.unmapped));
router.post('/item-category-mappings', wrap(c.createMapping));
router.get('/import-batches', wrap(c.importBatches));
router.get('/sync/status', wrap(c.syncStatus));

module.exports = router;
