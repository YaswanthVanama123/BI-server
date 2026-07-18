'use strict';
const router = require('express').Router();
const c = require('../controllers/routeDriveTime.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/route-drive-time/options', wrap(c.options));
router.get('/route-drive-time', wrap(c.routeDriveTime));

module.exports = router;
