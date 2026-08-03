'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { getPaging, pageMeta, sliceArray } = require('../lib/pagination');
const { getSourceDb } = require('../../config/database');
const { inFilterRange } = require('../lib/checkoutDate');

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
    set(k, v) { m.set(k, { at: Date.now(), v }); if (m.size > 40) m.delete(m.keys().next().value); },
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
  const pre = datePrefilter(from, to);
  if (pre) and.push(pre);
  const docs = (await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: { _id: 0, invoiceNumber: 1, 'customer.name': 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1 } })
    .batchSize(5000)
    .limit(50000).toArray()).filter((d) => inFilterRange(d, from, to));

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

async function getPairByName(tenantId, names) {
  const byName = new Map();
  if (!tenantId) return byName;
  const q = { tenantId, drivingMinutes: { $ne: null } };
  if (Array.isArray(names) && names.length) { q.fromCompany = { $in: names }; q.toCompany = { $in: names }; }
  const pairs = await CompanyDistance.find(
    q,
    { fromCompany: 1, toCompany: 1, drivingMinutes: 1, distanceMiles: 1 },
  ).lean();
  for (const p of pairs) {
    const nk = `${normName(p.fromCompany)}||${normName(p.toCompany)}`;
    if (!byName.has(nk)) byName.set(nk, p);
  }
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
  const maxDate = md.maxC || md.maxI;
  const minDate = md.minC || md.minI;
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

async function getFullData(req, from, to, routeCode) {
  const key = `rdtfull|${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = payloadCache.get(key);
  if (cached) return cached;
  const tenant = await ensureTenant(req);
  const stops = await getStops(from, to, routeCode);
  const names = [...new Set(stops.map((s) => s.customer).filter(Boolean))];
  const byName = await getPairByName(tenant._id, names);
  const data = buildPayload(stops, byName, from, to, routeCode).data;
  payloadCache.set(key, data);
  return data;
}

async function routeDriveTime(req, res) {
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const routeCode = (clean(req.query.routeCode) || '').toUpperCase() || undefined;

  const data = await getFullData(req, from, to, routeCode);
  const slim = data.map(({ legs, ...rest }) => rest);

  let legs = 0; let driving = 0; let observed = 0; let extra = 0; let distance = 0;
  const prMap = new Map();
  for (const g of slim) {
    legs += g.legCount || 0; driving += g.drivingMinutes || 0; observed += g.observedGapMinutes || 0;
    extra += g.extraTimeMinutes || 0; distance += g.distanceMiles || 0;
    const a = prMap.get(g.routeCode) || { routeCode: g.routeCode, driving: 0, extra: 0, distance: 0, legs: 0 };
    a.driving += g.drivingMinutes || 0; a.extra += g.extraTimeMinutes || 0; a.distance += g.distanceMiles || 0; a.legs += g.legCount || 0;
    prMap.set(g.routeCode, a);
  }
  const kpis = { legs, driving, observed, extra, distance, avgExtra: legs ? round(extra / legs, 1) : 0 };
  const perRoute = [...prMap.values()].sort((a, b) => b.extra - a.extra);

  const paging = getPaging(req.query, { defaultPageSize: 25, maxPageSize: 200 });
  const total = slim.length;
  const summary = sliceArray(slim, paging);
  res.set('X-Cache', 'MISS');
  res.json(buildEnvelope(
    { kpis, perRoute, summary },
    { meta: { source: 'inventory_db + bi_companydistances', from: from || null, to: to || null, routeCode: routeCode || null }, page: pageMeta(total, paging, summary.length) },
  ));
}

async function routeDriveLegs(req, res) {
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const routeCode = (clean(req.query.routeCode) || '').toUpperCase() || undefined;
  const term = clean(req.query.q);
  const data = await getFullData(req, from, to, routeCode);
  let flat = [];
  for (const g of data) for (const l of g.legs || []) flat.push({ ...l, routeCode: g.routeCode, date: g.date });
  flat.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.fromInvoiceNumber || '').localeCompare(String(b.fromInvoiceNumber || '')));
  if (term) {
    const t = term.toLowerCase();
    flat = flat.filter((l) => `${l.fromInvoiceNumber || ''} ${l.toInvoiceNumber || ''} ${l.fromCustomer || ''} ${l.toCustomer || ''} ${l.routeCode || ''} ${l.status || ''}`.toLowerCase().includes(t));
  }
  const paging = getPaging(req.query, { defaultPageSize: 25, maxPageSize: 200 });
  const total = flat.length;
  const pageRows = sliceArray(flat, paging);
  res.set('X-Cache', 'MISS');
  res.json(buildEnvelope(pageRows, { meta: { source: 'inventory_db + bi_companydistances', from: from || null, to: to || null, routeCode: routeCode || null }, page: pageMeta(total, paging, pageRows.length) }));
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
    for (const r of commonRanges()) {
      try {
        const stops = await getStops(r.from, r.to, undefined);
        const names = [...new Set(stops.map((s) => s.customer).filter(Boolean))];
        const byName = await getPairByName(t._id, names);
        const data = buildPayload(stops, byName, r.from, r.to, undefined).data;
        payloadCache.set(`rdtfull|${r.from}|${r.to}|`, data);
      } catch (e) {}
    }
  } catch (e) {} finally { warming = false; }
}

function startWarmer() {
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, TTL_MS - 30000);
}

module.exports = { options, routeDriveTime, routeDriveLegs, warm, startWarmer };
