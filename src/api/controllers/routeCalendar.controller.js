'use strict';
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');
const { filterDayKey } = require('../lib/checkoutDate');
const { parseTs, minutesBetween } = require('../lib/stopTimes');

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const round = (n, d = 1) => { const f = 10 ** d; return Math.round(n * f) / f; };
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const routeOf = (v) => (clean(v) ? String(v).trim().toUpperCase() : '(unassigned)');

function dateBound(dk, days) {
  const d = new Date(`${dk}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = 'BAD_REQUEST';
  return e;
}

const TTL_MS = 300000;
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (e && Date.now() - e.at < TTL_MS) return e.payload;
  if (e) cache.delete(key);
  return null;
}
function cacheSet(key, payload) {
  cache.set(key, { at: Date.now(), payload });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
}

async function loadStops(from, to, routeCode) {
  const and = [CLOSED, { dateCompleted: { $gte: dateBound(from, -2), $lte: dateBound(to, 2) } }];
  if (routeCode) and.push({ assignedTo: new RegExp(`^\\s*${escapeRegex(routeCode)}\\s*$`, 'i') });
  const invoices = await getSourceDb().collection('routestarinvoices')
    .find({ $and: and }, { projection: { _id: 0, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1, total: 1 } })
    .batchSize(5000)
    .limit(50000)
    .toArray();

  const stops = [];
  for (const inv of invoices) {
    const date = filterDayKey(inv);
    if (!date || date < from || date > to) continue;
    const route = routeOf(inv.assignedTo);
    if (routeCode && route !== routeCode) continue;
    const arr = parseTs(inv.arrivalTime, date);
    const dep = parseTs(inv.departureTime, date);
    stops.push({ route, date, arr, dep, service: minutesBetween(arr, dep) || 0, revenue: Number(inv.total) || 0 });
  }
  return stops;
}

function summarizeDays(stops) {
  const routeDays = new Map();
  for (const s of stops) {
    const key = `${s.route}||${s.date}`;
    let g = routeDays.get(key);
    if (!g) { g = { date: s.date, stops: 0, service: 0, revenue: 0, firstArr: null, lastDep: null }; routeDays.set(key, g); }
    g.stops += 1;
    g.service += s.service;
    g.revenue += s.revenue;
    if (s.arr != null && (g.firstArr == null || s.arr < g.firstArr)) g.firstArr = s.arr;
    if (s.dep != null && (g.lastDep == null || s.dep > g.lastDep)) g.lastDep = s.dep;
  }

  const byDate = new Map();
  for (const g of routeDays.values()) {
    let d = byDate.get(g.date);
    if (!d) { d = { date: g.date, routes: 0, stops: 0, service: 0, span: 0, revenue: 0 }; byDate.set(g.date, d); }
    d.routes += 1;
    d.stops += g.stops;
    d.service += g.service;
    d.span += minutesBetween(g.firstArr, g.lastDep) || 0;
    d.revenue += g.revenue;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildCalendar(stops, from, to, routeCode) {
  const days = summarizeDays(stops);
  const tot = days.reduce((t, d) => ({ stops: t.stops + d.stops, service: t.service + d.service, span: t.span + d.span, revenue: t.revenue + d.revenue }), { stops: 0, service: 0, span: 0, revenue: 0 });
  const kpis = {
    days: days.length,
    routes: new Set(stops.map((s) => s.route)).size,
    stops: tot.stops,
    serviceMinutes: round(tot.service),
    spanMinutes: round(tot.span),
    avgServiceMinutes: tot.stops ? round(tot.service / tot.stops) : 0,
    revenue: round(tot.revenue, 2),
    utilizationPct: tot.span ? round((tot.service / tot.span) * 100) : null,
    avgStopsPerDay: days.length ? round(tot.stops / days.length) : 0,
    avgRevenuePerDay: days.length ? round(tot.revenue / days.length, 2) : 0,
  };
  const rows = days.map((d) => ({
    date: d.date,
    routes: d.routes,
    stops: d.stops,
    serviceMinutes: round(d.service),
    spanMinutes: round(d.span),
    avgServiceMinutes: d.stops ? round(d.service / d.stops) : 0,
    revenue: round(d.revenue, 2),
    utilizationPct: d.span ? round((d.service / d.span) * 100) : null,
  }));
  return { from, to, routeCode: routeCode || null, kpis, days: rows };
}

async function routeCalendar(req, res) {
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  if (!ISO_DAY.test(from || '') || !ISO_DAY.test(to || '')) throw badRequest('from and to are required (YYYY-MM-DD)');
  if (from > to) throw badRequest('from must be on or before to');
  const rc = (clean(req.query.routeCode) || '').toUpperCase();
  const routeCode = rc && rc !== 'ALL' ? rc : undefined;

  const key = `${from}|${to}|${routeCode || ''}`;
  const cached = cacheGet(key);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const stops = await loadStops(from, to, routeCode);
  const payload = buildEnvelope(buildCalendar(stops, from, to, routeCode), { meta: { source: 'inventory_db', from, to, routeCode: routeCode || null } });
  cacheSet(key, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

module.exports = { routeCalendar };
