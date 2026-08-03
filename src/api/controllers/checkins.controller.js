'use strict';
const { buildEnvelope } = require('../lib/envelope');
const { getPaging, pageMeta, sliceArray } = require('../lib/pagination');
const { getSourceDb } = require('../../config/database');
const { inFilterRange } = require('../lib/checkoutDate');

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };

const CHECKIN_PROJECTION = {
  _id: 0,
  invoiceNumber: 1,
  assignedTo: 1,
  dateCompleted: 1,
  invoiceDate: 1,
  arrivalTime: 1,
  departureTime: 1,
  elapsedTime: 1,
  'customer.name': 1,
};

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
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

function toMinutes(s) {
  const m = String(s || '').trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}
function parseTs(str, dk) {
  const s = clean(str);
  if (!s) return null;
  if (/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      if (!dk) return d.getTime();
      const base = new Date(`${dk}T00:00:00`).getTime();
      const diffDays = (d.getTime() - base) / 86400000;
      if (diffDays >= -0.5 && diffDays <= 1.5) return d.getTime();
      return null;
    }
  }
  const mins = toMinutes(s);
  if (mins == null || !dk) return null;
  return new Date(`${dk}T00:00:00`).getTime() + mins * 60000;
}
function elapsedToMinutes(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (t.includes(':')) { const [a, b] = t.split(':').map(Number); return (a || 0) * 60 + (b || 0); }
  const n = Number(t); return Number.isNaN(n) ? null : n;
}
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function dateBound(dk, days) {
  const d = new Date(`${dk}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function datePrefilter(from, to) {
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = dateBound(from, -2);
  if (to) range.$lte = dateBound(to, 2);
  return { dateCompleted: range };
}
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function options(req, res) {
  const cached = cacheGet('options');
  if (cached) return res.json(cached);
  const db = getSourceDb();
  const [routesRaw, agg] = await Promise.all([
    db.collection('routestarinvoices').distinct('assignedTo', CLOSED),
    db.collection('routestarinvoices').aggregate([
      { $match: CLOSED },
      { $group: { _id: null, maxC: { $max: '$dateCompleted' }, maxI: { $max: '$invoiceDate' }, minC: { $min: '$dateCompleted' }, minI: { $min: '$invoiceDate' } } },
    ]).toArray(),
  ]);
  const routes = [...new Set((routesRaw || []).map((r) => (clean(r) ? String(r).trim().toUpperCase() : null)).filter(Boolean))].sort();
  const md = agg[0] || {};
  const maxDate = md.maxC || md.maxI;
  const minDate = md.minC || md.minI;
  const payload = buildEnvelope({ routes, latestDate: dayKey(maxDate), earliestDate: dayKey(minDate) });
  cacheSet('options', payload);
  res.json(payload);
}

async function loadCheckins(from, to, route) {
  const db = getSourceDb();
  const and = [CLOSED];
  const pre = datePrefilter(from, to);
  if (pre) and.push(pre);
  if (route) and.push({ assignedTo: new RegExp(`^\\s*${escapeRegex(route)}\\s*$`, 'i') });
  const docs = (await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: CHECKIN_PROJECTION })
    .batchSize(5000)
    .limit(50000)
    .toArray()).filter((d) => inFilterRange(d, from, to));

  const stops = docs.map((d) => {
    const serviceDate = d.dateCompleted || d.invoiceDate;
    const dk = dayKey(serviceDate);
    const arrTs = parseTs(d.arrivalTime, dk);
    const depTs = parseTs(d.departureTime, dk);
    let serviceMinutes = null;
    let elapsedStatus = 'ok';
    if (arrTs == null || depTs == null) elapsedStatus = 'missing_times';
    else if (depTs - arrTs < 0) elapsedStatus = 'negative';
    else serviceMinutes = Math.round((depTs - arrTs) / 60000);
    const src = elapsedToMinutes(d.elapsedTime);
    if (elapsedStatus === 'ok' && src != null && Math.abs(src - serviceMinutes) > 10) elapsedStatus = 'variance';
    return {
      route: (clean(d.assignedTo) ? String(d.assignedTo).trim().toUpperCase() : '(unassigned)'),
      dateKey: dk,
      dateCompleted: d.dateCompleted || null,
      invoiceNumber: d.invoiceNumber,
      customer: (d.customer && d.customer.name) || '',
      checkIn: clean(d.arrivalTime) || null,
      checkOut: clean(d.departureTime) || null,
      serviceMinutes,
      sourceElapsedMinutes: src,
      elapsedStatus,
      _arr: arrTs,
      _dep: depTs,
    };
  }).filter((s) => {
    if (route && s.route !== route) return false;
    if (!from && !to) return true;
    const dk = s.dateKey;
    return (!from || (dk && dk >= from)) && (!to || (dk && dk <= to));
  });

  const groups = new Map();
  for (const s of stops) {
    const k = `${s.route}||${s.dateKey}`;
    if (!groups.has(k)) groups.set(k, { route: s.route, date: s.dateKey, stops: [] });
    groups.get(k).stops.push(s);
  }
  const data = [...groups.values()].map((g) => {
    g.stops.sort((a, b) => (a._arr ?? Infinity) - (b._arr ?? Infinity));
    for (let i = 0; i < g.stops.length - 1; i++) {
      const cur = g.stops[i]; const nxt = g.stops[i + 1];
      cur.gapToNextMinutes = (cur._dep != null && nxt._arr != null) ? Math.max(0, Math.round((nxt._arr - cur._dep) / 60000)) : null;
    }
    const withArr = g.stops.filter((s) => s._arr != null);
    const withDep = g.stops.filter((s) => s._dep != null);
    const firstStop = withArr.length ? withArr.reduce((a, b) => (a._arr <= b._arr ? a : b)) : null;
    const lastStop = withDep.length ? withDep.reduce((a, b) => (a._dep >= b._dep ? a : b)) : null;
    const spanMinutes = (firstStop && lastStop && lastStop._dep >= firstStop._arr) ? Math.round((lastStop._dep - firstStop._arr) / 60000) : null;
    const totalServiceMinutes = g.stops.reduce((t, s) => t + (s.serviceMinutes || 0), 0);
    const totalGapMinutes = g.stops.reduce((t, s) => t + (s.gapToNextMinutes || 0), 0);
    const flaggedStops = g.stops.filter((s) => s.elapsedStatus !== 'ok').length;
    const invoiceNumbers = g.stops.map((s) => s.invoiceNumber).filter(Boolean);
    return {
      route: g.route,
      date: g.date,
      stopCount: g.stops.length,
      invoiceNumbers,
      totalServiceMinutes,
      totalGapMinutes,
      flaggedStops,
      spanMinutes,
      servicePct: spanMinutes ? Math.round((totalServiceMinutes / spanMinutes) * 1000) / 10 : null,
      firstCheckIn: firstStop ? firstStop.checkIn : null,
      lastCheckOut: lastStop ? lastStop.checkOut : null,
      stops: g.stops.map(({ _arr, _dep, ...rest }) => rest),
    };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(a.route).localeCompare(b.route));

  const payload = buildEnvelope(data, { meta: { source: 'inventory_db', from: from || null, to: to || null, route: route || null } });
  return payload;
}

async function getCheckins(from, to, route) {
  const key = `checkins|${from || ''}|${to || ''}|${route || ''}`;
  const cached = cacheGet(key);
  if (cached) return { payload: cached, hit: true };
  const payload = await loadCheckins(from, to, route);
  cacheSet(key, payload);
  return { payload, hit: false };
}

async function checkins(req, res) {
  const from = clean(req.query.from) || clean(req.query.date);
  const to = clean(req.query.to) || clean(req.query.date) || from;
  const route = (clean(req.query.route) || clean(req.query.routeCode) || '').toUpperCase() || undefined;
  const { payload, hit } = await getCheckins(from, to, route);
  const groups = payload.data || [];

  const routesSet = new Set(); const daysSet = new Set();
  let totalStops = 0; let totalService = 0; let totalGap = 0; let totalSpan = 0; let flagged = 0;
  const perRouteMap = new Map();
  const counts = {};
  for (const g of groups) {
    routesSet.add(g.route); daysSet.add(g.date);
    totalStops += g.stopCount || 0; totalService += g.totalServiceMinutes || 0;
    totalGap += g.totalGapMinutes || 0; totalSpan += g.spanMinutes || 0; flagged += g.flaggedStops || 0;
    const a = perRouteMap.get(g.route) || { route: g.route, stops: 0, service: 0, gap: 0, span: 0 };
    a.stops += g.stopCount || 0; a.service += g.totalServiceMinutes || 0; a.gap += g.totalGapMinutes || 0; a.span += g.spanMinutes || 0;
    perRouteMap.set(g.route, a);
    for (const s of g.stops || []) counts[s.elapsedStatus] = (counts[s.elapsedStatus] || 0) + 1;
  }
  const kpis = {
    routes: routesSet.size,
    days: daysSet.size,
    totalStops,
    totalService,
    avgServicePerStop: totalStops ? totalService / totalStops : 0,
    totalGap,
    flagged,
    servicePct: totalSpan ? (totalService / totalSpan) * 100 : 0,
  };
  const perRoute = [...perRouteMap.values()].sort((a, b) => b.span - a.span);
  const statusData = Object.entries(counts).map(([name, value]) => ({ name, value }));

  const paging = getPaging(req.query, { defaultPageSize: 25, maxPageSize: 200 });
  const slim = groups.map(({ stops, ...rest }) => rest);
  const total = slim.length;
  const summary = sliceArray(slim, paging);

  res.set('X-Cache', hit ? 'HIT' : 'MISS');
  res.json(buildEnvelope({ kpis, perRoute, statusData, summary }, { meta: payload.meta, page: pageMeta(total, paging, summary.length) }));
}

async function checkinStops(req, res) {
  const from = clean(req.query.from) || clean(req.query.date);
  const to = clean(req.query.to) || clean(req.query.date) || from;
  const route = (clean(req.query.route) || clean(req.query.routeCode) || '').toUpperCase() || undefined;
  const term = clean(req.query.q);
  const { payload, hit } = await getCheckins(from, to, route);
  const groups = payload.data || [];
  let flat = [];
  for (const g of groups) for (const s of g.stops || []) flat.push(s);
  flat.sort((a, b) => String(a.dateKey || '').localeCompare(String(b.dateKey || '')) || String(a.checkIn || '').localeCompare(String(b.checkIn || '')));
  if (term) {
    const t = term.toLowerCase();
    flat = flat.filter((s) => `${s.invoiceNumber || ''} ${s.customer || ''} ${s.route || ''} ${s.elapsedStatus || ''}`.toLowerCase().includes(t));
  }
  const paging = getPaging(req.query, { defaultPageSize: 25, maxPageSize: 200 });
  const total = flat.length;
  const pageRows = sliceArray(flat, paging);
  res.set('X-Cache', hit ? 'HIT' : 'MISS');
  res.json(buildEnvelope(pageRows, { meta: { source: 'inventory_db', from: from || null, to: to || null, route: route || null }, page: pageMeta(total, paging, pageRows.length) }));
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
      try { await getCheckins(r.from, r.to, undefined); } catch (e) {}
    }
  } finally { warming = false; }
}

async function ensureIndexes() {
  try {
    const coll = getSourceDb().collection('routestarinvoices');
    await coll.createIndex({ dateCompleted: 1 });
    await coll.createIndex({ invoiceDate: 1 });
    await coll.createIndex({ invoiceType: 1 });
    await coll.createIndex({ status: 1 });
  } catch (e) {}
}

function startWarmer() {
  setTimeout(() => { ensureIndexes(); }, 3000);
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, TTL_MS - 30000);
}

module.exports = { options, checkins, checkinStops, warm, startWarmer };
