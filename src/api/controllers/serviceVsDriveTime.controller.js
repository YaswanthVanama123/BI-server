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

const TTL_MS = 300000;
function makeCache() {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (e && Date.now() - e.at < TTL_MS) return e.v; if (e) m.delete(k); return null; },
    set(k, v) { m.set(k, { at: Date.now(), v }); if (m.size > 300) m.delete(m.keys().next().value); },
  };
}
const stopsCache = makeCache();
const pairCache = makeCache();
const payloadCache = makeCache();

async function getAllStops(from, to) {
  const key = `${from || ''}|${to || ''}`;
  const cached = stopsCache.get(key);
  if (cached) return cached;

  const db = getSourceDb();
  const and = [CLOSED];
  if (from || to) {
    const start = new Date(`${from || to}T00:00:00.000Z`);
    const end = new Date(`${to || from}T23:59:59.999Z`);
    and.push({ $or: [{ dateCompleted: { $gte: start, $lte: end } }, { invoiceDate: { $gte: start, $lte: end } }] });
  }
  const invoices = await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: { _id: 0, invoiceNumber: 1, 'customer.name': 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1 } })
    .batchSize(5000)
    .limit(50000).toArray();

  const stops = [];
  for (const inv of invoices) {
    const dk = dayKey(inv.dateCompleted || inv.invoiceDate);
    if (!dk) continue;
    if (from && dk < from) continue;
    if (to && dk > to) continue;
    const rc = clean(inv.assignedTo) ? String(inv.assignedTo).trim().toUpperCase() : '(unassigned)';
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
  stopsCache.set(key, stops);
  return stops;
}

async function getStops(from, to, routeCode) {
  const all = await getAllStops(from, to);
  return routeCode ? all.filter((s) => s.routeCode === routeCode) : all;
}

async function getPairMap(tenantId) {
  const key = String(tenantId || 'default');
  const cached = pairCache.get(key);
  if (cached) return cached;
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
  pairCache.set(key, pairMap);
  return pairMap;
}

function buildPayload(stops, pairMap, from, to, routeCode, granularity) {
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
    [keyName]: o[keyName], service: round(o.service), drive: round(o.drive), idle: round(o.idle), gap: round(o.drive + o.idle), stops: o.stops, legs: o.legs,
  }));
  const series = fix([...bucketMap.values()], 'bucket').sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  const byRoute = fix([...routeMap.values()], 'routeCode').sort((a, b) => (b.service + b.drive) - (a.service + a.drive));
  const byTechnician = fix([...techMap.values()], 'technician').sort((a, b) => (b.service + b.drive) - (a.service + a.drive));
  const byRouteDay = [...routeDayMap.values()].map((o) => {
    const act = o.service + o.drive + o.idle;
    return { routeCode: o.routeCode, date: o.date, service: round(o.service), drive: round(o.drive), idle: round(o.idle), gap: round(o.drive + o.idle), stops: o.stops, legs: o.legs, servicePct: act ? round((o.service / act) * 100, 1) : 0 };
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

  return buildEnvelope({ kpis, series, byRoute, byTechnician, byRouteDay }, {
    meta: { source: 'inventory_db + bi_companydistances', from: from || null, to: to || null, routeCode: routeCode || null, granularity, unsyncedLegs: legs - syncedLegs },
  });
}

async function serviceVsDriveTime(req, res) {
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const routeCode = (clean(req.query.routeCode) || '').toUpperCase() || undefined;
  const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'month';

  const pkey = `svc|${from || ''}|${to || ''}|${routeCode || ''}|${granularity}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }

  const tenantId = await ensureTenantId(req);
  const [stops, pairMap] = await Promise.all([getStops(from, to, routeCode), getPairMap(tenantId)]);
  const payload = buildPayload(stops, pairMap, from, to, routeCode, granularity);
  payloadCache.set(pkey, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

function commonRanges() {
  const d = new Date();
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const today = iso(d);
  const week = new Date(d); week.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return [
    { from: `${d.getFullYear()}-01-01`, to: today },
    { from: iso(new Date(d.getFullYear(), d.getMonth(), 1)), to: today },
    { from: iso(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1)), to: today },
    { from: iso(week), to: today },
  ];
}

let warming = false;
async function warm() {
  if (warming) return;
  warming = true;
  try {
    const env = require('../../config/env');
    const t = await Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
    const tenantId = t ? t._id : null;
    const pairMap = await getPairMap(tenantId);
    for (const r of commonRanges()) {
      try {
        const stops = await getStops(r.from, r.to, undefined);
        payloadCache.set(`svc|${r.from}|${r.to}||month`, buildPayload(stops, pairMap, r.from, r.to, undefined, 'month'));
      } catch (e) { /* db not ready yet */ }
    }
  } catch (e) { /* ignore */ } finally { warming = false; }
}

function startWarmer() {
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, TTL_MS - 30000);
}

module.exports = { serviceVsDriveTime, warm, startWarmer };
