'use strict';
const { models } = require('../../models');
const { dqIssue } = require('../importBatchRunner');
const { toMoney } = require('../../utils/util');

const { Customer, CustomerLocation } = models;

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };

function pctToDecimal(v) {
  if (v == null || v === '') return undefined;
  const n = parseFloat(String(v).replace('%', '').trim());
  return Number.isNaN(n) ? undefined : toMoney(n);
}

function mapStatus(row) {
  const name = `${row.customerName || ''} ${row.company || ''}`.trim();
  if (/^zzz/i.test(name)) return 'churned';
  if (row.active === false) return 'inactive';
  const s = String(row.status || '').toLowerCase();
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('suspend')) return 'suspended';
  if (s.includes('stop')) return 'stopped';
  if (s.includes('churn')) return 'churned';
  if (s.includes('inactiv')) return 'inactive';
  return 'active';
}

function coords(row) {
  const lat = Number(row.latitude); const lng = Number(row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function dqStatus(dq) {
  if (dq.some((d) => d.severity === 'error' || d.severity === 'critical')) return 'error';
  if (dq.length) return 'warning';
  return 'clean';
}

function sourceStage(sourceRecordId, sourceEntity, recordHash, batchId, now, status) {
  return {
    sourceSystem: 'routestar', sourceRecordId, sourceEntity,
    importedAt: { $ifNull: ['$source.importedAt', now] },
    lastSyncedAt: now, importBatchId: batchId, recordHash,
    syncStatus: { $cond: [{ $ifNull: ['$source.recordHash', false] }, 'updated', 'inserted'] },
    dataQualityStatus: status,
  };
}

module.exports = {
  name: 'inventory_customers',
  sourceSystem: 'routestar',
  sourceEntity: 'customer',
  rawModel: models.RawRouteStarCustomers,

  getSourceRecordId(row) { return String(row.customerId || '').trim(); },

  async processRecord(row, ctx) {
    const { tenant, batch, now, sourceRecordId, recordHash, rawUnchanged } = ctx;
    const dq = [];
    if (!sourceRecordId) {
      dq.push(dqIssue(tenant, batch, 'missing_customer_ref', 'error', 'customers', null, null, 'routestar', 'RouteStar customer has no customerId', now));
      return { syncStatus: 'rejected', curatedTouches: {}, dq };
    }
    if (rawUnchanged && await Customer.exists({ tenantId: tenant._id, routeStarCustomerId: sourceRecordId })) {
      return { syncStatus: 'unchanged', curatedTouches: {}, dq: [] };
    }

    const status = mapStatus(row);
    const res = await Customer.updateOne(
      { tenantId: tenant._id, routeStarCustomerId: sourceRecordId },
      [{ $set: {
        tenantId: tenant._id,
        routeStarCustomerId: sourceRecordId,
        routeStarAccountNumber: clean(row.accountNumber),
        customerName: row.customerName || row.company || row.contact || '(unknown)',
        companyName: clean(row.company),
        customerStatus: status,
        sourceStatusText: clean(row.status),
        customerStatusEffectiveAt: { $ifNull: ['$customerStatusEffectiveAt', now] },
        customerGrouping: clean(row.grouping),
        salesRepresentative: clean(row.salesRep),
        paymentTerms: clean(row.terms),
        taxCode: clean(row.taxCode),
        taxRate: pctToDecimal(row.taxRate),
        balance: toMoney(row.balance),
        source: sourceStage(sourceRecordId, 'customer', recordHash, batch._id, now, dqStatus(dq)),
      } }],
      { upsert: true },
    );
    const customer = await Customer.findOne({ tenantId: tenant._id, routeStarCustomerId: sourceRecordId }, { _id: 1 });

    const addressLines = [row.serviceAddress1, row.serviceAddress2, row.serviceAddress3].map(clean).filter(Boolean);
    const billLines = [row.billingAddress1, row.billingAddress2, row.billingAddress3].map(clean).filter(Boolean);
    const lines = addressLines.length ? addressLines : billLines;
    const city = clean(row.serviceCity) || clean(row.billingCity);
    const c = coords(row);
    if (!c) {
      dq.push(dqIssue(tenant, batch, 'missing_coordinates', 'warning', 'customerLocations', customer._id, sourceRecordId, 'routestar', `Customer ${sourceRecordId} has no valid coordinates`, now));
    }
    if (lines.length || city) {
      const locRecordId = `${sourceRecordId}:service`;
      const set = {
        tenantId: tenant._id,
        customerId: customer._id,
        locationType: 'service',
        addressLines: lines.length ? lines : ['(no address)'],
        city: city || 'UNKNOWN',
        state: clean(row.serviceState) || clean(row.billingState) || 'NA',
        postalCode: clean(row.serviceZip) || clean(row.billingZip) || '00000',
        country: 'US',
        zone: clean(row.zone),
        coordinateSource: 'routestar',
        addressHash: recordHash,
        isActive: true,
        effectiveStart: { $ifNull: ['$effectiveStart', now] },
        source: sourceStage(locRecordId, 'customer_location', recordHash, batch._id, now, dqStatus(dq)),
      };
      if (c) {
        set.sourceLatitude = c.lat;
        set.sourceLongitude = c.lng;
        set.location = { type: 'Point', coordinates: [c.lng, c.lat] };
      }
      await CustomerLocation.updateOne(
        { tenantId: tenant._id, 'source.sourceSystem': 'routestar', 'source.sourceRecordId': locRecordId },
        [{ $set: set }],
        { upsert: true },
      );
      const loc = await CustomerLocation.findOne({ tenantId: tenant._id, 'source.sourceRecordId': locRecordId }, { _id: 1 });
      if (loc) await Customer.updateOne({ _id: customer._id }, { $set: { primaryLocationId: loc._id } });
    }

    return { syncStatus: res.upsertedCount ? 'inserted' : 'updated', curatedTouches: {}, dq };
  },

  async recalcAffected() {  },
};
