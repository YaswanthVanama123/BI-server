'use strict';
const router = require('express').Router();
const c = require('../controllers/checkins.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/checkins/options', wrap(c.options));
router.get('/checkins', wrap(c.checkins));

module.exports = router;
