'use strict';
const { getSourceDb } = require('../../config/database');

const DROP = ['_id', '__v', 'createdAt', 'updatedAt', 'lastSyncDate', 'lastSyncedAt', 'rawData',
  'stockProcessed', 'stockProcessedAt', 'stockProcessingError', 'createdBy', 'lastUpdatedBy'];

function normalize(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!DROP.includes(k)) out[k] = v;
  return out;
}

async function fetchAll(collection, filter = {}, { limit = 0 } = {}) {
  const db = getSourceDb();
  let cursor = db.collection(collection).find(filter);
  if (limit) cursor = cursor.limit(limit);
  const docs = await cursor.toArray();
  return docs.map(normalize);
}

async function count(collection, filter = {}) {
  return getSourceDb().collection(collection).countDocuments(filter);
}

function fetchCustomers(opts) {
  return fetchAll('routestarcustomers', {}, opts);
}

function fetchClosedInvoices(opts) {
  return fetchAll('routestarinvoices', { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] }, opts);
}

function fetchCustomerRoutes(opts) { return fetchAll('routestarcustomerroutes', {}, opts); }
function fetchCustomerPricing(opts) { return fetchAll('routestarcustomerpricings', {}, opts); }
function fetchItems(opts) { return fetchAll('routestaritems', {}, opts); }

module.exports = {
  normalize, fetchAll, count,
  fetchCustomers, fetchClosedInvoices, fetchCustomerRoutes, fetchCustomerPricing, fetchItems,
};
