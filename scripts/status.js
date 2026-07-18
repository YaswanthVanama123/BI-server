'use strict';

const { connectDatabase, disconnectDatabase, getSourceDb } = require('../src/config/database');
const { models } = require('../src/models');
const env = require('../src/config/env');

(async () => {
  await connectDatabase();
  const tenant = await models.Tenant.findOne({ tenantCode: env.api.defaultTenantCode }).lean();
  console.log(`\ntenant '${env.api.defaultTenantCode}': ${tenant ? 'OK' : 'MISSING — run `npm run seed`'}`);
  const tid = tenant ? tenant._id : null;

  const biPairs = [
    ['bi_customers', models.Customer], ['bi_customerlocations', models.CustomerLocation],
    ['bi_routes', models.Route], ['bi_customerserviceschedules', models.CustomerServiceSchedule],
    ['bi_serviceitems', models.ServiceItem], ['bi_itemcategorymappings', models.ItemCategoryMapping],
    ['bi_customerpricingitems', models.CustomerPricingItem],
    ['bi_servicevisits', models.ServiceVisit], ['bi_invoices', models.Invoice], ['bi_invoicelineitems', models.InvoiceLineItem],
    ['bi_routelegs', models.RouteLeg],
    ['bi_employees', models.Employee], ['bi_payrollentries', models.PayrollEntry], ['bi_employeeavailability', models.EmployeeAvailability],
    ['bi_monthlycategorymetrics', models.MonthlyCategoryMetric], ['bi_monthlyroutemetrics', models.MonthlyRouteMetric],
    ['bi_monthlycustomermetrics', models.MonthlyCustomerMetric], ['bi_dailytechnicianmetrics', models.DailyTechnicianMetric],
  ];
  console.log('\n=== BI collections (tenant-scoped) ===');
  for (const [name, Model] of biPairs) {
    const n = tid ? await Model.countDocuments({ tenantId: tid }) : 0;
    console.log(`  ${String(n).padStart(8)}  ${name}`);
  }

  console.log('\n=== source (inventory_db) for comparison ===');
  const db = getSourceDb();
  for (const c of ['routestarcustomers', 'routestarcustomerroutes', 'routestaritems', 'routestarcustomerpricings', 'routestarinvoices']) {
    let n = 0; try { n = await db.collection(c).estimatedDocumentCount(); } catch { n = -1; }
    console.log(`  ${String(n).padStart(8)}  ${c}`);
  }
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('status failed:', e.message); process.exit(1); });
