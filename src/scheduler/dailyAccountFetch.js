'use strict';

const logger = require('../utils/logger');
const { startSync, isRunning } = require('../services/routestar/accountSyncJob');

const log = logger.child('scheduler:accounts');
let timer = null;

function msUntilNext(hour, minute) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function runOnce() {
  if (isRunning()) { log.warn('account sync already running — skipping this tick'); return; }
  const r = startSync({});
  log.info(`daily customer account fetch ${r.started ? 'started in background' : 'skipped (already running)'}`);
}

function start({ hour = 0, minute = 30 } = {}) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const schedule = () => {
    const wait = msUntilNext(hour, minute);
    log.info(`next customer account auto-fetch at ${hh}:${mm} (in ~${Math.round(wait / 60000)} min)`);
    timer = setTimeout(() => { runOnce(); schedule(); }, wait);
    if (timer.unref) timer.unref();
  };
  schedule();
  return { stop: () => { if (timer) clearTimeout(timer); } };
}

module.exports = { start, runOnce };
