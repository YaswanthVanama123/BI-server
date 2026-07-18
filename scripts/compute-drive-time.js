'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const { discover, discoverFromMapDistance, syncDrivingTimes } = require('../src/services/mapbox/routeDriveTime');
const env = require('../src/config/env');

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  await connectDatabase();
  if (!env.mapbox.token) console.warn('WARNING: MAPBOX_TOKEN not set — pairs will be discovered but driving times cannot be computed.');

  let tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) {
    tenant = await models.Tenant.create({ tenantCode: env.api.defaultTenantCode, name: 'EnviroMaster NRV', reportingTimezone: env.reporting.timezone, currency: 'USD', fiscalYearStartMonth: 1, active: true });
    console.log(`created tenant ${tenant.tenantCode}`);
  }

  const useMapDistance = env.enviromaster.mongoUri && !args.invoices;
  if (useMapDistance) {
    const d = await discoverFromMapDistance(tenant);
    console.log(`discovered from mapdistancerecords: ${d.records} records → ${d.pairs} distinct company pairs (${d.customers} customers, source matched ${d.matchedSource}, dest unresolved ${d.unresolvedDest})`);
    const legs = await discover(tenant, { registerPairs: false });
    console.log(`route legs (from inventory closed invoices): ${legs.legs} across ${legs.groups} route-days`);
  } else {
    const d = await discover(tenant, { from: args.from, to: args.to });
    console.log(`discovered ${d.legs} legs across ${d.groups} route-days, ${d.pairs} distinct company pairs`);
  }

  const batch = Number(args.batch) || 1000;
  let totalSynced = 0; let totalFailed = 0; let totalGeocoded = 0; let prevRemaining = Infinity;
  for (;;) {
    const s = await syncDrivingTimes(tenant, { limit: batch });
    totalSynced += s.synced; totalFailed += s.failed; totalGeocoded += s.geocoded;
    console.log(`  batch: +${s.synced} synced, +${s.failed} failed, +${s.geocoded} geocoded, ${s.remaining} still pending`);
    if (s.processed === 0 || s.remaining === 0 || s.remaining >= prevRemaining) break;
    prevRemaining = s.remaining;
  }
  console.log(`sync total: ${totalSynced} synced, ${totalFailed} failed, ${totalGeocoded} geocoded`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('drive sync failed:', e.message); process.exit(1); });
