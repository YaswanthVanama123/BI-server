'use strict';
const { models } = require('../../models');
const { parseFilters } = require('../lib/filters');
const { buildEnvelope } = require('../lib/envelope');
const { loadDimensions, dec } = require('./_dims');

const { PayrollEntry, MonthlyRouteMetric, MonthlyCustomerMetric } = models;

async function payrollCost(req, res) {
  const f = parseFilters(req.query, req.tenantId);
  const dims = await loadDimensions(f.tenantId);
  const entries = await PayrollEntry.find({ tenantId: f.tenantId, checkDate: { $gte: f.start, $lte: f.end } }).lean();
  const byEmp = new Map();
  for (const e of entries) {
    const k = String(e.employeeId);
    const a = byEmp.get(k) || { employeeId: e.employeeId, regularHours: 0, overtimeHours: 0, grossPay: 0, burdenedCost: 0, rate: dec(e.appliedRate) };
    const gross = dec(e.appliedRate) * dec(e.regularHours) + dec(e.salaryAmount) + dec(e.bonusAmount) + dec(e.commissionAmount);
    a.regularHours += dec(e.regularHours); a.overtimeHours += dec(e.overtimeHours);
    a.grossPay += gross; a.burdenedCost += dec(e.computedLaborCost) || gross * 1.35;
    byEmp.set(k, a);
  }
  const data = [...byEmp.values()].map((a) => {
    const emp = dims.employee.get(String(a.employeeId));
    return {
      technicianId: a.employeeId,
      employee: emp ? emp.fullName : String(a.employeeId),
      department: emp ? emp.department : null,
      appliedRate: round(a.rate), regularHours: round(a.regularHours), overtimeHours: round(a.overtimeHours),
      grossPay: round(a.grossPay), burdenedCost: round(a.burdenedCost),
    };
  }).sort((x, y) => y.burdenedCost - x.burdenedCost);
  res.json(buildEnvelope(data));
}

async function laborPerStop(req, res) {
  const f = parseFilters(req.query, req.tenantId);
  const dims = await loadDimensions(f.tenantId);
  const rows = await MonthlyRouteMetric.find({ tenantId: f.tenantId, monthKey: { $in: f.monthKeys } }).lean();
  const byR = new Map();
  for (const r of rows) {
    const k = String(r.routeId);
    const a = byR.get(k) || { routeId: r.routeId, stops: 0, laborCost: 0, revenue: 0 };
    a.stops += r.totalStops || 0; a.laborCost += dec(r.laborCost); a.revenue += dec(r.totalRevenue);
    byR.set(k, a);
  }
  const data = [...byR.values()].map((a) => {
    const laborPer = a.stops > 0 ? a.laborCost / a.stops : 0;
    const revPer = a.stops > 0 ? a.revenue / a.stops : 0;
    return {
      routeCode: dims.route.get(String(a.routeId)) || String(a.routeId),
      stops: a.stops, laborCost: round(a.laborCost),
      laborCostPerStop: round(laborPer), revenuePerStop: round(revPer),
      contributionPerStop: round(revPer - laborPer),
    };
  }).sort((x, y) => y.contributionPerStop - x.contributionPerStop);
  res.json(buildEnvelope(data, { meta: { source: 'materialized' } }));
}

async function routeProfitability(req, res) {
  const f = parseFilters(req.query, req.tenantId);
  const dims = await loadDimensions(f.tenantId);
  const rows = await MonthlyRouteMetric.find({ tenantId: f.tenantId, monthKey: { $in: f.monthKeys } }).lean();
  const wanted = req.params.routeCode && req.params.routeCode !== 'all' ? req.params.routeCode : null;
  const byR = new Map();
  for (const r of rows) {
    const k = String(r.routeId);
    const a = byR.get(k) || { routeId: r.routeId, totalRevenue: 0, stops: 0, laborCost: 0, supplyCost: 0, vehicleCost: 0, estContributionMargin: 0 };
    a.totalRevenue += dec(r.totalRevenue); a.stops += r.totalStops || 0;
    a.laborCost += dec(r.laborCost); a.supplyCost += dec(r.supplyCost); a.vehicleCost += dec(r.vehicleCost);
    a.estContributionMargin += dec(r.estContributionMargin);
    byR.set(k, a);
  }
  const data = [...byR.values()].map((a) => ({
    routeCode: dims.route.get(String(a.routeId)) || String(a.routeId),
    totalRevenue: round(a.totalRevenue), stops: a.stops,
    laborCost: round(a.laborCost), supplyCost: round(a.supplyCost), vehicleCost: round(a.vehicleCost),
    estContributionMargin: round(a.estContributionMargin),
    contributionPerStop: a.stops > 0 ? round(a.estContributionMargin / a.stops) : null,
    marginPct: a.totalRevenue > 0 ? round((a.estContributionMargin / a.totalRevenue) * 100, 1) : null,
  })).filter((r) => !wanted || r.routeCode === wanted).sort((x, y) => y.estContributionMargin - x.estContributionMargin);
  res.json(buildEnvelope(data, { meta: { source: 'materialized', vehicleCostBasis: 'UNCONFIRMED — see businessRules' } }));
}

async function customerProfitability(req, res) {
  const f = parseFilters(req.query, req.tenantId);
  const rows = await MonthlyCustomerMetric.find({ tenantId: f.tenantId, customerId: req.params.id, monthKey: { $in: f.monthKeys } }).lean();
  const totalRevenue = rows.reduce((s, r) => s + dec(r.totalRevenue), 0);
  const stopCount = rows.reduce((s, r) => s + (r.stopCount || 0), 0);
  const profit = rows.reduce((s, r) => s + dec(r.customerProfitability), 0);
  res.json(buildEnvelope([{
    customerId: req.params.id,
    totalRevenue: round(totalRevenue), stopCount,
    revenuePerStop: stopCount > 0 ? round(totalRevenue / stopCount) : null,
    customerProfitability: round(profit),
  }], { meta: { source: 'materialized' } }));
}

function round(n, d = 2) { const fx = 10 ** d; return Math.round(n * fx) / fx; }

module.exports = { payrollCost, laborPerStop, routeProfitability, customerProfitability };
