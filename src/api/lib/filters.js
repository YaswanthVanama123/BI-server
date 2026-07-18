'use strict';

function parseFilters(query = {}, tenantId) {
  const startDate = query.startDate || defaultStart();
  const endDate = query.endDate || defaultEnd();
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(1000, Math.max(1, parseInt(query.pageSize, 10) || 100));

  return {
    tenantId,
    startDate,
    endDate,
    start: new Date(`${startDate}T00:00:00Z`),
    end: new Date(`${endDate}T23:59:59Z`),
    monthKeys: monthKeysBetween(startDate, endDate),
    routeCode: clean(query.routeCode),
    routeId: clean(query.routeId),
    technicianId: clean(query.technicianId),
    department: clean(query.department),
    customerId: clean(query.customerId),
    serviceCategoryId: clean(query.serviceCategoryId),
    customerStatus: clean(query.customerStatus),
    invoiceStatus: clean(query.invoiceStatus),
    frequency: clean(query.frequency),
    granularity: query.granularity || 'month',
    includeNonRevenue: query.includeNonRevenue === 'true',
    page,
    pageSize,
    skip: (page - 1) * pageSize,
  };
}

function clean(v) {
  if (v === undefined || v === null || v === '' || v === 'all') return undefined;
  return v;
}

function monthKeysBetween(startDate, endDate) {
  const out = [];
  let [y, m] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function defaultStart() {
  const d = new Date();
  return `${d.getUTCFullYear()}-01-01`;
}
function defaultEnd() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

module.exports = { parseFilters, monthKeysBetween };
