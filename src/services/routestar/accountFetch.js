'use strict';

const { getSourceDb } = require('../../config/database');
const { models } = require('../../models');
const { RouteStarService } = require('../../automation/routestar');
const logger = require('../../utils/logger');

const log = logger.child('account-fetch');
const { CustomerAccount } = models;

async function selectMissing({ all = false, limit } = {}) {
  const src = getSourceDb();
  const customers = await src.collection('routestarcustomers')
    .find({}, { projection: { customerId: 1, name: 1 } }).toArray();

  const already = new Set();
  if (!all) {
    const done = await CustomerAccount.find({ status: { $ne: 'error' } }, { customerId: 1 }).lean();
    for (const d of done) already.add(d.customerId);
  }

  let list = customers
    .filter((c) => c.customerId)
    .filter((c) => all || !already.has(c.customerId))
    .map((c) => ({ customerId: c.customerId, customerName: c.name }));
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
