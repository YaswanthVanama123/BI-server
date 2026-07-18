'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const { runImport } = require('../src/etl');
const inventoryItems = require('../src/etl/importers/inventoryItems');
const source = require('../src/etl/sources/inventoryDb');
const env = require('../src/config/env');

(async () => {
  await connectDatabase();
  const tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) { console.error('No tenant — run `npm run seed` first.'); process.exit(1); }
  if (!await models.ServiceCategory.exists({ tenantId: tenant._id, isUnmapped: true })) {
    console.error('No UNMAPPED category — run `npm run seed` first.'); process.exit(1);
  }

  const rows = await source.fetchItems();
  console.log(`fetched ${rows.length} routestaritems from ${env.sourceDbName}`);
  const batch = await runImport({ tenant, handler: inventoryItems, rows, fileMeta: { fileName: `${env.sourceDbName}.routestaritems` } });

  console.log(`\nbatch ${batch.status}: ${JSON.stringify(batch.counts)}`);
  console.log(`bi_serviceitems: ${await models.ServiceItem.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_itemcategorymappings: ${await models.ItemCategoryMapping.countDocuments({ tenantId: tenant._id })}`);
  console.log('\nNOTE: re-run `npm run import:invoices` then `npm run materialize` so line items pick up categories.');
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
