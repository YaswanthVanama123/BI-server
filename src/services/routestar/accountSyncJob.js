'use strict';

const { fetchMissingAccounts } = require('./accountFetch');
const { recordStart, recordFinish } = require('../syncRuns');
const logger = require('../../utils/logger');

const log = logger.child('account-sync-job');
let job = null;

function snapshot() { return job ? { ...job } : { running: false, phase: 'idle' }; }
function isRunning() { return !!(job && job.running); }

function startSync({ all = false } = {}) {
  if (job && job.running) return { started: false, already: true, job: { ...job } };
  job = { running: true, phase: 'fetching', all: !!all, startedAt: new Date().toISOString(), finishedAt: null, total: 0, stored: 0, withAccount: 0, error: null };

  (async () => {
    const runId = await recordStart('customer-accounts', 'Customer account fetch');
    try {
      const r = await fetchMissingAccounts({
        all,
        batchSize: 5,
        onProgress: (p) => { job.total = p.total; job.stored = p.stored; job.withAccount = p.withAccount; },
      });
      job.total = r.total; job.stored = r.stored; job.withAccount = r.withAccount;
      job.phase = 'done';
    } catch (e) {
      job.error = e.message; job.phase = 'error';
      log.error(`account sync failed: ${e.message}`);
    } finally {
      job.running = false; job.finishedAt = new Date().toISOString();
      await recordFinish(runId, {
        status: job.phase === 'error' ? 'error' : 'done',
        summary: { total: job.total, stored: job.stored, withAccount: job.withAccount, all: job.all },
        error: job.error,
      });
    }
  })();

  return { started: true, already: false, job: { ...job } };
}

module.exports = { startSync, snapshot, isRunning };
