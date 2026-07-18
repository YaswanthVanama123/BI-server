'use strict';
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };

function toMinutes(s) {
  const m = String(s || '').trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}
// RouteStar arrival/departure are full date-times ("06/24/2026 9:03 AM"). Parse to an epoch (ms) so span
// and gaps are correct even across a real date boundary. Falls back to time-of-day on the invoice's day.
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
  res.json(buildEnvelope({ routes, latestDate: dayKey(maxDate), earliestDate: dayKey(minDate) }));
}

// GET /checkins?from=&to=&route= — check-in/out grouped by ROUTE = technician = the invoice's assignedTo
// (NRV1…) + day. Day span = last departure − first arrival that day; idle = sum of gaps between
// consecutive stops (next arrival − prev departure); service = on-site (departure − arrival) per stop;
// service% = service ÷ day span.
async function checkins(req, res) {
  const db = getSourceDb();
  const from = clean(req.query.from) || clean(req.query.date);
  const to = clean(req.query.to) || clean(req.query.date) || from;
  const route = (clean(req.query.route) || clean(req.query.routeCode) || '').toUpperCase() || undefined;

  const and = [CLOSED];
  if (from || to) {
    const start = new Date(`${from || to}T00:00:00.000Z`);
    const end = new Date(`${to || from}T23:59:59.999Z`);
    and.push({ $or: [{ dateCompleted: { $gte: start, $lte: end } }, { invoiceDate: { $gte: start, $lte: end } }] });
  }
  const docs = await db.collection('routestarinvoices').find({ $and: and }).limit(50000).toArray();

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

  res.json(buildEnvelope(data, { meta: { source: 'inventory_db', from: from || null, to: to || null, route: route || null } }));
}

module.exports = { options, checkins };
