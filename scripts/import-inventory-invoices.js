'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const { runImport } = require('../src/etl');
const inventoryClosedInvoices = require('../src/etl/importers/inventoryClosedInvoices');
const source = require('../src/etl/sources/inventoryDb');
const env = require('../src/config/env');

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true];
  }));
  await connectDatabase();

  const tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) { console.error('No tenant — run `npm run seed` first.'); process.exit(1); }
  if (!await models.ServiceCategory.exists({ tenantId: tenant._id, isUnmapped: true })) {
    console.error('No UNMAPPED service category — run `npm run seed` first.'); process.exit(1);
  }

  const limit = args.limit ? parseInt(args.limit, 10) : 0;
  const rows = await source.fetchClosedInvoices({ limit });
  console.log(`fetched ${rows.length} closed invoices from ${env.sourceDbName}${limit ? ` (limit ${limit})` : ''}`);

  const batch = await runImport({
    tenant, handler: inventoryClosedInvoices, rows,
    fileMeta: { fileName: `${env.sourceDbName}.routestarinvoices` },
  });

  console.log(`\nbatch ${batch.status}: ${JSON.stringify(batch.counts)}`);
  console.log(`reconciliation: ${JSON.stringify(batch.reconciliation)}`);
  console.log(`bi_servicevisits: ${await models.ServiceVisit.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_invoices:      ${await models.Invoice.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_invoicelineitems: ${await models.InvoiceLineItem.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_employees (tech shells): ${await models.Employee.countDocuments({ tenantId: tenant._id })}`);
  const open = await models.DataQualityIssue.countDocuments({ tenantId: tenant._id, resolutionStatus: 'open' });
  console.log(`open data-quality issues: ${open}`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
