'use strict';

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const norm = (v) => String(v || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

function dqStatus(dq) {
  if (dq.some((d) => d.severity === 'error' || d.severity === 'critical')) return 'error';
  if (dq.length) return 'warning';
  return 'clean';
}

function sourceStage(sourceRecordId, sourceEntity, recordHash, batchId, now, status) {
  return {
    sourceSystem: 'routestar', sourceRecordId, sourceEntity,
    importedAt: { $ifNull: ['$source.importedAt', now] },
    lastSyncedAt: now, importBatchId: batchId, recordHash,
    syncStatus: { $cond: [{ $ifNull: ['$source.recordHash', false] }, 'updated', 'inserted'] },
    dataQualityStatus: status,
  };
}

module.exports = { clean, norm, dqStatus, sourceStage };
