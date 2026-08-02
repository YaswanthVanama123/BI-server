'use strict';

const { fetchCreatedDates } = require('./createdDateFetch');
const { recordStart, recordFinish } = require('../syncRuns');
const logger = require('../../utils/logger');

const log = logger.child('created-date-job');
let job = null;

function snapshot() { return job ? { ...job } : { running: false, phase: 'idle' }; }
function isRunning() { return !!(job && job.running); }

function startSync({ all = false } = {}) {
  if (job && job.running) return { started: false, already: true, job: { ...job } };
  job = { running: true, phase: 'fetching', all: !!all, startedAt: new Date().toISOString(), finishedAt: null, scanned: 0, stored: 0, error: null };

  (async () => {
    const runId = await recordStart('customer-created-dates', 'Customer created-date fetch');
    try {
      const r = await fetchCreatedDates({
        all,
        onProgress: (p) => { job.scanned = p.scanned; job.stored = p.stored; },
      });
      job.scanned = r.scanned; job.stored = r.stored;
      job.phase = 'done';
    } catch (e) {
      job.error = e.message; job.phase = 'error';
      log.error(`created-date fetch failed: ${e.message}`);
    } finally {
      job.running = false; job.finishedAt = new Date().toISOString();
      try { require('../../api/controllers/reference.controller').invalidateCustomers(); } catch (e) { /* ignore */ }
      await recordFinish(runId, {
        status: job.phase === 'error' ? 'error' : 'done',
        summary: { scanned: job.scanned, stored: job.stored, all: job.all },
        error: job.error,
      });
    }
  })();

  return { started: true, already: false, job: { ...job } };
}

module.exports = { startSync, snapshot, isRunning };
