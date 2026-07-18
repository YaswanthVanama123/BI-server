'use strict';
const { models } = require('../models');
const { recordHash } = require('../utils/util');

const { ImportBatch, SourceSyncState, DataQualityIssue } = models;

async function runImport({ tenant, handler, rows, fileMeta = {}, now = new Date() }) {
  const syncKey = { tenantId: tenant._id, sourceSystem: handler.sourceSystem, sourceEntity: handler.sourceEntity };
  const syncState = await SourceSyncState.findOne(syncKey);
  const batch = await ImportBatch.create({
    ...syncKey,
    fileName: fileMeta.fileName, fileHash: fileMeta.fileHash,
    startedAt: now, status: 'running',
    counts: { read: rows.length, inserted: 0, updated: 0, unchanged: 0, rejected: 0 },
    watermarkBefore: syncState ? syncState.lastWatermark : null,
  });

  const ctx = {
    tenant, batch, now, handler,
    touched: { techDates: new Set(), routeMonths: new Set(), customerMonths: new Set(), categoryMonths: new Set() },
    dq: [],
    controlTotal: 0, loadedTotal: 0, maxWatermark: syncState ? syncState.lastWatermark : null,
  };

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sourceRecordId = handler.getSourceRecordId(row);
      const hash = recordHash(row);

      const rawKey = { tenantId: tenant._id, sourceSystem: handler.sourceSystem, sourceEntity: handler.sourceEntity, sourceRecordId, recordHash: hash };
      const rawUpsert = await handler.rawModel.updateOne(
        rawKey,
        {
          $setOnInsert: { ...rawKey, rawPayload: row, rawHeaders: fileMeta.headers, rowNumber: i + 1, importedAt: now, importBatchId: batch._id, parseStatus: 'parsed' },
          $set: { lastSeenAt: now },
        },
        { upsert: true }
      );
      const rawUnchanged = rawUpsert.upsertedCount === 0 && rawUpsert.modifiedCount === 0;

      try {
        const res = await handler.processRecord(row, { ...ctx, sourceRecordId, recordHash: hash, rawUnchanged });
        batch.counts[res.syncStatus] = (batch.counts[res.syncStatus] || 0) + 1;
        if (res.controlAmount) ctx.controlTotal += res.controlAmount;
        if (res.loadedAmount) ctx.loadedTotal += res.loadedAmount;
        if (res.watermark && (!ctx.maxWatermark || res.watermark > ctx.maxWatermark)) ctx.maxWatermark = res.watermark;
        mergeTouches(ctx.touched, res.curatedTouches);
        (res.dq || []).forEach((d) => ctx.dq.push(d));
      } catch (err) {
        batch.counts.rejected += 1;
        await handler.rawModel.updateOne(rawKey, { $set: { parseStatus: 'parse_error', parseErrors: [err.message] } });
        ctx.dq.push(dqIssue(tenant, batch, 'rejected_record', 'error', handler.rawModel.collection.name, null, sourceRecordId, handler.sourceSystem, err.message, now));
      }
    }

    if (ctx.dq.length) await DataQualityIssue.insertMany(ctx.dq);

    await handler.recalcAffected(ctx);

    batch.reconciliation = {
      sourceRowCount: rows.length,
      sourceTotalAmount: ctx.controlTotal ? String(ctx.controlTotal.toFixed(4)) : undefined,
      loadedRowCount: batch.counts.inserted + batch.counts.updated + batch.counts.unchanged,
      loadedTotalAmount: ctx.loadedTotal ? String(ctx.loadedTotal.toFixed(4)) : undefined,
      matched: Math.abs(ctx.controlTotal - ctx.loadedTotal) < 0.01,
    };

    batch.status = batch.counts.rejected > 0 ? 'partial' : 'completed';
    batch.finishedAt = new Date(now.getTime());
    batch.watermarkAfter = ctx.maxWatermark;
    await batch.save();

    await SourceSyncState.updateOne(syncKey, {
      $set: { lastSuccessfulSyncAt: batch.finishedAt, lastWatermark: ctx.maxWatermark, lastBatchId: batch._id, status: 'idle', retryCount: 0 },
      $setOnInsert: syncKey,
    }, { upsert: true });

    return batch;
  } catch (fatal) {
    batch.status = 'failed';
    batch.errorSummary = fatal.message;
    batch.finishedAt = new Date();
    await batch.save();
    await SourceSyncState.updateOne(syncKey, { $set: { status: 'error' }, $inc: { retryCount: 1 } }, { upsert: true });
    throw fatal;
  }
}

function mergeTouches(dst, src) {
  if (!src) return;
  for (const k of Object.keys(dst)) (src[k] || []).forEach((v) => dst[k].add(v));
}

function dqIssue(tenant, batch, issueType, severity, collectionName, recordId, sourceRecordId, sourceSystem, description, detectedAt, context) {
  return { tenantId: tenant._id, issueType, severity, collectionName, recordId, sourceRecordId, sourceSystem, description, context, detectedAt, detectedByBatchId: batch._id, resolutionStatus: 'open' };
}

module.exports = { runImport, dqIssue };
