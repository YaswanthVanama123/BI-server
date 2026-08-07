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
  const captured = await CustomerAccount.find({}, { customerId: 1, customerName: 1 }).lean();

  const nameById = new Map();
  for (const c of srcCustomers) if (c.customerId) nameById.set(c.customerId, c.customerName || c.name || null);
  for (const c of captured) if (c.customerId && !nameById.has(c.customerId)) nameById.set(c.customerId, c.customerName || null);

  const done = new Set();
  if (!all) {
    const withData = await CustomerAccount.find(
      { accountNumber: { $nin: [null, ''] } },
      { customerId: 1 },
    ).lean();
    for (const d of withData) if (d.customerId) done.add(d.customerId);
  }

  let list = [...nameById.keys()]
    .filter((id) => all || !done.has(id))
    .map((id) => ({ customerId: id, customerName: nameById.get(id) }));
  if (limit) list = list.slice(0, Number(limit));
  return list;
}

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

async function fetchMissingAccounts({ all = false, limit, batchSize = 5, discover = true, runId = null, ids = null, onProgress, onDiscover } = {}) {
  const service = new RouteStarService();
  let stored = 0; let withAccount = 0; let discovered = 0; let total = 0;
  let totPricing = 0; let totRoutes = 0; let totActivity = 0;
  try {
    await service.open();

    let toFetch;
    if (ids && ids.length) {
      toFetch = ids.map((id) => ({ customerId: id, customerName: null }));
      log.info(`targeted fetch: ${toFetch.length} explicit customer id(s), skipping discovery`);
    } else {
      if (discover) {
        log.info('phase 1: discovering all customers from the live grid…');
        const d = await discoverAllCustomers(service, (p) => { if (onDiscover) onDiscover(p); });
        discovered = d.added;
        log.info(`phase 1 done: scanned ${d.scanned}, ${d.added} new, ${d.updated} existing`);
      }
      toFetch = await selectMissing({ all, limit });
    }
    total = toFetch.length;
    log.info(`phase 2: ${total} customer(s) to fetch detail (${ids && ids.length ? 'targeted' : all ? 'all' : 'missing only'})`);
    if (total && !(ids && ids.length)) log.info(`  need-detail sample: ${toFetch.slice(0, 10).map((c) => c.customerId).join(', ')}${total > 10 ? ` …(+${total - 10} more)` : ''}`);
    if (onProgress) onProgress({ total, stored: 0, withAccount: 0, discovered });
    if (!total) { log.info('nothing to fetch — every known customer already has data.'); return { total, stored, withAccount, discovered }; }

    for (let i = 0; i < toFetch.length; i += batchSize) {
      const chunk = toFetch.slice(i, i + batchSize);
      log.info(`batch ${Math.floor(i / batchSize) + 1}: fetching ${chunk.length} customer(s) [${i + 1}-${i + chunk.length} of ${total}]`);
      let ops = [];
      let chunkWithAccount = 0; let chunkPricing = 0; let chunkRoutes = 0; let chunkActivity = 0;
      await service.fetchCustomerAccounts({
        customers: chunk,
        accumulate: false,
        onResult: (rec) => {
          if (rec.accountNumber) chunkWithAccount += 1;
          chunkPricing += (rec.pricing || []).length;
          chunkRoutes += (rec.routes || []).length;
          chunkActivity += (rec.activity || []).length;
          const set = { ...rec };
          if (runId) set.lastFetchRunId = runId;
          if (!set.pricing || !set.pricing.length) delete set.pricing;
          if (!set.routes || !set.routes.length) delete set.routes;
          if (!set.activity || !set.activity.length) delete set.activity;
          ops.push({ updateOne: { filter: { customerId: rec.customerId }, update: { $set: set }, upsert: true } });
        },
      });
      if (ops.length) {
        const res = await CustomerAccount.bulkWrite(ops, { ordered: false });
        stored += ops.length;
        withAccount += chunkWithAccount;
        totPricing += chunkPricing; totRoutes += chunkRoutes; totActivity += chunkActivity;
        log.info(`  bulkWrite: matched=${res.matchedCount} modified=${res.modifiedCount} upserted=${res.upsertedCount} · batch tabs pricing=${chunkPricing} routes=${chunkRoutes} activity=${chunkActivity}`);
      }
      ops = null;
      if (onProgress) onProgress({ total, stored, withAccount, discovered });
      log.info(`stored ${stored}/${total} (running totals: pricing=${totPricing} routes=${totRoutes} activity=${totActivity})`);
    }
  } finally {
    await service.close();
  }
  log.info(`fetch complete: discovered=${discovered} detailFetched=${stored}/${total} withAccount=${withAccount} · captured pricing=${totPricing} routes=${totRoutes} activity=${totActivity}`);
  return { total, stored, withAccount, discovered };
}

module.exports = { fetchMissingAccounts, selectMissing, discoverAllCustomers };
