'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');

const { CompanyDistance, Tenant } = models;

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const round = (n, d = 1) => { const f = 10 ** d; return Math.round(n * f) / f; };
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };

function toMinutes(s) {
  const m = String(s || '').trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function bucketKey(dk, granularity) {
  if (!dk) return null;
  if (granularity === 'day') return dk;
  if (granularity === 'week') {
    const d = new Date(`${dk}T00:00:00.000Z`);
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  }
  return dk.slice(0, 7);
}

async function ensureTenantId(req) {
  if (req.tenantId) return req.tenantId;
  const env = require('../../config/env');
  const t = await Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  return t ? t._id : null;
}

async function serviceVsDriveTime(req, res) {
  const db = getSourceDb();
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const routeCode = (clean(req.query.routeCode) || '').toUpperCase() || undefined;
  const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'month';

  const and = [CLOSED];
  if (from || to) {
    const start = new Date(`${from || to}T00:00:00.000Z`);
    const end = new Date(`${to || from}T23:59:59.999Z`);
    and.push({ $or: [{ dateCompleted: { $gte: start, $lte: end } }, { invoiceDate: { $gte: start, $lte: end } }] });
  }
  const invoices = await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: { invoiceNumber: 1, customer: 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1 } })
    .limit(50000).toArray();

  const stops = [];
  for (const inv of invoices) {
    const dk = dayKey(inv.dateCompleted || inv.invoiceDate);
    if (!dk) continue;
    const rc = clean(inv.assignedTo) ? String(inv.assignedTo).trim().toUpperCase() : '(unassigned)';
    if (routeCode && rc !== routeCode) continue;
    const arr = toMinutes(inv.arrivalTime);
    const dep = toMinutes(inv.departureTime);
    stops.push({
      technician: rc,
      routeCode: rc,
      dateKey: dk,
      customer: (inv.customer && inv.customer.name) || '',
      arr, dep,
      service: (arr != null && dep != null && dep >= arr) ? dep - arr : null,
    });
  }

  const tenantId = await ensureTenantId(req);
  const pairMap = new Map();
  if (tenantId) {
    const pairs = await CompanyDistance.find(
      { tenantId, drivingMinutes: { $ne: null } },
      { fromCompany: 1, toCompany: 1, drivingMinutes: 1, distanceMiles: 1 },
    ).lean();
    for (const p of pairs) {
      const k = `${normName(p.fromCompany)}||${normName(p.toCompany)}`;
      if (!pairMap.has(k)) pairMap.set(k, p);
    }
  }

  const bucketMap = new Map();
  const routeMap = new Map();
  const techMap = new Map();
  const routeDayMap = new Map();
  const bump = (map, key, seed, add) => { const cur = map.get(key) || seed(); add(cur); map.set(key, cur); };
  const seed = (extra) => () => ({ service: 0, drive: 0, idle: 0, stops: 0, legs: 0, ...extra });

  let totalService = 0; let totalDrive = 0; let totalIdle = 0; let legs = 0; let syncedLegs = 0; let distance = 0;
  const techDays = new Set();
  const days = new Set();

  for (const s of stops) {
    const b = bucketKey(s.dateKey, granularity);
    if (s.service != null) {
      totalService += s.service;
      bump(bucketMap, b, seed({ bucket: b }), (o) => { o.service += s.service; o.stops += 1; });
      bump(routeMap, s.routeCode, seed({ routeCode: s.routeCode }), (o) => { o.service += s.service; o.stops += 1; });
      bump(techMap, s.technician, seed({ technician: s.technician }), (o) => { o.service += s.service; o.stops += 1; });
    } else {
      bump(bucketMap, b, seed({ bucket: b }), (o) => { o.stops += 1; });
      bump(routeMap, s.routeCode, seed({ routeCode: s.routeCode }), (o) => { o.stops += 1; });
      bump(techMap, s.technician, seed({ technician: s.technician }), (o) => { o.stops += 1; });
    }
    days.add(s.dateKey);
    techDays.add(`${s.technician}||${s.dateKey}`);
    bump(routeDayMap, `${s.routeCode}||${s.dateKey}`, seed({ routeCode: s.routeCode, date: s.dateKey }), (o) => { if (s.service != null) o.service += s.service; o.stops += 1; });
  }

  const byTechDay = new Map();
  for (const s of stops) { const k = `${s.technician}||${s.dateKey}`; if (!byTechDay.has(k)) byTechDay.set(k, []); byTechDay.get(k).push(s); }
  for (const arr of byTechDay.values()) {
    arr.sort((a, b) => (a.arr ?? a.dep ?? 1e9) - (b.arr ?? b.dep ?? 1e9));
    for (let i = 0; i < arr.length - 1; i++) {
      const cur = arr[i]; const nxt = arr[i + 1];
      if (cur.dep == null || nxt.arr == null) continue;
      const gap = nxt.arr - cur.dep;
      if (gap < 0) continue;
      const pair = pairMap.get(`${normName(cur.customer)}||${normName(nxt.customer)}`);
      const drive = pair && pair.drivingMinutes != null ? pair.drivingMinutes : null;
      legs += 1;
      const b = bucketKey(cur.dateKey, granularity);
      if (drive != null) {
        syncedLegs += 1;
        const idle = Math.max(0, gap - drive);
        totalDrive += drive; totalIdle += idle; distance += (pair.distanceMiles || 0);
        bump(bucketMap, b, seed({ bucket: b }), (o) => { o.drive += drive; o.idle += idle; o.legs += 1; });
        bump(routeMap, cur.routeCode, seed({ routeCode: cur.routeCode }), (o) => { o.drive += drive; o.idle += idle; o.legs += 1; });
        bump(techMap, cur.technician, seed({ technician: cur.technician }), (o) => { o.drive += drive; o.idle += idle; o.legs += 1; });
        bump(routeDayMap, `${cur.routeCode}||${cur.dateKey}`, seed({ routeCode: cur.routeCode, date: cur.dateKey }), (o) => { o.drive += drive; o.idle += idle; o.legs += 1; });
      }
    }
  }

  const fix = (arr, keyName) => arr.map((o) => ({
    [keyName]: o[keyName], service: round(o.service), drive: round(o.drive), idle: round(o.idle), stops: o.stops, legs: o.legs,
  }));
  const series = fix([...bucketMap.values()], 'bucket').sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  const byRoute = fix([...routeMap.values()], 'routeCode').sort((a, b) => (b.service + b.drive) - (a.service + a.drive));
  const byTechnician = fix([...techMap.values()], 'technician').sort((a, b) => (b.service + b.drive) - (a.service + a.drive));
  const byRouteDay = [...routeDayMap.values()].map((o) => {
    const act = o.service + o.drive + o.idle;
    return { routeCode: o.routeCode, date: o.date, service: round(o.service), drive: round(o.drive), idle: round(o.idle), stops: o.stops, legs: o.legs, servicePct: act ? round((o.service / act) * 100, 1) : 0 };
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.routeCode).localeCompare(String(b.routeCode)));

  const stopCount = stops.length;
  const active = totalService + totalDrive + totalIdle;
  const kpis = {
    stops: stopCount,
    technicians: new Set(stops.map((s) => s.technician)).size,
    days: days.size,
    serviceMinutes: round(totalService),
    driveMinutes: round(totalDrive),
    idleMinutes: round(totalIdle),
    legs, syncedLegs,
    distanceMiles: round(distance, 1),
    servicePct: active ? round((totalService / active) * 100, 1) : 0,
    drivePct: active ? round((totalDrive / active) * 100, 1) : 0,
    idlePct: active ? round((totalIdle / active) * 100, 1) : 0,
    avgServicePerStop: stopCount ? round(totalService / stopCount, 1) : 0,
    avgDrivePerLeg: syncedLegs ? round(totalDrive / syncedLegs, 1) : 0,
  };

  res.json(buildEnvelope({ kpis, series, byRoute, byTechnician, byRouteDay }, {
    meta: { source: 'inventory_db + bi_companydistances', from: from || null, to: to || null, routeCode: routeCode || null, granularity, unsyncedLegs: legs - syncedLegs },
  }));
}

module.exports = { serviceVsDriveTime };
