'use strict';
const { models } = require('../../models');
const { parseFilters } = require('../lib/filters');
const { buildEnvelope } = require('../lib/envelope');
const { loadDimensions, dec, monthLabel } = require('./_dims');

const {
  DailyTechnicianMetric, MonthlyRouteMetric, ServiceVisit, RouteLeg,
} = models;

async function utilization(req, res) {
  const f = parseFilters(req.query, req.tenantId);
  const dims = await loadDimensions(f.tenantId);
  const q = { tenantId: f.tenantId, monthKey: { $in: f.monthKeys } };
  if (f.technicianId) q.technicianId = f.technicianId;
  const daily = await DailyTechnicianMetric.find(q).lean();

  const byTech = new Map();
  for (const d of daily) {
    const k = String(d.technicianId);
    const agg = byTech.get(k) || { technicianId: d.technicianId, completedStops: 0, loggedServiceHours: 0, availableHours: 0, totalDrivingMinutes: 0 };
    agg.completedStops += d.completedStops || 0;
    agg.loggedServiceHours += dec(d.loggedServiceHours);
    agg.availableHours += dec(d.availableHours);
    agg.totalDrivingMinutes += dec(d.totalDrivingMinutes);
    byTech.set(k, agg);
  }
  const data = [...byTech.values()].map((a) => {
    const emp = dims.employee.get(String(a.technicianId));
    return {
      technicianId: a.technicianId,
      technician: emp ? emp.fullName : String(a.technicianId),
      department: emp ? emp.department : null,
      completedStops: a.completedStops,
      loggedServiceHours: round(a.loggedServiceHours),
      availableHours: round(a.availableHours),
      utilizationPercentage: a.availableHours > 0 ? round((a.loggedServiceHours / a.availableHours) * 100, 1) : null,
      totalDrivingMinutes: round(a.totalDrivingMinutes),
    };
  });
  res.json(buildEnvelope(data, { meta: { source: 'materialized' } }));
}

async function stops(req, res) {
  const f = parseFilters(req.query, req.tenantId);
  const dims = await loadDimensions(f.tenantId);
  const benchmark = await getRuleNumber(f.tenantId, 'stopsPerDayBenchmark', 10);
  const q = { tenantId: f.tenantId, monthKey: { $in: f.monthKeys } };
  if (f.technicianId) q.technicianId = f.technicianId;
  const daily = await DailyTechnicianMetric.find(q).lean();

  const byTech = new Map();
  for (const d of daily) {
    const k = String(d.technicianId);
    const agg = byTech.get(k) || { technicianId: d.technicianId, totalStops: 0, workingDays: 0, totalServiceMinutes: 0 };
    agg.totalStops += d.completedStops || 0;
    if ((d.completedStops || 0) > 0) agg.workingDays += 1;
    agg.totalServiceMinutes += dec(d.totalServiceMinutes);
    byTech.set(k, agg);
  }
  const data = [...byTech.values()].map((a) => {
    const emp = dims.employee.get(String(a.technicianId));
    const avg = a.workingDays > 0 ? round(a.totalStops / a.workingDays, 1) : 0;
    return {
      technicianId: a.technicianId,
      technician: emp ? emp.fullName : String(a.technicianId),
      department: emp ? emp.department : null,
      totalStops: a.totalStops,
      workingDays: a.workingDays,
      avgStopsPerWorkingDay: avg,
      benchmark,
      stopsVsBenchmark: round(avg - benchmark, 1),
      totalServiceMinutes: round(a.totalServiceMinutes),
    };
  });
  res.json(buildEnvelope(data, { meta: { source: 'materialized', benchmark } }));
}

async function volumeTrends(req, res) {
  const f = parseFilters(req.query, req.tenantId);
  const match = { tenantId: f.tenantId, monthKey: { $in: f.monthKeys } };
  if (f.technicianId) match.technicianId = f.technicianId;
  if (f.routeId) match.routeId = f.routeId;
  const rows = await ServiceVisit.aggregate([
    { $match: match },
    { $group: {
      _id: '$monthKey',
      completed: { $sum: { $cond: [{ $eq: ['$completionStatus', 'completed'] }, 1, 0] } },
      cancelled: { $sum: { $cond: [{ $eq: ['$completionStatus', 'cancelled'] }, 1, 0] } },
      suspended: { $sum: { $cond: [{ $eq: ['$completionStatus', 'suspended'] }, 1, 0] } },
      missed: { $sum: { $cond: [{ $eq: ['$completionStatus', 'missed'] }, 1, 0] } },
    } },
    { $sort: { _id: 1 } },
  ]);
  const data = rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1].completed : null;
    return {
      monthKey: r._id, month: monthLabel(r._id),
      completed: r.completed, cancelled: r.cancelled, suspended: r.suspended, missed: r.missed,
      momChangePct: prev ? round(((r.completed - prev) / prev) * 100, 1) : null,
    };
  });
  res.json(buildEnvelope(data));
}

async function monthlyByRoute(req, res) {
  const f = parseFilters(req.query, req.tenantId);
  const dims = await loadDimensions(f.tenantId);
  const rows = await MonthlyRouteMetric.find({ tenantId: f.tenantId, monthKey: { $in: f.monthKeys } }, { routeId: 1, monthKey: 1, totalStops: 1 }).lean();
  const data = rows
    .map((r) => ({ monthKey: r.monthKey, month: monthLabel(r.monthKey), routeCode: dims.route.get(String(r.routeId)) || String(r.routeId), stops: r.totalStops || 0 }))
    .filter((r) => !f.routeCode || r.routeCode === f.routeCode);
  res.json(buildEnvelope(data, { meta: { source: 'materialized' } }));
}

async function checkins(req, res) {
  const f = parseFilters(req.query, req.tenantId);
  const dims = await loadDimensions(f.tenantId);
  const q = { tenantId: f.tenantId, technicianId: req.params.id };
  if (req.query.date) q.dateKey = req.query.date;
  else q.serviceDate = { $gte: f.start, $lte: f.end };
  const visits = await ServiceVisit.find(q).sort({ arrivalAt: 1 }).limit(500).lean();
  const custIds = [...new Set(visits.map((v) => String(v.customerId)))];
  const customers = await models.Customer.find({ _id: { $in: custIds } }, { customerName: 1 }).lean();
  const custMap = new Map(customers.map((c) => [String(c._id), c.customerName]));
  const legs = await RouteLeg.find({ fromVisitId: { $in: visits.map((v) => v._id) } }, { fromVisitId: 1, mapboxDurationMinutes: 1, nonDrivingGapMinutes: 1 }).lean();
  const legMap = new Map(legs.map((l) => [String(l.fromVisitId), l]));
  const data = visits.map((v) => {
    const leg = legMap.get(String(v._id));
    return {
      visitId: v._id,
      customer: custMap.get(String(v.customerId)) || String(v.customerId),
      route: dims.route.get(String(v.routeId)) || null,
      checkIn: v.arrivalLocal ? v.arrivalLocal.slice(11, 16) : null,
      checkOut: v.departureLocal ? v.departureLocal.slice(11, 16) : null,
      serviceMinutes: dec(v.serviceDurationMinutes),
      sourceElapsedMinutes: dec(v.sourceElapsedTimeMinutes),
      elapsedStatus: v.elapsedTimeValidationStatus,
      driveToNextMinutes: leg ? leg.mapboxDurationMinutes : null,
      nonDrivingGapToNextMinutes: leg ? dec(leg.nonDrivingGapMinutes) : null,
    };
  });
  res.json(buildEnvelope(data));
}

async function routeLegs(req, res) {
  const f = parseFilters(req.query, req.tenantId);
  const dims = await loadDimensions(f.tenantId);
  const q = { tenantId: f.tenantId, serviceDate: { $gte: f.start, $lte: f.end } };
  if (f.technicianId) q.technicianId = f.technicianId;
  if (f.routeId) q.routeId = f.routeId;
  const legs = await RouteLeg.find(q).limit(2000).lean();
  const custIds = [...new Set(legs.flatMap((l) => [String(l.fromCustomerId), String(l.toCustomerId)]))];
  const customers = await models.Customer.find({ _id: { $in: custIds } }, { customerName: 1 }).lean();
  const custMap = new Map(customers.map((c) => [String(c._id), c.customerName]));
  const data = legs.map((l) => ({
    serviceDate: l.dateKey,
    technician: dims.employee.get(String(l.technicianId))?.fullName || null,
    routeCode: dims.route.get(String(l.routeId)) || null,
    fromCustomer: custMap.get(String(l.fromCustomerId)) || null,
    toCustomer: custMap.get(String(l.toCustomerId)) || null,
    observedGapMinutes: dec(l.observedGapMinutes),
    mapboxDurationMinutes: l.mapboxDurationMinutes,
    mapboxDistanceMiles: l.mapboxDistanceMiles,
    nonDrivingGapMinutes: dec(l.nonDrivingGapMinutes),
    calculationStatus: l.calculationStatus,
  }));
  res.json(buildEnvelope(data));
}

function round(n, d = 2) { const f = 10 ** d; return Math.round(n * f) / f; }

async function getRuleNumber(tenantId, key, fallback) {
  const r = await models.BusinessRule.findOne({
    tenantId, key, $or: [{ effectiveEnd: null }, { effectiveEnd: { $gte: new Date() } }],
  }).sort({ effectiveStart: -1 }).lean();
  return r ? Number(r.value) : fallback;
}

module.exports = { utilization, stops, volumeTrends, monthlyByRoute, checkins, routeLegs };
