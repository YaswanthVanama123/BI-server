'use strict';
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const round = (n, d = 1) => { const f = 10 ** d; return Math.round(n * f) / f; };
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toMinutes(s) {
  const m = String(s || '').trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
function bucketKey(dk, g) {
  if (!dk) return null;
  if (g === 'day') return dk;
  if (g === 'week') { const d = new Date(`${dk}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
  return dk.slice(0, 7);
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
const payloadCache = makeCache();

function parseParams(req) {
  return {
    from: clean(req.query.from),
    to: clean(req.query.to),
    routeCode: (clean(req.query.routeCode) || '').toUpperCase() || undefined,
  };
}

async function getStops(from, to, routeCode) {
  const key = `${from || ''}|${to || ''}|${routeCode || ''}`;
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
    .find({ $and: and }, { projection: { _id: 0, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1 } })
    .batchSize(5000)
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
      routeCode: rc, dateKey: dk,
      arr, dep,
      service: (arr != null && dep != null && dep >= arr) ? dep - arr : null,
    });
  }
  stopsCache.set(key, stops);
  return stops;
}

function perTechDay(stops) {
  const g = new Map();
  for (const s of stops) {
    const k = `${s.technician}||${s.dateKey}`;
    if (!g.has(k)) g.set(k, { technician: s.technician, dateKey: s.dateKey, stops: [], service: 0 });
    const o = g.get(k); o.stops.push(s); o.service += s.service || 0;
  }
  const out = [];
  for (const o of g.values()) {
    const arrs = o.stops.map((s) => s.arr).filter((x) => x != null);
    const deps = o.stops.map((s) => s.dep).filter((x) => x != null);
    const firstArr = arrs.length ? Math.min(...arrs) : null;
    const lastDep = deps.length ? Math.max(...deps) : null;
    const span = (firstArr != null && lastDep != null && lastDep >= firstArr) ? lastDep - firstArr : null;
    out.push({ technician: o.technician, dateKey: o.dateKey, stopCount: o.stops.length, service: o.service, span: span || 0 });
  }
  return out;
}

function buildUtilization(stops, from, to, routeCode) {
  const days = perTechDay(stops);
  const byTech = new Map();
  for (const d of days) {
    const o = byTech.get(d.technician) || { technician: d.technician, stops: 0, days: 0, service: 0, span: 0 };
    o.stops += d.stopCount; o.days += 1; o.service += d.service; o.span += d.span;
    byTech.set(d.technician, o);
  }
  const rows = [...byTech.values()].map((o) => ({
    technician: o.technician, stops: o.stops, days: o.days,
    serviceMinutes: round(o.service), spanMinutes: round(o.span), idleMinutes: round(Math.max(0, o.span - o.service)),
    utilizationPct: o.span ? round((o.service / o.span) * 100, 1) : 0,
    avgStopsPerDay: o.days ? round(o.stops / o.days, 1) : 0,
    avgServicePerStop: o.stops ? round(o.service / o.stops, 1) : 0,
  })).sort((a, b) => b.utilizationPct - a.utilizationPct);

  const totService = rows.reduce((t, r) => t + r.serviceMinutes, 0);
  const totSpan = rows.reduce((t, r) => t + r.spanMinutes, 0);
  const totStops = rows.reduce((t, r) => t + r.stops, 0);
  const kpis = {
    technicians: rows.length,
    stops: totStops,
    serviceMinutes: round(totService),
    spanMinutes: round(totSpan),
    idleMinutes: round(Math.max(0, totSpan - totService)),
    avgUtilizationPct: totSpan ? round((totService / totSpan) * 100, 1) : 0,
    avgStopsPerTech: rows.length ? round(totStops / rows.length, 1) : 0,
  };
  return buildEnvelope({ kpis, rows }, { meta: { source: 'inventory_db', from: from || null, to: to || null, routeCode: routeCode || null } });
}

async function technicianUtilization(req, res) {
  const { from, to, routeCode } = parseParams(req);
  const pkey = `util|${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const stops = await getStops(from, to, routeCode);
  const payload = buildUtilization(stops, from, to, routeCode);
  payloadCache.set(pkey, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

function buildStopsPerTech(stops, from, to, routeCode) {
  const days = perTechDay(stops);
  const byTech = new Map();
  for (const d of days) {
    const o = byTech.get(d.technician) || { technician: d.technician, stops: 0, days: 0, service: 0 };
    o.stops += d.stopCount; o.days += 1; o.service += d.service;
    byTech.set(d.technician, o);
  }
  const rows = [...byTech.values()].map((o) => ({
    technician: o.technician, stops: o.stops, activeDays: o.days,
    avgStopsPerDay: o.days ? round(o.stops / o.days, 1) : 0,
    serviceMinutes: round(o.service),
    avgServicePerStop: o.stops ? round(o.service / o.stops, 1) : 0,
  })).sort((a, b) => b.stops - a.stops);

  const totStops = rows.reduce((t, r) => t + r.stops, 0);
  const kpis = {
    technicians: rows.length,
    stops: totStops,
    avgStopsPerTech: rows.length ? round(totStops / rows.length, 1) : 0,
    busiest: rows[0] ? rows[0].technician : null,
  };
  return buildEnvelope({ kpis, rows }, { meta: { source: 'inventory_db', from: from || null, to: to || null, routeCode: routeCode || null } });
}

async function stopsPerTechnician(req, res) {
  const { from, to, routeCode } = parseParams(req);
  const pkey = `stops|${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const stops = await getStops(from, to, routeCode);
  const payload = buildStopsPerTech(stops, from, to, routeCode);
  payloadCache.set(pkey, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

function buildStopVolume(stops, from, to, routeCode, granularity) {
  const bucket = new Map(); const route = new Map(); const dow = new Map();
  for (const s of stops) {
    const b = bucketKey(s.dateKey, granularity);
    bucket.set(b, (bucket.get(b) || 0) + 1);
    route.set(s.routeCode, (route.get(s.routeCode) || 0) + 1);
    const wd = DOW[new Date(`${s.dateKey}T00:00:00.000Z`).getUTCDay()];
    dow.set(wd, (dow.get(wd) || 0) + 1);
  }
  const series = [...bucket.entries()].map(([b, stopsN]) => ({ bucket: b, stops: stopsN })).sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  const byRoute = [...route.entries()].map(([routeCode2, stopsN]) => ({ routeCode: routeCode2, stops: stopsN })).sort((a, b) => b.stops - a.stops);
  const byWeekday = DOW.map((d) => ({ day: d, stops: dow.get(d) || 0 }));

  const total = stops.length;
  const busiest = series.reduce((m, r) => (r.stops > (m ? m.stops : -1) ? r : m), null);
  const kpis = {
    stops: total,
    buckets: series.length,
    avgPerBucket: series.length ? round(total / series.length, 1) : 0,
    busiestBucket: busiest ? busiest.bucket : null,
    busiestBucketStops: busiest ? busiest.stops : 0,
    routes: byRoute.length,
  };
  return buildEnvelope({ kpis, series, byRoute, byWeekday }, { meta: { source: 'inventory_db', from: from || null, to: to || null, routeCode: routeCode || null, granularity } });
}

async function stopVolume(req, res) {
  const { from, to, routeCode } = parseParams(req);
  const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'month';
  const pkey = `vol|${from || ''}|${to || ''}|${routeCode || ''}|${granularity}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const stops = await getStops(from, to, routeCode);
  const payload = buildStopVolume(stops, from, to, routeCode, granularity);
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
    for (const r of commonRanges()) {
      try {
        const stops = await getStops(r.from, r.to, undefined);
        payloadCache.set(`util|${r.from}|${r.to}|`, buildUtilization(stops, r.from, r.to, undefined));
        payloadCache.set(`stops|${r.from}|${r.to}|`, buildStopsPerTech(stops, r.from, r.to, undefined));
        payloadCache.set(`vol|${r.from}|${r.to}||month`, buildStopVolume(stops, r.from, r.to, undefined, 'month'));
      } catch (e) { /* db not ready yet */ }
    }
  } finally { warming = false; }
}

function startWarmer() {
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, TTL_MS - 30000);
}

module.exports = { technicianUtilization, stopsPerTechnician, stopVolume, warm, startWarmer };
