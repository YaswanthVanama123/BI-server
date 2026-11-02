'use strict';

const { refreshInvoices } = require('./invoiceRefresh');
const { recordStart, recordFinish } = require('../syncRuns');
const logger = require('../../utils/logger');

const log = logger.child('invoice-refresh-job');
let job = null;

function snapshot() { return job ? { ...job } : { running: false, phase: 'idle' }; }
function isRunning() { return !!(job && job.running); }

function otherRouteStarJob() {
  try { if (require('./accountSyncJob').isRunning()) return 'customer-accounts'; } catch (e) { void e; }
  try { if (require('./createdDateSyncJob').isRunning()) return 'customer-created-dates'; } catch (e) { void e; }
  return null;
}

function invalidateReports() {
  try { require('../invoiceSnapshots').invalidateSnapshots(); } catch (e) { void e; }
  try { require('../../api/controllers/revenue.controller').invalidate(); } catch (e) { void e; }
  try { require('../../api/controllers/routeCalendar.controller').invalidate(); } catch (e) { void e; }
  try { require('../../api/controllers/invoices.controller').invalidate(); } catch (e) { void e; }
}

function startSync({ all = false, limit } = {}) {
  if (job && job.running) return { started: false, already: true, job: { ...job } };
  const busy = otherRouteStarJob();
  if (busy) return { started: false, already: false, busy, job: snapshot() };
  job = {
    running: true, phase: 'scanning', all: !!all, startedAt: new Date().toISOString(), finishedAt: null,
    total: 0, refreshed: 0, fixed: 0, failed: 0, error: null,
  };

  (async () => {
    const runId = await recordStart('invoice-lines', 'Invoice line-item refresh from RouteStar');
    try {
      const r = await refreshInvoices({
        all,
        limit,
        onProgress: (p) => { job.phase = p.total ? 'refreshing' : 'scanning'; Object.assign(job, p); },
      });
      Object.assign(job, r);
      job.phase = 'done';
    } catch (e) {
      job.error = e.message; job.phase = 'error';
      log.error(`invoice line refresh failed: ${e.message}`);
    } finally {
      job.running = false; job.finishedAt = new Date().toISOString();
      invalidateReports();
      await recordFinish(runId, {
        status: job.phase === 'error' ? 'error' : 'done',
        summary: { total: job.total, refreshed: job.refreshed, fixed: job.fixed, failed: job.failed, all: job.all },
        error: job.error,
      });
    }
  })();

  return { started: true, already: false, job: { ...job } };
}

module.exports = { startSync, snapshot, isRunning };
