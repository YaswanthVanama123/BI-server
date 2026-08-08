'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');
const { inFilterRange, filterDayKey } = require('../lib/checkoutDate');
const env = require('../../config/env');

const { CompanyDistance, Tenant } = models;
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const LUNCH_MIN = 60;

function toMinutes(s) {
  const m = String(s || '').trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}
function dateBound(dk, days) { const d = new Date(`${dk}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d; }
function datePrefilter(from, to) {
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = dateBound(from, -2);
  if (to) range.$lte = dateBound(to, 2);
  return { dateCompleted: range };
}

const TTL_MS = 300000;
const cache = new Map();
function cacheGet(k) { const e = cache.get(k); if (e && Date.now() - e.at < TTL_MS) return e.v; if (e) cache.delete(k); return null; }
function cacheSet(k, v) { cache.set(k, { at: Date.now(), v }); if (cache.size > 40) cache.delete(cache.keys().next().value); }

async function tenantId() {
  const t = await Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  return t ? t._id : null;
}
async function pairMapFor(tid, names) {
  const map = new Map();
  if (!tid) return map;
  const q = { tenantId: tid, drivingMinutes: { $ne: null } };
  if (Array.isArray(names) && names.length) { q.fromCompany = { $in: names }; q.toCompany = { $in: names }; }
  const pairs = await CompanyDistance.find(q, { fromCompany: 1, toCompany: 1, drivingMinutes: 1 }).lean();
  for (const p of pairs) {
    const a = normName(p.fromCompany); const b = normName(p.toCompany);
    if (!map.has(`${a}||${b}`)) map.set(`${a}||${b}`, p);
    if (!map.has(`${b}||${a}`)) map.set(`${b}||${a}`, p);
  }
  return map;
}

async function payrollHours(req, res) {
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const key = `ph|${from || ''}|${to || ''}`;
  const hit = cacheGet(key);
  if (hit) { res.set('X-Cache', 'HIT'); return res.json(hit); }

  const db = getSourceDb();
  const and = [CLOSED];
  const pre = datePrefilter(from, to);
  if (pre) and.push(pre);
  const invoices = (await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: { _id: 0, invoiceNumber: 1, 'customer.name': 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1 } })
    .batchSize(5000)
    .limit(50000).toArray()).filter((inv) => inFilterRange(inv, from, to));

  const stops = invoices.map((inv) => ({
    tech: clean(inv.assignedTo) ? String(inv.assignedTo).trim().toUpperCase() : '(unassigned)',
    dk: filterDayKey(inv) || dayKey(inv.dateCompleted || inv.invoiceDate),
    arr: toMinutes(inv.arrivalTime),
    dep: toMinutes(inv.departureTime),
    customerName: (inv.customer && inv.customer.name) || '',
  }));

  const tid = await tenantId();
  const names = [...new Set(stops.map((s) => s.customerName).filter(Boolean))];
  const pairMap = await pairMapFor(tid, names);

  const byTechDay = new Map();
  for (const s of stops) {
    if (!s.dk) continue;
    const k = `${s.tech}||${s.dk}`;
    if (!byTechDay.has(k)) byTechDay.set(k, { tech: s.tech, list: [] });
    byTechDay.get(k).list.push(s);
  }

  const techAgg = new Map();
  const getT = (tech) => {
    let t = techAgg.get(tech);
    if (!t) { t = { technician: tech, days: 0, stops: 0, serviceMin: 0, drivingMin: 0, lunchMin: 0 }; techAgg.set(tech, t); }
    return t;
  };

  for (const grp of byTechDay.values()) {
    const arr = grp.list.slice().sort((a, b) => (a.arr != null ? a.arr : a.dep != null ? a.dep : 1e9) - (b.arr != null ? b.arr : b.dep != null ? b.dep : 1e9));
    const t = getT(grp.tech);
    t.days += 1;
    t.stops += arr.length;
    t.lunchMin += LUNCH_MIN;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (s.arr != null && s.dep != null && s.dep >= s.arr) t.serviceMin += (s.dep - s.arr);
      if (i > 0) {
        const prev = arr[i - 1];
        const pair = pairMap.get(`${normName(prev.customerName)}||${normName(s.customerName)}`);
        if (pair && pair.drivingMinutes != null) t.drivingMin += Number(pair.drivingMinutes) || 0;
      }
    }
  }

  const rows = [...techAgg.values()].map((t) => {
    const totalMin = t.serviceMin + t.drivingMin + t.lunchMin;
    return {
      technician: t.technician,
      days: t.days,
      stops: t.stops,
      serviceMinutes: Math.round(t.serviceMin),
      drivingMinutes: Math.round(t.drivingMin),
      lunchMinutes: t.lunchMin,
      totalMinutes: Math.round(totalMin),
      serviceHours: round(t.serviceMin / 60),
      drivingHours: round(t.drivingMin / 60),
      lunchHours: round(t.lunchMin / 60),
      totalHours: round(totalMin / 60),
    };
  }).sort((a, b) => b.totalMinutes - a.totalMinutes);

  const kpis = {
    technicians: rows.length,
    days: rows.reduce((s, r) => s + r.days, 0),
    stops: rows.reduce((s, r) => s + r.stops, 0),
    totalMinutes: rows.reduce((s, r) => s + r.totalMinutes, 0),
    totalHours: round(rows.reduce((s, r) => s + r.totalMinutes, 0) / 60),
  };

  const payload = buildEnvelope(rows, { meta: { source: 'inventory_db + bi_companydistances', from: from || null, to: to || null, ...kpis } });
  cacheSet(key, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

module.exports = { payrollHours };
