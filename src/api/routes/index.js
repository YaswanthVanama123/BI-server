'use strict';
const router = require('express').Router();
const requireDb = require('../middleware/requireDb');
const tenant = require('../middleware/tenant');

router.get('/', (req, res) => {
  res.json({
    name: 'EnviroMaster BI API',
    version: 'v1',
    endpoints: [
      'GET /technicians/utilization', 'GET /technicians/stops', 'GET /technicians/:id/checkins',
      'GET /stops/volume-trends', 'GET /stops/monthly-by-route', 'GET /route-legs', 'GET /invoices', 'GET /checkins', 'GET /route-drive-time', 'GET /company-distances', 'POST /company-distances/sync',
      'GET /revenue/by-category', 'GET /revenue/by-route', 'GET /revenue/by-customer', 'GET /revenue/per-stop',
      'GET /payroll/cost', 'GET /cost/labor-per-stop', 'GET /routes/:routeCode/profitability', 'GET /customers/:id/profitability',
      'POST /payroll/upload',
      'GET /customers', 'GET /customers/:id/pricing', 'GET /routes', 'GET /employees', 'GET /service-categories',
      'GET /data-quality/issues', 'PATCH /data-quality/issues/:id', 'GET /service-items/unmapped',
      'POST /item-category-mappings', 'GET /import-batches', 'GET /sync/status',
      'GET /system/connections',
    ],
  });
});

router.use(require('./system.routes'));

router.use(requireDb, tenant);
router.use(require('./operations.routes'));
router.use(require('./revenue.routes'));
router.use(require('./cost.routes'));
router.use(require('./reference.routes'));
router.use(require('./governance.routes'));
router.use(require('./payroll.routes'));
router.use(require('./invoices.routes'));
router.use(require('./checkins.routes'));
router.use(require('./routeDriveTime.routes'));
router.use(require('./companyDistance.routes'));

module.exports = router;
