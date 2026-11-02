'use strict';
const { models } = require('../../models');
const { getSourceDb } = require('../../config/database');
const { RouteStarService, SessionExpiredError } = require('../../automation/routestar');
const { cents, linesCents, netCents } = require('../../api/lib/invoiceMoney');
const logger = require('../../utils/logger');

const log = logger.child('invoice-refresh');
const { InvoiceSnapshot } = models;
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };
const MAX_ATTEMPTS = 3;

async function scanInvoices() {
  const [docs, snaps] = await Promise.all([
    getSourceDb().collection('routestarinvoices').find(
      CLOSED,
      { projection: { _id: 0, invoiceNumber: 1, subtotal: 1, tax: 1, total: 1, lastModified: 1, detailUrl: 1, dateCompleted: 1, 'lineItems.amount': 1 } },
    ).batchSize(5000).toArray(),
    InvoiceSnapshot.find({}, { _id: 0, invoiceNumber: 1, status: 1, subtotal: 1, sourceSubtotal: 1, fetchedAt: 1, attempts: 1 }).lean(),
  ]);
  return { docs, snaps: new Map(snaps.map((s) => [s.invoiceNumber, s])) };
}

const snapshotMatches = (snap, header) => !!snap && snap.status === 'ok'
  && (cents(snap.subtotal) === header || (snap.sourceSubtotal != null && cents(snap.sourceSubtotal) === header));

function staleReason(d, snap, all) {
  const header = netCents(d);
  if (all) return 'all';
  if (snap && snap.status === 'ok') {
    if (!snapshotMatches(snap, header)) return 'changed-since-refresh';
    if (d.lastModified && snap.fetchedAt && new Date(d.lastModified) > new Date(snap.fetchedAt)) return 'modified-since-refresh';
    return null;
  }
  if (snap && snap.status === 'error' && (snap.attempts || 0) >= MAX_ATTEMPTS) return null;
  if (linesCents(d.lineItems) !== header) return snap ? 'retry' : 'lines-mismatch';
  return null;
}

async function findStale({ all = false, limit } = {}) {
  const { docs, snaps } = await scanInvoices();
  const stale = [];
  for (const d of docs) {
    if (!d.invoiceNumber) continue;
    const reason = staleReason(d, snaps.get(d.invoiceNumber), all);
    if (!reason) continue;
    stale.push({
      invoiceNumber: d.invoiceNumber,
      detailUrl: d.detailUrl || null,
      sourceSubtotal: netCents(d) / 100,
      sourceLinesTotal: linesCents(d.lineItems) / 100,
      lastModified: d.lastModified || null,
      dateCompleted: d.dateCompleted || null,
      reason,
    });
  }
  stale.sort((a, b) => new Date(b.dateCompleted || 0) - new Date(a.dateCompleted || 0));
  return limit > 0 ? stale.slice(0, limit) : stale;
}

async function lineHealth() {
  const { docs, snaps } = await scanInvoices();
  let mismatched = 0; let mismatchCents = 0; let refreshed = 0; let errors = 0; let pending = 0;
  for (const d of docs) {
    const snap = snaps.get(d.invoiceNumber);
    if (snap && snap.status === 'ok') refreshed += 1;
    if (snap && snap.status === 'error') errors += 1;
    const header = netCents(d);
    const fixed = snapshotMatches(snap, header);
    const diff = linesCents(d.lineItems) - header;
    if (diff !== 0 && !fixed) { mismatched += 1; mismatchCents += diff; }
    if (staleReason(d, snap, false)) pending += 1;
  }
  return { invoices: docs.length, mismatched, mismatchAmount: mismatchCents / 100, refreshed, errors, pending };
}

async function refreshInvoices({ all = false, limit, onProgress } = {}) {
  const targets = await findStale({ all, limit });
  const total = targets.length;
  let refreshed = 0; let fixed = 0; let failed = 0;
  if (onProgress) onProgress({ total, refreshed, fixed, failed });
  if (!total) return { total, refreshed, fixed, failed };

  const service = new RouteStarService();
  try {
    await service.open();
    for (const t of targets) {
      try {
        const d = await service.fetchInvoiceDetail({ invoiceNumber: t.invoiceNumber, detailUrl: t.detailUrl });
        const linesTotal = linesCents(d.items);
        await InvoiceSnapshot.updateOne(
          { invoiceNumber: t.invoiceNumber },
          {
            $set: {
              status: 'ok', detailUrl: t.detailUrl, subtotal: d.subtotal, tax: d.tax, total: d.total,
              linesTotal: linesTotal / 100, lineItems: d.items, sourceSubtotal: t.sourceSubtotal,
              sourceLinesTotal: t.sourceLinesTotal, sourceLastModified: t.lastModified, reason: t.reason,
              fetchedAt: new Date(), attempts: 0, lastError: null, lastErrorAt: null,
            },
          },
          { upsert: true },
        );
        refreshed += 1;
        if (linesTotal === cents(d.subtotal)) fixed += 1;
      } catch (e) {
        failed += 1;
        log.warn(`refresh ${t.invoiceNumber} failed: ${e.message}`);
        await InvoiceSnapshot.updateOne(
          { invoiceNumber: t.invoiceNumber },
          { $set: { lastError: e.message, lastErrorAt: new Date(), reason: t.reason }, $inc: { attempts: 1 }, $setOnInsert: { status: 'error' } },
          { upsert: true },
        ).catch(() => {});
        if (e instanceof SessionExpiredError) { await service.close(); await service.open(); }
      }
      if (onProgress) onProgress({ total, refreshed, fixed, failed });
    }
  } finally {
    await service.close();
  }
  log.info(`invoice line refresh: ${refreshed}/${total} refreshed (${fixed} now match their subtotal), ${failed} failed`);
  return { total, refreshed, fixed, failed };
}

module.exports = { findStale, lineHealth, refreshInvoices, staleReason, snapshotMatches };
