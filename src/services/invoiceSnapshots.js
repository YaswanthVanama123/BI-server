'use strict';
const { models } = require('../models');
const logger = require('../utils/logger');

const log = logger.child('invoice-snapshots');
const TTL_MS = 60000;
let cache = null;

async function snapshotMap() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  try {
    const docs = await models.InvoiceSnapshot.find(
      { status: 'ok' },
      { _id: 0, invoiceNumber: 1, status: 1, subtotal: 1, sourceSubtotal: 1, tax: 1, total: 1, lineItems: 1, fetchedAt: 1 },
    ).lean();
    cache = { at: Date.now(), map: new Map(docs.map((d) => [d.invoiceNumber, d])) };
  } catch (e) {
    log.warn(`could not load invoice snapshots: ${e.message}`);
    cache = { at: Date.now(), map: new Map() };
  }
  return cache.map;
}

function invalidateSnapshots() { cache = null; }

module.exports = { snapshotMap, invalidateSnapshots };
