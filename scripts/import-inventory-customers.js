'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const { runImport } = require('../src/etl');
const inventoryCustomers = require('../src/etl/importers/inventoryCustomers');
const source = require('../src/etl/sources/inventoryDb');
const env = require('../src/config/env');

(async () => {
  await connectDatabase();

  let tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) {
    tenant = await models.Tenant.create({
      tenantCode: env.api.defaultTenantCode,
      name: 'EnviroMaster NRV',
      reportingTimezone: env.reporting.timezone,
      currency: 'USD',
      fiscalYearStartMonth: 1,
      active: true,
    });
    console.log(`created tenant ${tenant.tenantCode}`);
  }

  const rows = await source.fetchCustomers();
  console.log(`fetched ${rows.length} routestarcustomers from ${env.sourceDbName}`);

  const batch = await runImport({
    tenant,
    handler: inventoryCustomers,
    rows,
    fileMeta: { fileName: `${env.sourceDbName}.routestarcustomers` },
  });

  console.log(`\nbatch ${batch.status}: ${JSON.stringify(batch.counts)}`);
  console.log(`customers now in BI: ${await models.Customer.countDocuments({ tenantId: tenant._id })}`);
  console.log(`locations now in BI: ${await models.CustomerLocation.countDocuments({ tenantId: tenant._id })}`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
