'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');
const { startSync } = require('../services/routestar/invoiceRefreshJob');

const log = logger.child('scheduler:invoice-lines');
const RETRY_MS = 15 * 60000;
const MAX_RETRIES = 8;
let timer = null;

function msUntilNext(hour, minute) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function runOnce(attempt = 0) {
  const { limit } = env.routestar.invoiceRefresh;
  const r = startSync({ limit: limit > 0 ? limit : undefined });
  if (r.busy && attempt < MAX_RETRIES) {
    log.warn(`RouteStar is busy with ${r.busy} — retrying the invoice line refresh in 15 min`);
    const t = setTimeout(() => runOnce(attempt + 1), RETRY_MS);
    if (t.unref) t.unref();
    return;
  }
  log.info(`daily invoice line refresh ${r.started ? 'started in background' : 'skipped (already running or busy)'}`);
}

function start() {
  const cfg = env.routestar.invoiceRefresh;
  if (!cfg.enabled) { log.info('daily invoice line refresh disabled (INVOICE_REFRESH_ENABLED=false)'); return { stop() {} }; }
  const hh = String(cfg.hour).padStart(2, '0');
  const mm = String(cfg.minute).padStart(2, '0');
  const schedule = () => {
    const wait = msUntilNext(cfg.hour, cfg.minute);
    log.info(`next invoice line refresh at ${hh}:${mm} (in ~${Math.round(wait / 60000)} min)`);
    timer = setTimeout(() => { runOnce(); schedule(); }, wait);
    if (timer.unref) timer.unref();
  };
  schedule();
  if (cfg.onStart) { log.info('INVOICE_REFRESH_ON_START set — running an invoice line refresh now'); runOnce(); }
  return { stop: () => { if (timer) clearTimeout(timer); } };
}

module.exports = { start, runOnce };
