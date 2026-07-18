'use strict';
const router = require('express').Router();
const c = require('../controllers/operations.controller');
const svdt = require('../controllers/serviceVsDriveTime.controller');
const ops = require('../controllers/operationsAnalytics.controller');
const wrap = require('../middleware/asyncHandler');

router.get('/technicians/utilization', wrap(c.utilization));
router.get('/technicians/stops', wrap(c.stops));
router.get('/technicians/:id/checkins', wrap(c.checkins));
router.get('/stops/volume-trends', wrap(c.volumeTrends));
router.get('/stops/monthly-by-route', wrap(c.monthlyByRoute));
router.get('/route-legs', wrap(c.routeLegs));
router.get('/service-vs-drive-time', wrap(svdt.serviceVsDriveTime));
router.get('/ops/technician-utilization', wrap(ops.technicianUtilization));
router.get('/ops/stops-per-technician', wrap(ops.stopsPerTechnician));
router.get('/ops/stop-volume', wrap(ops.stopVolume));

module.exports = router;
