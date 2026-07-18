'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const { runImport } = require('../src/etl');
const inventoryPricing = require('../src/etl/importers/inventoryPricing');
const source = require('../src/etl/sources/inventoryDb');
const env = require('../src/config/env');

(async () => {
  await connectDatabase();
  const tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) { console.error('No tenant — run `npm run seed` first.'); process.exit(1); }
  if (!await models.ServiceCategory.exists({ tenantId: tenant._id, isUnmapped: true })) {
    console.error('No UNMAPPED category — run `npm run seed` first.'); process.exit(1);
  }

  const rows = await source.fetchCustomerPricing();
  console.log(`fetched ${rows.length} routestarcustomerpricings from ${env.sourceDbName}`);
  const batch = await runImport({ tenant, handler: inventoryPricing, rows, fileMeta: { fileName: `${env.sourceDbName}.routestarcustomerpricings` } });

  console.log(`\nbatch ${batch.status}: ${JSON.stringify(batch.counts)}`);
  console.log(`bi_customerpricingagreements: ${await models.CustomerPricingAgreement.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_customerpricingitems: ${await models.CustomerPricingItem.countDocuments({ tenantId: tenant._id })}`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
