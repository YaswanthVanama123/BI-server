'use strict';
const { models, mongoose } = require('../../models');
const P = require('./aggregationPipelines');

const {
  ServiceVisit, RouteLeg, InvoiceLineItem,
  DailyTechnicianMetric, MonthlyRouteMetric, MonthlyCustomerMetric, MonthlyCategoryMetric,
  PayrollPeriod, EmployeeAvailability, BusinessRule,
} = models;

async function refreshDailyTechnician(tenant, keys, batch) {
  const now = new Date();
  const benchmark = await ruleNumber(tenant, 'stopsPerDayBenchmark', 10);
  for (const key of unique(keys)) {
    const [technicianId, dateKey] = key.split('|');
    const [base] = await ServiceVisit.aggregate(P.dailyTechnicianForKey(tenant._id, toId(technicianId), dateKey));
    if (!base) { await DailyTechnicianMetric.deleteOne({ tenantId: tenant._id, technicianId: toId(technicianId), dateKey }); continue; }
    const [drive] = await RouteLeg.aggregate(P.drivingTimeByTechDay(tenant._id, [dateKey]));
    const doc = {
      tenantId: tenant._id, technicianId: toId(technicianId), serviceDate: base.serviceDate,
      dateKey, isoWeek: base.isoWeek, monthKey: base.monthKey,
      routeIds: (base.routeIds || []).filter(Boolean),
      stopCount: base.stopCount, completedStops: base.completedStops, cancelledStops: base.cancelledStops,
      suspendedStops: base.suspendedStops, missedStops: base.missedStops,
      totalServiceMinutes: dec(base.totalServiceMinutes),
      loggedServiceHours: dec((base.totalServiceMinutes || 0) / 60),
      totalDrivingMinutes: dec(drive ? drive.drivingMinutes : 0),
      totalNonDrivingGapMinutes: dec(drive ? drive.nonDrivingGapMinutes : 0),
      benchmarkStopsPerDay: benchmark,
      stopsVsBenchmark: base.completedStops - benchmark,
      computedAt: now, sourceBatchIds: batch ? [batch._id] : [],
    };
    await DailyTechnicianMetric.updateOne(
      { tenantId: tenant._id, technicianId: toId(technicianId), dateKey },
      { $set: doc }, { upsert: true }
    );
  }
}

async function refreshMonthlyRoute(tenant, keys, batch) {
  const now = new Date();
  const byMonth = groupByMonth(keys);
  for (const [monthKey, routeIds] of byMonth) {
    const rows = await InvoiceLineItem.aggregate(P.revenueByRoute(tenant._id, monthKey));
    for (const r of rows) {
      if (!routeIds.has(String(r._id))) continue;
      await MonthlyRouteMetric.updateOne(
        { tenantId: tenant._id, routeId: r._id, monthKey },
        { $set: {
            tenantId: tenant._id, routeId: r._id, monthKey,
            lineItemRevenue: dec2(r.lineItemRevenue), totalRevenue: dec2(r.lineItemRevenue),
            revenueByCategory: collapseCategories(r.revenueByCategory),
            totalStops: r.stopCount, computedAt: now, sourceBatchIds: batch ? [batch._id] : [],
        } }, { upsert: true }
      );
    }
  }
}

async function refreshMonthlyCustomer(tenant, keys, batch) {
  const now = new Date();
  const byMonth = groupByMonth(keys);
  for (const [monthKey, customerIds] of byMonth) {
    const rows = await InvoiceLineItem.aggregate(P.revenueByCustomer(tenant._id, monthKey));
    for (const r of rows) {
      if (!customerIds.has(String(r._id))) continue;
      await MonthlyCustomerMetric.updateOne(
        { tenantId: tenant._id, customerId: r._id, monthKey },
        { $set: {
            tenantId: tenant._id, customerId: r._id, monthKey,
            totalRevenue: dec2(r.totalRevenue), recurringRevenue: dec2(r.recurringRevenue), oneTimeRevenue: dec2(r.oneTimeRevenue),
            revenueByCategory: collapseCategories(r.revenueByCategory),
            stopCount: r.stopCount, revenuePerStop: dec2(r.revenuePerStop),
            computedAt: now, sourceBatchIds: batch ? [batch._id] : [],
        } }, { upsert: true }
      );
    }
  }
}

async function refreshMonthlyCategory(tenant, monthKeys, batch) {
  const now = new Date();
  for (const monthKey of unique(monthKeys)) {
    const rows = await InvoiceLineItem.aggregate(P.revenueByCategory(tenant._id, monthKey));
    const monthTotal = rows.reduce((s, r) => s + Number((r.revenue || 0).toString()), 0) || 1;
    for (const r of rows) {
      const rev = Number((r.revenue || 0).toString());
      await MonthlyCategoryMetric.updateOne(
        { tenantId: tenant._id, serviceCategoryId: r._id, monthKey, routeId: 'ALL', technicianId: 'ALL' },
        { $set: {
            tenantId: tenant._id, serviceCategoryId: r._id, monthKey, routeId: 'ALL', technicianId: 'ALL',
            revenue: dec2(r.revenue), quantity: dec2(r.quantity),
            invoiceCount: r.invoiceCount, stopCount: r.stopCount,
            avgRevenuePerStop: dec2(r.avgRevenuePerStop), avgRevenuePerInvoice: dec2(r.avgRevenuePerInvoice),
            categoryRevenuePct: round((rev / monthTotal) * 100, 1),
            computedAt: now, sourceBatchIds: batch ? [batch._id] : [],
        } }, { upsert: true }
      );
    }
  }
}

async function nightlyFullRebuild(tenant, monthKeys, batch) {
  await refreshMonthlyCategory(tenant, monthKeys, batch);
  for (const monthKey of monthKeys) {
    const routeRows = await InvoiceLineItem.aggregate([{ $match: { tenantId: tenant._id, monthKey } }, { $group: { _id: '$routeId' } }]);
    await refreshMonthlyRoute(tenant, routeRows.map((r) => `${r._id}|${monthKey}`), batch);
    const custRows = await InvoiceLineItem.aggregate([{ $match: { tenantId: tenant._id, monthKey } }, { $group: { _id: '$customerId' } }]);
    await refreshMonthlyCustomer(tenant, custRows.map((r) => `${r._id}|${monthKey}`), batch);
  }
}

async function distinctMonthKeys(tenant) {
  const [a, b] = await Promise.all([
    InvoiceLineItem.distinct('monthKey', { tenantId: tenant._id }),
    ServiceVisit.distinct('monthKey', { tenantId: tenant._id }),
  ]);
  return unique([...a, ...b].filter(Boolean)).sort();
}

async function allTechDateKeys(tenant) {
  const rows = await ServiceVisit.aggregate([
    { $match: { tenantId: tenant._id, technicianId: { $ne: null } } },
    { $group: { _id: { t: '$technicianId', d: '$dateKey' } } },
  ]);
  return rows.map((r) => `${r._id.t}|${r._id.d}`);
}

async function rebuildAll(tenant, batch) {
  const months = await distinctMonthKeys(tenant);
  await nightlyFullRebuild(tenant, months, batch);
  const techKeys = await allTechDateKeys(tenant);
  await refreshDailyTechnician(tenant, techKeys, batch);
  const alloc = await allocateAvailability(tenant);
  return { months, monthCount: months.length, technicianDays: techKeys.length, availabilityDays: alloc };
}

async function allocateAvailability(tenant) {
  const periods = await PayrollPeriod.find({ tenantId: tenant._id }, { periodStart: 1, periodEnd: 1 }).lean();
  const periodById = new Map(periods.map((p) => [String(p._id), p]));
  const avails = await EmployeeAvailability.find({ tenantId: tenant._id }).lean();
  let touched = 0;
  for (const a of avails) {
    const p = periodById.get(String(a.payrollPeriodId));
    if (!p) continue;
    const available = Number((a.availableHours || 0).toString());
    const startKey = p.periodStart.toISOString().slice(0, 10);
    const endKey = p.periodEnd.toISOString().slice(0, 10);
    const days = await DailyTechnicianMetric.find(
      { tenantId: tenant._id, technicianId: a.employeeId, dateKey: { $gte: startKey, $lte: endKey } },
      { loggedServiceHours: 1, completedStops: 1 },
    ).lean();
    const working = days.filter((d) => (d.completedStops || 0) > 0);
    if (!working.length || available <= 0) continue;
    const perDay = available / working.length;
    for (const d of working) {
      const logged = Number((d.loggedServiceHours || 0).toString());
      const util = perDay > 0 ? round((logged / perDay) * 100, 1) : null;
      await DailyTechnicianMetric.updateOne(
        { _id: d._id },
        { $set: { availableHours: dec(perDay), utilizationPercentage: util != null ? dec(util) : null } },
      );
      touched += 1;
    }
  }
  return touched;
}

function unique(a) { return [...new Set(a)]; }
function toId(v) { return typeof v === 'string' ? new mongoose.Types.ObjectId(v) : v; }
function dec(n) { return mongoose.Types.Decimal128.fromString(String(Number(n || 0).toFixed(4))); }
function dec2(d) { return d == null ? undefined : mongoose.Types.Decimal128.fromString(Number(d.toString()).toFixed(4)); }
function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }
function groupByMonth(keys) {
  const m = new Map();
  for (const k of unique(keys)) { const [id, month] = k.split('|'); if (!m.has(month)) m.set(month, new Set()); m.get(month).add(id); }
  return m;
}
function collapseCategories(arr) {
  const m = new Map();
  for (const c of arr || []) { const k = String(c.serviceCategoryId); m.set(k, (m.get(k) || 0) + Number((c.revenue || 0).toString())); }
  return [...m].map(([serviceCategoryId, revenue]) => ({ serviceCategoryId: toId(serviceCategoryId), revenue: dec(revenue) }));
}
async function ruleNumber(tenant, key, fallback) {
  const r = await BusinessRule.findOne({ tenantId: tenant._id, key, $or: [{ effectiveEnd: null }, { effectiveEnd: { $gte: new Date() } }] }).sort({ effectiveStart: -1 });
  return r ? Number(r.value) : fallback;
}

module.exports = {
  refreshDailyTechnician, refreshMonthlyRoute, refreshMonthlyCustomer, refreshMonthlyCategory,
  nightlyFullRebuild, rebuildAll, allocateAvailability, distinctMonthKeys, allTechDateKeys,
};
