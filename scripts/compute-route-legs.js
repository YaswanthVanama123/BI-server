'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const { recalcRouteLegsForKeys } = require('../src/services/mapbox/routeLegCalculator');
const summaryBuilder = require('../src/services/analytics/rebuildSummaries');
const env = require('../src/config/env');

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  await connectDatabase();
  const tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) { console.error('No tenant — run `npm run seed` first.'); process.exit(1); }
  if (!env.mapbox.token) console.warn('WARNING: MAPBOX_TOKEN not set — legs will be stored but marked "mapbox_failed".');

  let keys = await summaryBuilder.allTechDateKeys(tenant);
  if (args.limit) keys = keys.slice(0, parseInt(args.limit, 10));
  console.log(`computing route legs for ${keys.length} technician-days…`);
  await recalcRouteLegsForKeys(tenant, keys, null);
  await summaryBuilder.refreshDailyTechnician(tenant, keys, null);

  const total = await models.RouteLeg.countDocuments({ tenantId: tenant._id });
  const byStatus = await models.RouteLeg.aggregate([
    { $match: { tenantId: tenant._id } }, { $group: { _id: '$calculationStatus', n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]);
  console.log(`\nbi_routelegs: ${total}`);
  byStatus.forEach((s) => console.log(`  ${s._id}: ${s.n}`));
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('compute legs failed:', e.message); process.exit(1); });
