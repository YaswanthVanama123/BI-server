'use strict';
const router = require('express').Router();
const multer = require('multer');
const c = require('../controllers/payroll.controller');
const wrap = require('../middleware/asyncHandler');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/payroll/upload', upload.single('file'), wrap(c.uploadPayroll));

module.exports = router;
