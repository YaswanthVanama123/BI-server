'use strict';

const { getSourceDb } = require('../../config/database');
const { models } = require('../../models');
const { RouteStarService } = require('../../automation/routestar');
const logger = require('../../utils/logger');

const log = logger.child('account-fetch');
const { CustomerAccount } = models;
const clean = (v) => (v == null ? '' : String(v).trim());

async function selectMissing({ all = false, limit } = {}) {
  const src = getSourceDb();
  const customers = await src.collection('routestarcustomers')
    .find({}, { projection: { customerId: 1, name: 1, customerName: 1, accountNumber: 1 } }).toArray();

  // "Done" = already captured in bi_customeraccounts AND we already have an account #
  // (from the source record or the captured one). Captured-but-account-less customers are
  // re-fetched so a re-sync actually tries to fill the missing account numbers.
  const done = new Set();
  if (!all) {
    const captured = await CustomerAccount.find({ status: { $ne: 'error' } }, { customerId: 1, accountNumber: 1 }).lean();
    const biAcct = new Map(captured.map((d) => [d.customerId, clean(d.accountNumber)]));
    for (const c of customers) {
      const hasAccount = clean(c.accountNumber) || biAcct.get(c.customerId);
      if (biAcct.has(c.customerId) && hasAccount) done.add(c.customerId);
    }
  }

  let list = customers
    .filter((c) => c.customerId)
    .filter((c) => all || !done.has(c.customerId))
    .map((c) => ({ customerId: c.customerId, customerName: c.customerName || c.name }));
  if (limit) list = list.slice(0, Number(limit));
  return list;
}

async function fetchMissingAccounts({ all = false, limit, batchSize = 5, onProgress } = {}) {
  const toFetch = await selectMissing({ all, limit });
  log.info(`account fetch: ${toFetch.length} customer(s) (${all ? 'all' : 'missing only'})`);
  if (onProgress) onProgress({ total: toFetch.length, stored: 0, withAccount: 0 });
  if (!toFetch.length) return { total: 0, stored: 0, withAccount: 0 };

  const service = new RouteStarService();
  let stored = 0; let withAccount = 0;
  try {
    await service.open();
    for (let i = 0; i < toFetch.length; i += batchSize) {
      const chunk = toFetch.slice(i, i + batchSize);
      let ops = [];
      let chunkWithAccount = 0;
      await service.fetchCustomerAccounts({
        customers: chunk,
        accumulate: false,
        onResult: (rec) => {
          if (rec.accountNumber) chunkWithAccount += 1;
          ops.push({ updateOne: { filter: { customerId: rec.customerId }, update: { $set: rec }, upsert: true } });
        },
      });
      if (ops.length) {
        await CustomerAccount.bulkWrite(ops, { ordered: false });
        stored += ops.length;
        withAccount += chunkWithAccount;
      }
      ops = null;
      if (onProgress) onProgress({ total: toFetch.length, stored, withAccount });
      log.info(`stored ${stored}/${toFetch.length}`);
    }
  } finally {
    await service.close();
  }
  return { total: toFetch.length, stored, withAccount };
}

module.exports = { fetchMissingAccounts, selectMissing };
