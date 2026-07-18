'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');

const { RouteDriveLeg, CompanyDistance, Tenant } = models;
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const round = (n, d = 1) => { const f = 10 ** d; return Math.round(n * f) / f; };
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function ensureTenant(req) {
  if (req.tenant) return req.tenant;
  const env = require('../../config/env');
  let t = await Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!t) t = await Tenant.create({ tenantCode: env.api.defaultTenantCode, name: 'EnviroMaster NRV', reportingTimezone: env.reporting.timezone, currency: 'USD', fiscalYearStartMonth: 1, active: true });
  return t;
}

async function options(req, res) {
  const tenant = await ensureTenant(req);
  const routeCodes = (await RouteDriveLeg.distinct('routeCode', { tenantId: tenant._id })).filter(Boolean).sort();
  const agg = await RouteDriveLeg.aggregate([
    { $match: { tenantId: tenant._id } },
    { $group: { _id: null, min: { $min: '$dateKey' }, max: { $max: '$dateKey' } } },
  ]);
  const md = agg[0] || {};
  const pending = await CompanyDistance.countDocuments({ tenantId: tenant._id, drivingMinutes: null });
  res.json(buildEnvelope({ routeCodes, earliestDate: md.min || null, latestDate: md.max || null, pendingPairs: pending }));
}

async function routeDriveTime(req, res) {
  const tenant = await ensureTenant(req);
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const routeCode = clean(req.query.routeCode);
  const q = { tenantId: tenant._id };
  if (from || to) q.dateKey = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (routeCode) q.routeCode = routeCode;

  const legs = await RouteDriveLeg.find(q).limit(20000).lean();
  const pairs = await CompanyDistance.find(
    { tenantId: tenant._id, drivingMinutes: { $ne: null } },
    { fromCustomerId: 1, toCustomerId: 1, fromCompany: 1, toCompany: 1, drivingMinutes: 1, distanceMiles: 1, status: 1 },
  ).lean();
  const byId = new Map();
  const byName = new Map();
  for (const p of pairs) {
    byId.set(`${p.fromCustomerId}||${p.toCustomerId}`, p);
    const nk = `${normName(p.fromCompany)}||${normName(p.toCompany)}`;
    if (!byName.has(nk)) byName.set(nk, p);
  }
  const lookup = (l) => byName.get(`${normName(l.fromCustomer)}||${normName(l.toCustomer)}`)
    || byId.get(`${l.fromCustomerId}||${l.toCustomerId}`) || null;

  const groups = new Map();
  for (const l of legs) {
    const pair = lookup(l);
    const driving = pair && pair.drivingMinutes != null ? pair.drivingMinutes : null;
    const distance = pair && pair.distanceMiles != null ? pair.distanceMiles : null;
    const observed = l.observedGapMinutes ?? null;
    const extra = (observed != null && driving != null) ? round(observed - driving, 1) : null;
    let status = l.status;
    if (status === 'ok' && driving == null) status = 'pending_sync';
    const k = `${l.routeCode}||${l.dateKey}`;
    if (!groups.has(k)) groups.set(k, { routeCode: l.routeCode, date: l.dateKey, legs: [] });
    groups.get(k).legs.push({
      fromInvoiceNumber: l.fromInvoiceNumber, toInvoiceNumber: l.toInvoiceNumber,
      fromCustomer: l.fromCustomer, toCustomer: l.toCustomer,
      fromDeparture: l.fromDeparture, toArrival: l.toArrival,
      observedGapMinutes: observed, drivingMinutes: driving, distanceMiles: distance, extraTimeMinutes: extra, status,
    });
  }

  const data = [...groups.values()].map((g) => {
    const usable = g.legs.filter((x) => x.drivingMinutes != null);
    const driving = usable.reduce((t, x) => t + (x.drivingMinutes || 0), 0);
    const observed = usable.reduce((t, x) => t + (x.observedGapMinutes || 0), 0);
    const extra = usable.reduce((t, x) => t + (x.extraTimeMinutes || 0), 0);
    const distance = usable.reduce((t, x) => t + (x.distanceMiles || 0), 0);
    g.legs.sort((a, b) => String(a.fromDeparture || '').localeCompare(String(b.fromDeparture || '')));
    return {
      routeCode: g.routeCode, date: g.date, legCount: g.legs.length, syncedLegs: usable.length,
      drivingMinutes: round(driving), observedGapMinutes: round(observed), extraTimeMinutes: round(extra), distanceMiles: round(distance, 2),
      legs: g.legs,
    };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(a.routeCode).localeCompare(b.routeCode));

  res.json(buildEnvelope(data, { meta: { source: 'bi_routedrivelegs + bi_companydistances', from: from || null, to: to || null, routeCode: routeCode || null } }));
}

module.exports = { options, routeDriveTime };
