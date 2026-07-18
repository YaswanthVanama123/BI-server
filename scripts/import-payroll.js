'use strict';

const fs = require('fs');
const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const { runImport } = require('../src/etl');
const adpPayroll = require('../src/etl/importers/adpPayroll');
const summaryBuilder = require('../src/services/analytics/rebuildSummaries');
const { parseCsv } = require('../src/etl/lib/csv');
const env = require('../src/config/env');

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  if (!args.file) { console.error('Usage: npm run import:payroll -- --file=payroll.csv'); process.exit(1); }
  if (!fs.existsSync(args.file)) { console.error(`File not found: ${args.file}`); process.exit(1); }

  await connectDatabase();
  const tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) { console.error('No tenant — run `npm run seed` first.'); process.exit(1); }

  const { rows, headers, errors } = parseCsv(fs.readFileSync(args.file));
  console.log(`parsed ${rows.length} rows; headers: ${headers.join(', ')}`);
  if (errors.length) console.log(`parse warnings: ${errors.slice(0, 3).map((e) => e.message).join('; ')}`);

  const batch = await runImport({ tenant, handler: adpPayroll, rows, fileMeta: { fileName: args.file, headers } });
  const availabilityDays = await summaryBuilder.allocateAvailability(tenant);

  console.log(`\nbatch ${batch.status}: ${JSON.stringify(batch.counts)}`);
  console.log(`bi_employees:          ${await models.Employee.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_payrollperiods:     ${await models.PayrollPeriod.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_payrollentries:     ${await models.PayrollEntry.countDocuments({ tenantId: tenant._id })}`);
  console.log(`bi_employeeavailability: ${await models.EmployeeAvailability.countDocuments({ tenantId: tenant._id })}`);
  console.log(`utilization days updated: ${availabilityDays}`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('payroll import failed:', e.message); process.exit(1); });
