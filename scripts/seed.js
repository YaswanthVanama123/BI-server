'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const env = require('../src/config/env');

const CATEGORIES = [
  { categoryCode: 'RESTROOM_HYGIENE', name: 'Restroom & Hygiene', sortOrder: 1 },
  { categoryCode: 'DRAIN', name: 'Drain', sortOrder: 2 },
  { categoryCode: 'SCRUB', name: 'Scrub', sortOrder: 3 },
  { categoryCode: 'WINDOW', name: 'Window Cleaning', sortOrder: 4 },
  { categoryCode: 'SANI', name: 'Sani Products', sortOrder: 5 },
  { categoryCode: 'TRIP_CHARGE', name: 'Trip Charge', sortOrder: 6, isRevenueCategory: true },
  { categoryCode: 'OTHER', name: 'Other', sortOrder: 7 },
  { categoryCode: 'UNMAPPED', name: 'Unmapped', sortOrder: 99, isUnmapped: true },
];

const FREQUENCIES = [
  { normalizedFrequency: 'weekly', visitsPerYear: '52', sourceTextPatterns: ['weekly', 'wk'], isRecurring: true },
  { normalizedFrequency: 'biweekly', visitsPerYear: '26', sourceTextPatterns: ['bi-weekly', 'biweekly', 'every other week'], isRecurring: true },
  { normalizedFrequency: 'twice_monthly', visitsPerYear: '24', sourceTextPatterns: ['twice monthly', '2x month', 'semi-monthly'], isRecurring: true },
  { normalizedFrequency: 'monthly', visitsPerYear: '12', sourceTextPatterns: ['monthly', 'mo'], isRecurring: true },
  { normalizedFrequency: 'quarterly', visitsPerYear: '4', sourceTextPatterns: ['quarterly', 'qtr'], isRecurring: true },
  { normalizedFrequency: 'semiannual', visitsPerYear: '2', sourceTextPatterns: ['semi-annual', 'semiannual'], isRecurring: true },
  { normalizedFrequency: 'annual', visitsPerYear: '1', sourceTextPatterns: ['annual', 'yearly'], isRecurring: true },
  { normalizedFrequency: 'one_time', visitsPerYear: '1', sourceTextPatterns: ['one time', 'one-time', 'once'], isRecurring: false },
  { normalizedFrequency: 'unknown', visitsPerYear: '0', sourceTextPatterns: [], isRecurring: false },
];

const RULES = [
  { key: 'stopsPerDayBenchmark', value: 10, valueType: 'number' },
  { key: 'largeGapThresholdMinutes', value: 180, valueType: 'number' },
  { key: 'elapsedVarianceToleranceMinutes', value: 10, valueType: 'number' },
  { key: 'revenueAllocationMethod', value: 'proportional_by_line', valueType: 'string' },
  { key: 'excludeStatusesFromRevenue', value: ['void', 'credit'], valueType: 'json' },
  { key: 'salariedDefaultAvailableHours', value: 173, valueType: 'number' },
];

(async () => {
  await connectDatabase();

  let tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) {
    tenant = await models.Tenant.create({
      tenantCode: env.api.defaultTenantCode, name: 'EnviroMaster NRV',
      reportingTimezone: env.reporting.timezone, currency: 'USD', fiscalYearStartMonth: 1, active: true,
    });
  }
  const tenantId = tenant._id;
  console.log(`tenant: ${tenant.tenantCode}`);

  for (const c of CATEGORIES) {
    await models.ServiceCategory.updateOne(
      { tenantId, categoryCode: c.categoryCode },
      { $set: { tenantId, isRevenueCategory: c.isRevenueCategory !== false, isUnmapped: !!c.isUnmapped, ...c } },
      { upsert: true },
    );
  }
  for (const f of FREQUENCIES) {
    await models.FrequencyDefinition.updateOne(
      { tenantId, normalizedFrequency: f.normalizedFrequency },
      { $set: { tenantId, ...f } }, { upsert: true },
    );
  }
  const now = new Date();
  for (const r of RULES) {
    await models.BusinessRule.updateOne(
      { tenantId, key: r.key },
      { $set: { tenantId, ...r }, $setOnInsert: { effectiveStart: now } }, { upsert: true },
    );
  }

  console.log(`seeded: ${CATEGORIES.length} categories, ${FREQUENCIES.length} frequencies, ${RULES.length} business rules`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
