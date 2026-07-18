'use strict';
const { models } = require('../../models');

async function loadDimensions(tenantId) {
  const [routes, employees, categories] = await Promise.all([
    models.Route.find({ tenantId }, { routeCode: 1 }).lean(),
    models.Employee.find({ tenantId }, { fullName: 1, department: 1 }).lean(),
    models.ServiceCategory.find({ tenantId }, { categoryCode: 1, name: 1 }).lean(),
  ]);
  return {
    route: new Map(routes.map((r) => [String(r._id), r.routeCode])),
    employee: new Map(employees.map((e) => [String(e._id), e])),
    category: new Map(categories.map((c) => [String(c._id), c])),
  };
}

const dec = (v) => (v == null ? 0 : Number(v.toString()));

function monthLabel(mk) {
  const [y, m] = String(mk).split('-');
  return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

module.exports = { loadDimensions, dec, monthLabel };
