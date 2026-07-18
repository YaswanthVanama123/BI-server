'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { startSync, snapshot } = require('../../services/mapbox/syncJob');

const { CompanyDistance, Tenant } = models;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };

async function ensureTenant(req) {
  if (req.tenant) return req.tenant;
  const env = require('../../config/env');
  let t = await Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!t) t = await Tenant.create({ tenantCode: env.api.defaultTenantCode, name: 'EnviroMaster NRV', reportingTimezone: env.reporting.timezone, currency: 'USD', fiscalYearStartMonth: 1, active: true });
  return t;
}

async function kpiCounts(tenantId) {
  const total = await CompanyDistance.countDocuments({ tenantId });
  const pending = await CompanyDistance.countDocuments({ tenantId, drivingMinutes: null });
  return { total, pending, synced: total - pending };
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

  const filtered = await CompanyDistance.countDocuments(q);
  const rows = await CompanyDistance.find(q)
    .sort({ fromCompany: 1, toCompany: 1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .lean();

  const data = rows.map((r) => ({
    fromCustomerId: r.fromCustomerId, toCustomerId: r.toCustomerId,
    fromCompany: r.fromCompany || r.fromCustomerId, toCompany: r.toCompany || r.toCustomerId,
    distanceMiles: r.distanceMiles ?? null,
    drivingMinutes: r.drivingMinutes ?? null,
    status: r.status,
    syncedAt: r.syncedAt || null,
  }));

  const kpi = await kpiCounts(tenant._id);
  res.json(buildEnvelope(data, {
    meta: { ...kpi, filtered },
    page: { page, pageSize, total: filtered, totalPages: Math.max(1, Math.ceil(filtered / pageSize)) },
  }));
}

async function options(req, res) {
  const tenant = await ensureTenant(req);
  const [fromAgg, toAgg] = await Promise.all([
    CompanyDistance.aggregate([{ $match: { tenantId: tenant._id } }, { $group: { _id: '$fromCustomerId', name: { $first: '$fromCompany' } } }, { $sort: { name: 1 } }]),
    CompanyDistance.aggregate([{ $match: { tenantId: tenant._id } }, { $group: { _id: '$toCustomerId', name: { $first: '$toCompany' } } }, { $sort: { name: 1 } }]),
  ]);
  const map = (a) => a.filter((x) => x._id != null).map((x) => ({ id: String(x._id), name: x.name || String(x._id) }));
  res.json(buildEnvelope({ from: map(fromAgg), to: map(toAgg) }));
}

async function sync(req, res) {
  const tenant = await ensureTenant(req);
  const result = startSync(tenant, { batch: 500 });
  const kpi = await kpiCounts(tenant._id);
  res.json(buildEnvelope(result, { meta: { ...kpi, source: 'mapbox' } }));
}

async function syncStatus(req, res) {
  const tenant = await ensureTenant(req);
  const job = snapshot(tenant);
  const kpi = await kpiCounts(tenant._id);
  res.json(buildEnvelope(job, { meta: kpi }));
}

module.exports = { list, options, sync, syncStatus };
