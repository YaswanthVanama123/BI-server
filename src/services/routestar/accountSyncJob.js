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
  job = { running: true, phase: 'discovering', all: !!all, startedAt: new Date().toISOString(), finishedAt: null, discovered: 0, scanned: 0, total: 0, stored: 0, withAccount: 0, error: null };

  (async () => {
    const runId = await recordStart('customer-accounts', 'Customer account fetch');
    try {
      const r = await fetchMissingAccounts({
        all,
        batchSize: 5,
        onDiscover: (p) => { job.phase = 'discovering'; job.scanned = p.scanned; job.discovered = p.added; },
        onProgress: (p) => { job.phase = 'fetching'; job.total = p.total; job.stored = p.stored; job.withAccount = p.withAccount; if (p.discovered != null) job.discovered = p.discovered; },
      });
      job.total = r.total; job.stored = r.stored; job.withAccount = r.withAccount; job.discovered = r.discovered;
      job.phase = 'done';
    } catch (e) {
      job.error = e.message; job.phase = 'error';
      log.error(`account sync failed: ${e.message}`);
    } finally {
      job.running = false; job.finishedAt = new Date().toISOString();
      try { require('../../api/controllers/reference.controller').invalidateCustomers(); } catch (e) { /* ignore */ }
      await recordFinish(runId, {
        status: job.phase === 'error' ? 'error' : 'done',
        summary: { discovered: job.discovered, total: job.total, stored: job.stored, withAccount: job.withAccount, all: job.all },
        error: job.error,
      });
    }
  })();

  return { started: true, already: false, job: { ...job } };
}

module.exports = { startSync, snapshot, isRunning };
