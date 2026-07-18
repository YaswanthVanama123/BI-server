'use strict';
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const escapeRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };

function toMinutes(s) {
  const m = String(s || '').trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}
function elapsedToMinutes(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (t.includes(':')) { const [a, b] = t.split(':').map(Number); return (a || 0) * 60 + (b || 0); }
  const n = Number(t); return Number.isNaN(n) ? null : n;
}
function dayKey(d) { return d ? new Date(d).toISOString().slice(0, 10) : null; }

async function options(req, res) {
  const db = getSourceDb();
  const techs = (await db.collection('routestarinvoices').distinct('assignedTo', CLOSED)).map(clean).filter(Boolean).sort();
  const agg = await db.collection('routestarinvoices').aggregate([
    { $match: CLOSED },
    { $group: { _id: null, maxC: { $max: '$dateCompleted' }, maxI: { $max: '$invoiceDate' }, minC: { $min: '$dateCompleted' }, minI: { $min: '$invoiceDate' } } },
  ]).toArray();
  const md = agg[0] || {};
  const maxDate = [md.maxC, md.maxI].filter(Boolean).sort().pop();
  const minDate = [md.minC, md.minI].filter(Boolean).sort()[0];
  res.json(buildEnvelope({ technicians: techs, latestDate: dayKey(maxDate), earliestDate: dayKey(minDate) }));
}

async function checkins(req, res) {
  const db = getSourceDb();
  const from = clean(req.query.from) || clean(req.query.date);
  const to = clean(req.query.to) || clean(req.query.date) || from;
  const tech = clean(req.query.technician);
  const and = [CLOSED];
  if (tech) and.push({ assignedTo: { $regex: `^${escapeRe(tech)}$`, $options: 'i' } });
  if (from || to) {
    const start = new Date(`${from || to}T00:00:00.000Z`);
    const end = new Date(`${to || from}T23:59:59.999Z`);
    and.push({ $or: [{ dateCompleted: { $gte: start, $lte: end } }, { invoiceDate: { $gte: start, $lte: end } }] });
  }
  const docs = await db.collection('routestarinvoices').find({ $and: and }).limit(5000).toArray();

  const stops = docs.map((d) => {
    const serviceDate = d.dateCompleted || d.invoiceDate;
    const arr = toMinutes(d.arrivalTime);
    const dep = toMinutes(d.departureTime);
    let serviceMinutes = null;
    let elapsedStatus = 'ok';
    if (arr == null || dep == null) elapsedStatus = 'missing_times';
    else if (dep - arr < 0) elapsedStatus = 'negative';
    else serviceMinutes = dep - arr;
    const src = elapsedToMinutes(d.elapsedTime);
    if (elapsedStatus === 'ok' && src != null && Math.abs(src - serviceMinutes) > 10) elapsedStatus = 'variance';
    return {
      technician: clean(d.assignedTo) || '(unassigned)',
      dateKey: dayKey(serviceDate),
      invoiceNumber: d.invoiceNumber,
      customer: (d.customer && d.customer.name) || '',
      checkIn: clean(d.arrivalTime) || null,
      checkOut: clean(d.departureTime) || null,
      serviceMinutes,
      sourceElapsedMinutes: src,
      elapsedStatus,
      _arr: arr,
      _dep: dep,
    };
  }).filter((s) => {
    if (!from && !to) return true;
    const dk = s.dateKey;
    return (!from || (dk && dk >= from)) && (!to || (dk && dk <= to));
  });

  const groups = new Map();
  for (const s of stops) {
    const k = `${s.technician}||${s.dateKey}`;
    if (!groups.has(k)) groups.set(k, { technician: s.technician, date: s.dateKey, stops: [] });
    groups.get(k).stops.push(s);
  }
  const data = [...groups.values()].map((g) => {
    g.stops.sort((a, b) => (a._arr ?? 1e9) - (b._arr ?? 1e9));
    for (let i = 0; i < g.stops.length - 1; i++) {
      const cur = g.stops[i]; const nxt = g.stops[i + 1];
      cur.gapToNextMinutes = (cur._dep != null && nxt._arr != null) ? Math.max(0, nxt._arr - cur._dep) : null;
    }
    const totalServiceMinutes = g.stops.reduce((t, s) => t + (s.serviceMinutes || 0), 0);
    const totalGapMinutes = g.stops.reduce((t, s) => t + (s.gapToNextMinutes || 0), 0);
    const flaggedStops = g.stops.filter((s) => s.elapsedStatus !== 'ok').length;
    const firstArr = g.stops[0] ? g.stops[0]._arr : null;
    const lastDep = g.stops.length ? g.stops[g.stops.length - 1]._dep : null;
    const spanMinutes = (firstArr != null && lastDep != null && lastDep >= firstArr) ? lastDep - firstArr : null;
    return {
      technician: g.technician,
      date: g.date,
      stopCount: g.stops.length,
      totalServiceMinutes,
      totalGapMinutes,
      flaggedStops,
      spanMinutes,
      firstCheckIn: g.stops[0] ? g.stops[0].checkIn : null,
      lastCheckOut: g.stops.length ? g.stops[g.stops.length - 1].checkOut : null,
      stops: g.stops.map(({ _arr, _dep, ...rest }) => rest),
    };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(a.technician).localeCompare(b.technician));

  res.json(buildEnvelope(data, { meta: { source: 'inventory_db', from: from || null, to: to || null, technician: tech || null } }));
}

module.exports = { options, checkins };
