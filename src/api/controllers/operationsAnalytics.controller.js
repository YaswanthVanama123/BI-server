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
function customerIdFromLink(link) { const m = String(link || '').match(/customerdetail\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]) : null; }
function bucketKey(dk, g) {
  if (!dk) return null;
  if (g === 'day') return dk;
  if (g === 'week') { const d = new Date(`${dk}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
  return dk.slice(0, 7);
}

// Load closed-invoice "stops" for the range, joined with the customer's route, applying an optional
// route filter. Shared by all three analytics endpoints.
async function loadStops(req) {
  const db = getSourceDb();
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const routeCode = clean(req.query.routeCode);

  const and = [CLOSED];
  if (from || to) {
    const start = new Date(`${from || to}T00:00:00.000Z`);
    const end = new Date(`${to || from}T23:59:59.999Z`);
    and.push({ $or: [{ dateCompleted: { $gte: start, $lte: end } }, { invoiceDate: { $gte: start, $lte: end } }] });
  }
  const invoices = await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: { customer: 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1 } })
    .limit(50000).toArray();

  const custIds = [...new Set(invoices.map((i) => customerIdFromLink(i.customer && i.customer.link)).filter(Boolean))];
  const custs = await db.collection('routestarcustomers')
    .find({ customerId: { $in: custIds } }, { projection: { customerId: 1, onRoute: 1 } }).toArray();
  const routeByCust = new Map(custs.map((c) => [c.customerId, (clean(c.onRoute) ? String(c.onRoute).trim().toUpperCase() : null)]));

  const stops = [];
  for (const inv of invoices) {
    const dk = dayKey(inv.dateCompleted || inv.invoiceDate);
    if (!dk) continue;
    const cid = customerIdFromLink(inv.customer && inv.customer.link);
    const rc = (cid && routeByCust.get(cid)) || '(no route)';
    if (routeCode && rc !== routeCode) continue;
    const arr = toMinutes(inv.arrivalTime);
    const dep = toMinutes(inv.departureTime);
    stops.push({
      technician: clean(inv.assignedTo) || '(unassigned)',
      routeCode: rc, dateKey: dk,
      arr, dep,
      service: (arr != null && dep != null && dep >= arr) ? dep - arr : null,
    });
  }
  return { stops, from, to, routeCode };
}

// Per technician+day rollup (stops, service, working-day span).
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

// GET /ops/technician-utilization — on-site service time as a share of the working-day span, per tech.
async function technicianUtilization(req, res) {
  const { stops, from, to, routeCode } = await loadStops(req);
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
  res.json(buildEnvelope({ kpis, rows }, { meta: { source: 'inventory_db', from: from || null, to: to || null, routeCode: routeCode || null } }));
}

// GET /ops/stops-per-technician — stop counts + productivity per technician.
async function stopsPerTechnician(req, res) {
  const { stops, from, to, routeCode } = await loadStops(req);
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
  res.json(buildEnvelope({ kpis, rows }, { meta: { source: 'inventory_db', from: from || null, to: to || null, routeCode: routeCode || null } }));
}

// GET /ops/stop-volume — stop volume over time (granularity buckets) + by route + by weekday.
async function stopVolume(req, res) {
  const { stops, from, to, routeCode } = await loadStops(req);
  const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'month';

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
  res.json(buildEnvelope({ kpis, series, byRoute, byWeekday }, { meta: { source: 'inventory_db', from: from || null, to: to || null, routeCode: routeCode || null, granularity } }));
}

module.exports = { technicianUtilization, stopsPerTechnician, stopVolume };
