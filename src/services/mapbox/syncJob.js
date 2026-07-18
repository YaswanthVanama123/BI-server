'use strict';

const env = require('../../config/env');
const { discover, discoverFromMapDistance, syncDrivingTimes } = require('./routeDriveTime');
const { recordStart, recordFinish } = require('../syncRuns');
const logger = require('../../utils/logger');

const log = logger.child('sync-job');
const jobs = new Map();
const key = (t) => String(t && t._id ? t._id : t);

function snapshot(tenant) {
  const j = jobs.get(key(tenant));
  return j ? { ...j } : { running: false, phase: 'idle' };
}
function isRunning(tenant) {
  const j = jobs.get(key(tenant));
  return !!(j && j.running);
}

function startSync(tenant, { batch = 500 } = {}) {
  const k = key(tenant);
  const existing = jobs.get(k);
  if (existing && existing.running) return { started: false, already: true, job: { ...existing } };

  const useMapDistance = !!env.enviromaster.mongoUri;
  const job = {
    running: true, phase: 'discovering', source: useMapDistance ? 'mapdistance' : 'invoices',
    startedAt: new Date().toISOString(), finishedAt: null,
    records: 0, pairs: 0, processed: 0, synced: 0, failed: 0, geocoded: 0, remaining: null, error: null,
  };
  jobs.set(k, job);

  (async () => {
    const runId = await recordStart('company-distances', 'Distances / driving-time Mapbox sync');
    try {
      let disc;
      if (useMapDistance) {
        disc = await discoverFromMapDistance(tenant);

        try { await discover(tenant, { registerPairs: false }); } catch (e) { log.error(`route-leg build skipped: ${e.message}`); }
      } else {
        disc = await discover(tenant, {});
      }
      job.records = disc.records || 0;
      job.pairs = disc.pairs || 0;
      job.phase = 'syncing';
      let prev = Infinity;
      for (;;) {
        const s = await syncDrivingTimes(tenant, { limit: batch });
        job.processed += s.processed; job.synced += s.synced; job.failed += s.failed; job.geocoded += s.geocoded;
        job.remaining = s.remaining;
        if (s.processed === 0 || s.remaining === 0 || s.remaining >= prev) break;
        prev = s.remaining;
      }
      job.phase = 'done';
    } catch (e) {
      job.error = e.message; job.phase = 'error';
      log.error(`sync job failed: ${e.message}`);
    } finally {
      job.running = false; job.finishedAt = new Date().toISOString();
      log.info(`sync job ${job.phase}: ${job.synced} synced, ${job.failed} failed, ${job.remaining} pending`);
      await recordFinish(runId, {
        status: job.phase === 'error' ? 'error' : 'done',
        summary: { source: job.source, pairs: job.pairs, synced: job.synced, failed: job.failed, geocoded: job.geocoded, remaining: job.remaining },
        error: job.error,
      });
    }
  })();

  return { started: true, already: false, job: { ...job } };
}

module.exports = { startSync, snapshot, isRunning };
