'use strict';

const { getSourceDb } = require('../../config/database');
const { models } = require('../../models');
const { RouteStarService } = require('../../automation/routestar');
const logger = require('../../utils/logger');

const log = logger.child('account-fetch');
const { CustomerAccount } = models;
const clean = (v) => (v == null ? '' : String(v).trim());
const parseDate = (s) => { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };

async function selectMissing({ all = false, limit } = {}) {
  const src = getSourceDb();
  const srcCustomers = await src.collection('routestarcustomers')
    .find({}, { projection: { customerId: 1, name: 1, customerName: 1 } }).toArray();
  const captured = await CustomerAccount.find({}, { customerId: 1, customerName: 1, fetchedAt: 1 }).lean();

  // Universe = every customer we know about — from the source import AND from
  // bi_customeraccounts (which includes everyone discovered from the live grid).
  const nameById = new Map();
  for (const c of srcCustomers) if (c.customerId) nameById.set(c.customerId, c.customerName || c.name || null);
  for (const c of captured) if (c.customerId && !nameById.has(c.customerId)) nameById.set(c.customerId, c.customerName || null);

  // "Has data" = this customer's detail page was already fetched (fetchedAt set).
  const done = new Set();
  if (!all) for (const c of captured) if (c.customerId && c.fetchedAt) done.add(c.customerId);

  let list = [...nameById.keys()]
    .filter((id) => all || !done.has(id))
    .map((id) => ({ customerId: id, customerName: nameById.get(id) }));
  if (limit) list = list.slice(0, Number(limit));
  return list;
}

// Step 1: walk the ENTIRE live RouteStar customers grid (all pages, high level)
// and reconcile with bi_customeraccounts — create a stub for anyone new, update
// (refresh created date) anyone already present. This whole pass finishes before
// we fetch any detail, so the full customer universe is known first.
async function discoverAllCustomers(service, onProgress) {
  const existing = await CustomerAccount.find({}, { customerId: 1 }).lean();
  const have = new Set(existing.map((d) => d.customerId));
  let scanned = 0; let added = 0; let updated = 0; let ops = [];
  const flush = async () => { if (ops.length) { const b = ops; ops = []; await CustomerAccount.bulkWrite(b, { ordered: false }); } };
  await service.fetchCustomerCreatedDates({
    onPage: async (rows) => {
      for (const r of rows) {
        scanned += 1;
        if (!r.customerId) continue;
        if (have.has(r.customerId)) { updated += 1; } else { have.add(r.customerId); added += 1; }
        const cd = parseDate(r.created);
        const update = { $setOnInsert: { customerId: r.customerId, status: 'ok' } };
        if (cd) update.$set = { createdDate: cd };
        ops.push({ updateOne: { filter: { customerId: r.customerId }, update, upsert: true } });
      }
      if (ops.length >= 200) await flush();
      if (onProgress) onProgress({ scanned, added, updated });
    },
  });
  await flush();
  log.info(`discovery: scanned ${scanned} live customers — ${added} new, ${updated} existing`);
  return { scanned, added, updated };
}

async function fetchMissingAccounts({ all = false, limit, batchSize = 5, discover = true, onProgress, onDiscover } = {}) {
  const service = new RouteStarService();
  let stored = 0; let withAccount = 0; let discovered = 0; let total = 0;
  try {
    await service.open();

    if (discover) {
      const d = await discoverAllCustomers(service, (p) => { if (onDiscover) onDiscover(p); });
      discovered = d.added;
    }

    const toFetch = await selectMissing({ all, limit });
    total = toFetch.length;
    log.info(`account fetch: ${total} customer(s) need detail (${all ? 'all' : 'missing only'})`);
    if (onProgress) onProgress({ total, stored: 0, withAccount: 0, discovered });
    if (!total) return { total, stored, withAccount, discovered };

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
      if (onProgress) onProgress({ total, stored, withAccount, discovered });
      log.info(`stored ${stored}/${total}`);
    }
  } finally {
    await service.close();
  }
  return { total, stored, withAccount, discovered };
}

module.exports = { fetchMissingAccounts, selectMissing, discoverAllCustomers };
