'use strict';
const router = require('express').Router();
const c = require('../controllers/dataPull.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/data-pull', wrap(c.dataPull));

module.exports = router;
