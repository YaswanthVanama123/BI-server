'use strict';
const { models } = require('../../../models');
const { Customer } = models;

async function resolveCustomer(tenant, { routeStarCustomerId, routeStarAccountNumber, displayName, batch, now }) {
  const rsId = clean(routeStarCustomerId);
  const acct = clean(routeStarAccountNumber);

  if (rsId) {
    const byId = await Customer.findOne({ tenantId: tenant._id, routeStarCustomerId: rsId });
    if (byId) return byId;
  }
  if (acct) {
    const byAcct = await Customer.findOne({ tenantId: tenant._id, routeStarAccountNumber: acct });
    if (byAcct) return byAcct;
  }
  if (rsId || acct) {
    const shell = await Customer.findOneAndUpdate(
      { tenantId: tenant._id, routeStarCustomerId: rsId || `ACCT:${acct}` },
      {
        $setOnInsert: {
          tenantId: tenant._id,
          routeStarCustomerId: rsId || `ACCT:${acct}`,
          routeStarAccountNumber: acct || undefined,
          customerName: displayName || '(unknown)',
          customerStatus: 'unknown',
          customerStatusEffectiveAt: now,
          source: {
            sourceSystem: 'routestar', sourceRecordId: rsId || acct, sourceEntity: 'customer_shell',
            importedAt: now, lastSyncedAt: now, importBatchId: batch._id,
            recordHash: 'shell', syncStatus: 'inserted', dataQualityStatus: 'warning',
          },
        },
      },
      { upsert: true, new: true }
    );
    return shell;
  }
  return null;
}

function clean(v) { const s = String(v == null ? '' : v).trim(); return s || undefined; }

module.exports = { resolveCustomer };
