'use strict';
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');

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
    if (!Number.isNaN(d.getTime())) return d.getTime();
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
  const maxDate = [md.maxC, md.maxI].filter(Boolean).sort().pop();
  const minDate = [md.minC, md.minI].filter(Boolean).sort()[0];
  const payload = buildEnvelope({ routes, latestDate: dayKey(maxDate), earliestDate: dayKey(minDate) });
  cacheSet('options', payload);
  res.json(payload);
}

async function loadCheckins(from, to, route) {
  const db = getSourceDb();
  const and = [CLOSED];
  if (from || to) {
    const start = new Date(`${from || to}T00:00:00.000Z`);
    const end = new Date(`${to || from}T23:59:59.999Z`);
    and.push({ $or: [{ dateCompleted: { $gte: start, $lte: end } }, { invoiceDate: { $gte: start, $lte: end } }] });
  }
  const docs = await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: CHECKIN_PROJECTION })
    .batchSize(5000)
    .limit(50000)
    .toArray();

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
  res.set('X-Cache', hit ? 'HIT' : 'MISS');
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
      try { await getCheckins(r.from, r.to, undefined); } catch (e) { /* db not ready yet */ }
    }
  } finally { warming = false; }
}

function startWarmer() {
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, TTL_MS - 30000);
}

module.exports = { options, checkins, warm, startWarmer };
