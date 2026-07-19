'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { startSync, snapshot } = require('../../services/mapbox/syncJob');

const { CompanyDistance, Tenant } = models;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };

function makeCache(ttl) {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (e && Date.now() - e.at < ttl) return e.v; if (e) m.delete(k); return null; },
    set(k, v) { m.set(k, { at: Date.now(), v }); if (m.size > 100) m.delete(m.keys().next().value); },
    clear() { m.clear(); },
  };
}
const tenantCache = makeCache(300000);
const kpiCache = makeCache(10000);
const optionsCache = makeCache(300000);
const listCache = makeCache(30000);

async function ensureTenant(req) {
  if (req && req.tenant) return req.tenant;
  const cached = tenantCache.get('default');
  if (cached) return cached;
  const env = require('../../config/env');
  let t = await Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!t) t = await Tenant.create({ tenantCode: env.api.defaultTenantCode, name: 'EnviroMaster NRV', reportingTimezone: env.reporting.timezone, currency: 'USD', fiscalYearStartMonth: 1, active: true });
  tenantCache.set('default', t);
  return t;
}

async function kpiCounts(tenantId) {
  const key = String(tenantId);
  const cached = kpiCache.get(key);
  if (cached) return cached;
  const [total, pending] = await Promise.all([
    CompanyDistance.countDocuments({ tenantId }),
    CompanyDistance.countDocuments({ tenantId, drivingMinutes: null }),
  ]);
  const kpi = { total, pending, synced: total - pending };
  kpiCache.set(key, kpi);
  return kpi;
}

async function list(req, res) {
  const tenant = await ensureTenant(req);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

  const q = { tenantId: tenant._id };
  const st = req.query.status;
  if (st && st !== 'all') {
    if (st === 'synced') q.drivingMinutes = { $ne: null };
    else { q.status = st; if (st === 'pending') q.drivingMinutes = null; }
  }

  const from = clean(req.query.from);
  const to = clean(req.query.to);
  if (from) q.fromCustomerId = from;
  if (to) q.toCustomerId = to;
  const term = clean(req.query.q);
  if (term) {
    const rx = new RegExp(escapeRegex(term), 'i');
    q.$or = [{ fromCompany: rx }, { toCompany: rx }];
  }

  const lkey = `${tenant._id}|${st || 'all'}|${from || ''}|${to || ''}|${term || ''}|${page}|${pageSize}`;
  const cachedPage = listCache.get(lkey);
  if (cachedPage) { res.set('X-Cache', 'HIT'); return res.json(cachedPage); }

  const [filtered, rows, kpi] = await Promise.all([
    CompanyDistance.countDocuments(q),
    CompanyDistance.find(q)
      .sort({ fromCompany: 1, toCompany: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    kpiCounts(tenant._id),
  ]);

  const data = rows.map((r) => ({
    fromCustomerId: r.fromCustomerId, toCustomerId: r.toCustomerId,
    fromCompany: r.fromCompany || r.fromCustomerId, toCompany: r.toCompany || r.toCustomerId,
    distanceMiles: r.distanceMiles ?? null,
    drivingMinutes: r.drivingMinutes ?? null,
    status: r.status,
    syncedAt: r.syncedAt || null,
  }));

  const payload = buildEnvelope(data, {
    meta: { ...kpi, filtered },
    page: { page, pageSize, total: filtered, totalPages: Math.max(1, Math.ceil(filtered / pageSize)) },
  });
  listCache.set(lkey, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

async function loadOptions(tenantId) {
  const key = String(tenantId);
  const cached = optionsCache.get(key);
  if (cached) return cached;
  const [fromAgg, toAgg] = await Promise.all([
    CompanyDistance.aggregate([{ $match: { tenantId } }, { $group: { _id: '$fromCustomerId', name: { $first: '$fromCompany' } } }, { $sort: { name: 1 } }]),
    CompanyDistance.aggregate([{ $match: { tenantId } }, { $group: { _id: '$toCustomerId', name: { $first: '$toCompany' } } }, { $sort: { name: 1 } }]),
  ]);
  const map = (a) => a.filter((x) => x._id != null).map((x) => ({ id: String(x._id), name: x.name || String(x._id) }));
  const payload = buildEnvelope({ from: map(fromAgg), to: map(toAgg) });
  optionsCache.set(key, payload);
  return payload;
}

async function options(req, res) {
  const tenant = await ensureTenant(req);
  const hit = optionsCache.get(String(tenant._id));
  const payload = hit || await loadOptions(tenant._id);
  res.set('X-Cache', hit ? 'HIT' : 'MISS');
  res.json(payload);
}

async function sync(req, res) {
  const tenant = await ensureTenant(req);
  const result = startSync(tenant, { batch: 500 });
  kpiCache.clear();
  optionsCache.clear();
  listCache.clear();
  const kpi = await kpiCounts(tenant._id);
  res.json(buildEnvelope(result, { meta: { ...kpi, source: 'mapbox' } }));
}

async function syncStatus(req, res) {
  const tenant = await ensureTenant(req);
  const job = snapshot(tenant);
  if (job && job.running) { kpiCache.clear(); listCache.clear(); }
  const kpi = await kpiCounts(tenant._id);
  res.json(buildEnvelope(job, { meta: kpi }));
}

async function warm() {
  try {
    const tenant = await ensureTenant(null);
    await Promise.all([kpiCounts(tenant._id), loadOptions(tenant._id)]);
  } catch (e) { /* db not ready yet */ }
}

function startWarmer() {
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, 240000);
}

module.exports = { list, options, sync, syncStatus, warm, startWarmer };
