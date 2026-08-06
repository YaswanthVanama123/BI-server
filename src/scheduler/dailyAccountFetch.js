'use strict';

const env = require('../config/env');
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

function runOnce(all = env.routestar.accountFetch.all) {
  if (isRunning()) { log.warn('account sync already running — skipping this tick'); return; }
  const r = startSync({ all });
  log.info(`daily customer account fetch (${all ? 'all customers' : 'missing only'}) ${r.started ? 'started in background' : 'skipped (already running)'}`);
}

function start(opts = {}) {
  const cfg = env.routestar.accountFetch;
  const hour = opts.hour != null ? opts.hour : cfg.hour;
  const minute = opts.minute != null ? opts.minute : cfg.minute;
  const all = opts.all != null ? opts.all : cfg.all;
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const schedule = () => {
    const wait = msUntilNext(hour, minute);
    log.info(`next customer account auto-fetch at ${hh}:${mm} (${all ? 'all customers' : 'missing only'}, in ~${Math.round(wait / 60000)} min)`);
    timer = setTimeout(() => { runOnce(all); schedule(); }, wait);
    if (timer.unref) timer.unref();
  };
  schedule();
  if (cfg.onStart) { log.info('ACCOUNT_FETCH_ON_START set — running an initial full fetch now'); runOnce(all); }
  return { stop: () => { if (timer) clearTimeout(timer); } };
}

module.exports = { start, runOnce };
