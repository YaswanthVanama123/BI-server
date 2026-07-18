'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const summaryBuilder = require('../src/services/analytics/rebuildSummaries');
const env = require('../src/config/env');

(async () => {
  await connectDatabase();
  const tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) { console.error('No tenant — run `npm run seed` first.'); process.exit(1); }

  console.log('materializing summaries…');
  const result = await summaryBuilder.rebuildAll(tenant);
  console.log(`months: ${result.monthCount} (${result.months.join(', ')}) · technician-days: ${result.technicianDays}`);

  console.log(`\nbi_monthlycategorymetrics: ${await models.MonthlyCategoryMetric.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_monthlyroutemetrics:    ${await models.MonthlyRouteMetric.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_monthlycustomermetrics: ${await models.MonthlyCustomerMetric.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_dailytechnicianmetrics: ${await models.DailyTechnicianMetric.countDocuments({ tenantId: tenant._id })}`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('materialize failed:', e.message); process.exit(1); });
