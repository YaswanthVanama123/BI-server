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

async function ensureTenant(req) {
  if (req.tenant) return req.tenant;
  const env = require('../../config/env');
  let t = await Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!t) t = await Tenant.create({ tenantCode: env.api.defaultTenantCode, name: 'EnviroMaster NRV', reportingTimezone: env.reporting.timezone, currency: 'USD', fiscalYearStartMonth: 1, active: true });
  return t;
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
  const docs = await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: { _id: 0, invoiceNumber: 1, 'customer.name': 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1 } })
    .batchSize(5000)
    .limit(50000).toArray();

  const stops = [];
  for (const d of docs) {
    const dk = dayKey(d.dateCompleted || d.invoiceDate);
    if (!dk) continue;
    if (from && dk < from) continue;
    if (to && dk > to) continue;
    const rc = clean(d.assignedTo) ? String(d.assignedTo).trim().toUpperCase() : '(unassigned)';
    stops.push({
      routeCode: rc, dateKey: dk,
      invoiceNumber: d.invoiceNumber,
      customer: (d.customer && d.customer.name) || '',
      arrival: clean(d.arrivalTime) || null,
      departure: clean(d.departureTime) || null,
      arrMin: toMinutes(d.arrivalTime),
      depMin: toMinutes(d.departureTime),
    });
  }
  stopsCache.set(key, stops);
  return stops;
}

async function getStops(from, to, routeCode) {
  const all = await getAllStops(from, to);
  return routeCode ? all.filter((s) => s.routeCode === routeCode) : all;
}

async function getPairByName(tenantId) {
  const key = String(tenantId || 'default');
  const cached = pairCache.get(key);
  if (cached) return cached;
  const byName = new Map();
  const pairs = await CompanyDistance.find(
    { tenantId, drivingMinutes: { $ne: null } },
    { fromCompany: 1, toCompany: 1, drivingMinutes: 1, distanceMiles: 1 },
  ).lean();
  for (const p of pairs) {
    const nk = `${normName(p.fromCompany)}||${normName(p.toCompany)}`;
    if (!byName.has(nk)) byName.set(nk, p);
  }
  pairCache.set(key, byName);
  return byName;
}

async function options(req, res) {
  const cached = payloadCache.get('options');
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const db = getSourceDb();
  const tenant = await ensureTenant(req);
  const [routesRaw, agg, pending] = await Promise.all([
    db.collection('routestarinvoices').distinct('assignedTo', CLOSED),
    db.collection('routestarinvoices').aggregate([
      { $match: CLOSED },
      { $group: { _id: null, maxC: { $max: '$dateCompleted' }, maxI: { $max: '$invoiceDate' }, minC: { $min: '$dateCompleted' }, minI: { $min: '$invoiceDate' } } },
    ]).toArray(),
    CompanyDistance.countDocuments({ tenantId: tenant._id, drivingMinutes: null }),
  ]);
  const routeCodes = [...new Set((routesRaw || []).map((r) => (clean(r) ? String(r).trim().toUpperCase() : null)).filter(Boolean))].sort();
  const md = agg[0] || {};
  const maxDate = [md.maxC, md.maxI].filter(Boolean).sort().pop();
  const minDate = [md.minC, md.minI].filter(Boolean).sort()[0];
  const payload = buildEnvelope({ routeCodes, earliestDate: dayKey(minDate), latestDate: dayKey(maxDate), pendingPairs: pending });
  payloadCache.set('options', payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

function buildPayload(stops, byName, from, to, routeCode) {
  const groups = new Map();
  for (const s of stops) {
    const k = `${s.routeCode}||${s.dateKey}`;
    if (!groups.has(k)) groups.set(k, { routeCode: s.routeCode, date: s.dateKey, stops: [] });
    groups.get(k).stops.push(s);
  }

  const data = [...groups.values()].map((g) => {
    g.stops.sort((a, b) => (a.arrMin ?? a.depMin ?? 1e9) - (b.arrMin ?? b.depMin ?? 1e9));
    const legs = [];
    for (let i = 0; i < g.stops.length - 1; i++) {
      const cur = g.stops[i]; const nxt = g.stops[i + 1];
      const observed = (cur.depMin != null && nxt.arrMin != null) ? nxt.arrMin - cur.depMin : null;
      const pair = byName.get(`${normName(cur.customer)}||${normName(nxt.customer)}`);
      const driving = pair && pair.drivingMinutes != null ? pair.drivingMinutes : null;
      const distance = pair && pair.distanceMiles != null ? pair.distanceMiles : null;
      const extra = (observed != null && driving != null) ? round(observed - driving, 1) : null;
      let status = 'ok';
      if (cur.depMin == null || nxt.arrMin == null) status = 'missing_times';
      else if (observed < 0) status = 'negative_gap';
      else if (driving == null) status = 'pending_sync';
      legs.push({
        fromInvoiceNumber: cur.invoiceNumber, toInvoiceNumber: nxt.invoiceNumber,
        fromCustomer: cur.customer, toCustomer: nxt.customer,
        fromDeparture: cur.departure, toArrival: nxt.arrival,
        observedGapMinutes: observed != null ? round(observed, 1) : null,
        drivingMinutes: driving, distanceMiles: distance, extraTimeMinutes: extra, status,
      });
    }
    const usable = legs.filter((x) => x.drivingMinutes != null);
    return {
      routeCode: g.routeCode, date: g.date, legCount: legs.length, syncedLegs: usable.length,
      invoiceNumbers: g.stops.map((s) => s.invoiceNumber).filter(Boolean),
      stopCount: g.stops.length,
      drivingMinutes: round(usable.reduce((t, x) => t + (x.drivingMinutes || 0), 0)),
      observedGapMinutes: round(usable.reduce((t, x) => t + (x.observedGapMinutes || 0), 0)),
      extraTimeMinutes: round(usable.reduce((t, x) => t + (x.extraTimeMinutes || 0), 0)),
      distanceMiles: round(usable.reduce((t, x) => t + (x.distanceMiles || 0), 0), 2),
      legs,
    };
  }).filter((g) => g.legCount > 0)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(a.routeCode).localeCompare(b.routeCode));

  return buildEnvelope(data, { meta: { source: 'inventory_db + bi_companydistances', from: from || null, to: to || null, routeCode: routeCode || null } });
}

async function routeDriveTime(req, res) {
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const routeCode = (clean(req.query.routeCode) || '').toUpperCase() || undefined;

  const pkey = `rdt|${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }

  const tenant = await ensureTenant(req);
  const [stops, byName] = await Promise.all([getStops(from, to, routeCode), getPairByName(tenant._id)]);
  const payload = buildPayload(stops, byName, from, to, routeCode);
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
    if (!t) return;
    const byName = await getPairByName(t._id);
    for (const r of commonRanges()) {
      try {
        const stops = await getStops(r.from, r.to, undefined);
        payloadCache.set(`rdt|${r.from}|${r.to}|`, buildPayload(stops, byName, r.from, r.to, undefined));
      } catch (e) { /* db not ready yet */ }
    }
  } catch (e) { /* ignore */ } finally { warming = false; }
}

function startWarmer() {
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, TTL_MS - 30000);
}

module.exports = { options, routeDriveTime, warm, startWarmer };
