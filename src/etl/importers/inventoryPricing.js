'use strict';
const { models } = require('../../models');
const { dqIssue } = require('../importBatchRunner');
const { clean, sourceStage } = require('./_shared');
const { toMoney } = require('../../utils/util');

const {
  Customer, ServiceItem, ServiceCategory, CustomerPricingAgreement, CustomerPricingItem,
} = models;

const cache = { custByRsId: new Map(), agreementByCust: new Map(), itemByCode: new Map(), unmappedId: null };

async function unmappedCategory(tenantId) {
  if (cache.unmappedId) return cache.unmappedId;
  const c = await ServiceCategory.findOne({ tenantId, isUnmapped: true }, { _id: 1 }).lean();
  if (!c) { const e = new Error('No UNMAPPED category — run `npm run seed` first.'); e.fatal = true; throw e; }
  cache.unmappedId = c._id;
  return c._id;
}

async function resolveCustomerId(tenant, rsId) {
  const id = clean(rsId);
  if (!id) return null;
  if (cache.custByRsId.has(id)) return cache.custByRsId.get(id);
  const c = await Customer.findOne({ tenantId: tenant._id, routeStarCustomerId: id }, { _id: 1 }).lean();
  const v = c ? c._id : null;
  cache.custByRsId.set(id, v);
  return v;
}

async function ensureAgreement(tenant, customerId, now) {
  const key = String(customerId);
  if (cache.agreementByCust.has(key)) return cache.agreementByCust.get(key);
  let a = await CustomerPricingAgreement.findOne({ tenantId: tenant._id, customerId, isActive: true }, { _id: 1 }).lean();
  if (!a) {
    await CustomerPricingAgreement.updateOne(
      { tenantId: tenant._id, customerId, isActive: true },
      [{ $set: {
        tenantId: tenant._id, customerId, currency: 'USD', isActive: true,
        effectiveStart: { $ifNull: ['$effectiveStart', now] },
        source: sourceStage(`AGREEMENT:${key}`, 'pricing_agreement', 'agreement', null, now, 'clean'),
      } }],
      { upsert: true },
    );
    a = await CustomerPricingAgreement.findOne({ tenantId: tenant._id, customerId, isActive: true }, { _id: 1 }).lean();
  }
  cache.agreementByCust.set(key, a._id);
  return a._id;
}

async function ensureServiceItem(tenant, code, description, now) {
  const itemCode = clean(code);
  if (!itemCode) return { id: undefined, categoryId: await unmappedCategory(tenant._id) };
  if (cache.itemByCode.has(itemCode)) return cache.itemByCode.get(itemCode);
  let it = await ServiceItem.findOne({ tenantId: tenant._id, itemCode }, { _id: 1, serviceCategoryId: 1 }).lean();
  if (!it) {
    const categoryId = await unmappedCategory(tenant._id);
    await ServiceItem.updateOne(
      { tenantId: tenant._id, itemCode },
      { $set: { tenantId: tenant._id, itemCode, description: clean(description) || itemCode, serviceCategoryId: categoryId, isActive: true }, $addToSet: { sourceItemIds: itemCode } },
      { upsert: true },
    );
    it = await ServiceItem.findOne({ tenantId: tenant._id, itemCode }, { _id: 1, serviceCategoryId: 1 }).lean();
  }
  const res = { id: it._id, categoryId: it.serviceCategoryId || await unmappedCategory(tenant._id) };
  cache.itemByCode.set(itemCode, res);
  return res;
}

module.exports = {
  name: 'inventory_pricing',
  sourceSystem: 'routestar',
  sourceEntity: 'pricing_row',
  rawModel: models.RawRouteStarPricing,

  getSourceRecordId(row) { return `${clean(row.customerId) || '?'}:${clean(row.itemCode) || clean(row.itemName) || '?'}`; },

  async processRecord(row, ctx) {
    const { tenant, batch, now, sourceRecordId, recordHash } = ctx;
    const dq = [];
    const customerId = await resolveCustomerId(tenant, row.customerId);
    if (!customerId) {
      dq.push(dqIssue(tenant, batch, 'missing_customer_ref', 'warning', 'customerPricingItems', null, clean(row.customerId), 'routestar', `Pricing row for unknown customer ${row.customerId}`, now));
      return { syncStatus: 'rejected', curatedTouches: {}, dq };
    }
    const agreementId = await ensureAgreement(tenant, customerId, now);
    const item = await ensureServiceItem(tenant, row.itemName || row.itemCode, row.itemName, now);

    await CustomerPricingItem.updateOne(
      { tenantId: tenant._id, 'source.sourceSystem': 'routestar', 'source.sourceRecordId': sourceRecordId },
      [{ $set: {
        tenantId: tenant._id, customerId, agreementId,
        serviceItemId: item.id, serviceCategoryId: item.categoryId,
        sourceItemCode: clean(row.itemCode) || clean(row.itemName) || 'UNKNOWN',
        sourceDescription: clean(row.itemName),
        salesPrice: toMoney(row.unitPrice) || toMoney(0),
        defaultQuantity: toMoney(1),
        normalizedFrequency: 'unknown',
        currency: 'USD',
        isActive: true,
        effectiveStart: { $ifNull: ['$effectiveStart', row.effectiveDate || now] },
        effectiveEnd: row.expirationDate || null,
        source: sourceStage(sourceRecordId, 'pricing_row', recordHash, batch._id, now, dq.length ? 'warning' : 'clean'),
      } }],
      { upsert: true },
    );
    return { syncStatus: 'updated', curatedTouches: {}, dq };
  },

  async recalcAffected() {  },
};
