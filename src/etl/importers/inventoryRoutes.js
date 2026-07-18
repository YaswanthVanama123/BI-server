'use strict';
const { models } = require('../../models');
const { dqIssue } = require('../importBatchRunner');
const { clean, norm, dqStatus, sourceStage } = require('./_shared');

const { Route, Customer, CustomerServiceSchedule, FrequencyDefinition } = models;

const cache = { routeByCode: new Map(), freqDefs: null, custByRsId: new Map() };
const DOW = { sun: 'SUN', mon: 'MON', tue: 'TUE', wed: 'WED', thu: 'THU', fri: 'FRI', sat: 'SAT' };
const dayOfWeek = (v) => DOW[String(v || '').slice(0, 3).toLowerCase()];

async function ensureRoute(tenant, routeName, now) {
  const code = clean(routeName);
  if (!code) return null;
  const key = code.toUpperCase();
  if (cache.routeByCode.has(key)) return cache.routeByCode.get(key);
  let r = await Route.findOne({ tenantId: tenant._id, routeCode: key }, { _id: 1 }).lean();
  if (!r) {
    await Route.updateOne(
      { tenantId: tenant._id, routeCode: key },
      { $set: { tenantId: tenant._id, routeCode: key, routeName: code, isActive: true }, $setOnInsert: { effectiveStart: now } },
      { upsert: true },
    );
    r = await Route.findOne({ tenantId: tenant._id, routeCode: key }, { _id: 1 }).lean();
  }
  cache.routeByCode.set(key, r._id);
  return r._id;
}

async function normFreq(tenant, text) {
  if (!cache.freqDefs) cache.freqDefs = await FrequencyDefinition.find({ tenantId: tenant._id }).lean();
  const s = String(text || '').toLowerCase();
  if (!s) return 'unknown';
  const hit = cache.freqDefs.find((f) => (f.sourceTextPatterns || []).some((p) => p && s.includes(String(p).toLowerCase())));
  return hit ? hit.normalizedFrequency : 'unknown';
}

async function resolveCustomerId(tenant, rsCustomerId) {
  const id = clean(rsCustomerId);
  if (!id) return null;
  if (cache.custByRsId.has(id)) return cache.custByRsId.get(id);
  const c = await Customer.findOne({ tenantId: tenant._id, routeStarCustomerId: id }, { _id: 1 }).lean();
  const v = c ? c._id : null;
  cache.custByRsId.set(id, v);
  return v;
}

module.exports = {
  name: 'inventory_routes',
  sourceSystem: 'routestar',
  sourceEntity: 'customer_route',
  rawModel: models.RawRouteStarCustomerRoutes,

  getSourceRecordId(row) {
    return `${clean(row.customerId) || '?'}:${norm(row.routeName)}:${clean(row.dayOfWeek) || ''}:${row.sequence ?? ''}`;
  },

  async processRecord(row, ctx) {
    const { tenant, batch, now, sourceRecordId, recordHash } = ctx;
    const dq = [];
    const routeId = await ensureRoute(tenant, row.routeName, now);
    const customerId = await resolveCustomerId(tenant, row.customerId);
    if (!customerId) {
      dq.push(dqIssue(tenant, batch, 'missing_customer_ref', 'warning', 'customerServiceSchedules', null, clean(row.customerId), 'routestar', `Route schedule for unknown customer ${row.customerId}`, now));
      return { syncStatus: 'rejected', curatedTouches: {}, dq };
    }

    if (routeId) {
      const suspended = /suspend/i.test(row.status || '');
      const active = !suspended && !/inactiv|cancel|stopped|churn/i.test(row.status || '');
      await CustomerServiceSchedule.updateOne(
        { tenantId: tenant._id, 'source.sourceSystem': 'routestar', 'source.sourceRecordId': sourceRecordId },
        [{ $set: {
          tenantId: tenant._id, customerId, routeId,
          normalizedFrequency: await normFreq(tenant, row.frequency),
          sourceFrequencyText: clean(row.frequency),
          dayOfWeek: dayOfWeek(row.dayOfWeek),
          stopNumber: Number.isFinite(row.sequence) ? row.sequence : undefined,
          isSuspended: suspended, isMissedRoute: false, isActive: active,
          notes: clean(row.notes),
          effectiveStart: { $ifNull: ['$effectiveStart', row.startDate || now] },
          source: sourceStage(sourceRecordId, 'customer_route', recordHash, batch._id, now, dqStatus(dq)),
        } }],
        { upsert: true },
      );

      await Customer.updateOne(
        { tenantId: tenant._id, _id: customerId, $or: [{ defaultRouteId: null }, { defaultRouteId: { $exists: false } }] },
        { $set: { defaultRouteId: routeId } },
      );
    } else {
      dq.push(dqIssue(tenant, batch, 'missing_route_mapping', 'warning', 'customerServiceSchedules', null, sourceRecordId, 'routestar', `Route schedule has no route name (customer ${row.customerId})`, now));
    }

    return { syncStatus: 'updated', curatedTouches: {}, dq };
  },

  async recalcAffected() {  },
};
