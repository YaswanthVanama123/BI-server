'use strict';

const { models } = require('../../models');
const { RouteStarService } = require('../../automation/routestar');
const logger = require('../../utils/logger');

const log = logger.child('created-date-fetch');
const { CustomerAccount } = models;

const parseDate = (s) => { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };

// Scrapes the RouteStar customer list grid for every customer's "Created" date and stores it
// into bi_customeraccounts.createdDate — only for customers that don't already have one
// ({ all: true } backfills/overwrites everyone).
async function fetchCreatedDates({ all = false, onProgress } = {}) {
  const existing = await CustomerAccount.find({}, { customerId: 1, createdDate: 1 }).lean();
  const have = new Map(existing.map((d) => [d.customerId, d.createdDate || null]));

  const service = new RouteStarService();
  let scanned = 0; let stored = 0;
  const ops = [];
  const flush = async () => {
    if (!ops.length) return;
    const batch = ops.splice(0, ops.length);
    await CustomerAccount.bulkWrite(batch, { ordered: false });
  };

  try {
    await service.open();
    await service.fetchCustomerCreatedDates({
      onPage: async (rows) => {
        for (const r of rows) {
          scanned += 1;
          const cd = parseDate(r.created);
          if (!cd) continue;
          const known = have.has(r.customerId);
          const alreadyHas = known && have.get(r.customerId);
          if (!all && alreadyHas) continue; // only fill nulls unless all=true
          if (known) {
            ops.push({ updateOne: { filter: { customerId: r.customerId }, update: { $set: { createdDate: cd } } } });
          } else {
            ops.push({ updateOne: { filter: { customerId: r.customerId }, update: { $setOnInsert: { customerId: r.customerId, status: 'ok' }, $set: { createdDate: cd } }, upsert: true } });
          }
          have.set(r.customerId, cd);
          stored += 1;
        }
        if (ops.length >= 200) await flush();
        if (onProgress) onProgress({ scanned, stored });
      },
    });
    await flush();
  } finally {
    await service.close();
  }
  log.info(`created-date fetch: scanned ${scanned}, stored ${stored} (${all ? 'all' : 'null only'})`);
  return { scanned, stored };
}

module.exports = { fetchCreatedDates };
