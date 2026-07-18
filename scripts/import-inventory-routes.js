'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const { runImport } = require('../src/etl');
const inventoryRoutes = require('../src/etl/importers/inventoryRoutes');
const source = require('../src/etl/sources/inventoryDb');
const env = require('../src/config/env');

(async () => {
  await connectDatabase();
  const tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) { console.error('No tenant — run `npm run seed` first.'); process.exit(1); }

  const rows = await source.fetchCustomerRoutes();
  console.log(`fetched ${rows.length} routestarcustomerroutes from ${env.sourceDbName}`);
  const batch = await runImport({ tenant, handler: inventoryRoutes, rows, fileMeta: { fileName: `${env.sourceDbName}.routestarcustomerroutes` } });

  console.log(`\nbatch ${batch.status}: ${JSON.stringify(batch.counts)}`);
  console.log(`bi_routes: ${await models.Route.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_customerserviceschedules: ${await models.CustomerServiceSchedule.countDocuments({ tenantId: tenant._id })}`);
  console.log(`customers with defaultRoute: ${await models.Customer.countDocuments({ tenantId: tenant._id, defaultRouteId: { $ne: null } })}`);
  console.log('\nNOTE: re-run `npm run import:invoices` then `npm run materialize` so invoices attribute to routes.');
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
