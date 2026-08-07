'use strict';
const logger = require('../../../utils/logger');

const log = logger.child('routestar:customer-accounts');
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };
const num = (v) => { const s = clean(v); if (s == null) return null; const n = parseFloat(s.replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; };

async function val(page, sel) {
  return page.$eval(sel, (el) => (el.value != null ? el.value : el.textContent) || '').then((v) => clean(v)).catch(() => null);
}

async function waitForFieldValue(page, sel, timeout = 12000) {
  const start = Date.now();
  let v = await val(page, sel);
  while (!v && Date.now() - start < timeout) {
    await page.waitForTimeout(500);
    v = await val(page, sel);
  }
  return v;
}

async function readVisibleRows(page, headerSel, rowSel) {
  const headers = await page.$$eval(headerSel, (ths) => ths.map((th) => th.textContent.replace(/▼/g, '').trim())).catch(() => []);
  const rows = await page.$$eval(rowSel, (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.replace(/▼/g, '').trim()))).catch(() => []);
  return { headers, rows };
}

async function extractAllRows(page, { holderSel, headerSel, rowSel }) {
  const map = new Map();
  let cols = null;
  const collect = async () => {
    const { headers, rows } = await readVisibleRows(page, headerSel, rowSel);
    if (!cols && headers.length) cols = headers[0] === '' ? headers.slice(1) : headers;
    for (const cells of rows) {
      if (!cells.length || cells.every((v) => !v || v === 'Choose..')) continue;
      map.set(cells.join('||'), cells);
    }
  };

  const holder = await page.$(holderSel);
  if (!holder) {
    await collect();
  } else {
    await holder.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(250);
    let sh = await holder.evaluate((el) => el.scrollHeight);
    const ch = await holder.evaluate((el) => el.clientHeight) || 300;
    const step = Math.max(120, ch - 40);
    let pos = 0; let last = -1; let stable = 0;
    for (let guard = 0; guard < 400; guard++) {
      await collect();
      if (map.size === last) { if (++stable >= 3) break; } else { stable = 0; last = map.size; }
      if (pos >= sh) break;
      pos += step;
      await holder.evaluate((el, p) => { el.scrollTop = p; }, pos);
      await page.waitForTimeout(180);
      const grown = await holder.evaluate((el) => el.scrollHeight);
      if (grown > sh) sh = grown;
    }
    await collect();
  }

  const out = [];
  for (const cells of map.values()) {
    const obj = {};
    for (let i = 0; i < cells.length; i++) { const h = (cols && cols[i]) || `col${i}`; obj[h] = cells[i] || null; }
    out.push(obj);
  }
  return out;
}

async function countVisibleRows(page, rowSel) {
  return page.$$eval(rowSel, (trs) => trs.filter((tr) => tr.querySelectorAll('td').length).length).catch(() => -1);
}

async function hasDataRow(page, rowSel) {
  return page.$$eval(rowSel, (trs) => trs.some((tr) => Array.from(tr.querySelectorAll('td')).some((td) => {
    const t = (td.textContent || '').replace(/▼/g, '').trim();
    return t && t !== 'Choose..';
  }))).catch(() => false);
}

async function fetchTab(page, log, { name, tabLink, pane, holderSel, headerSel, rowSel, refreshFn }) {
  const linkEl = await page.$(tabLink).catch(() => null);
  log.info(`  [${name}] tab link ${linkEl ? 'found' : 'NOT FOUND'} (${tabLink})`);
  if (!linkEl) return [];
  try {
    await page.click(tabLink, { timeout: 5000 });
    log.info(`  [${name}] clicked tab`);
  } catch (e) {
    log.warn(`  [${name}] tab click failed (${e.message}) — trying JS click`);
    try { await linkEl.evaluate((el) => el.click()); } catch (e2) { log.warn(`  [${name}] JS click failed: ${e2.message}`); }
  }
  await page.waitForTimeout(800);
  const refreshed = await page.evaluate((fn) => {
    let ok = false;
    if (fn && typeof window[fn] === 'function') { try { window[fn](); ok = true; } catch (e) { void e; } }
    try { window.dispatchEvent(new Event('resize')); } catch (e) { void e; }
    return ok;
  }, refreshFn).catch(() => false);
  if (refreshFn) log.info(`  [${name}] ${refreshFn}() ${refreshed ? 'called' : 'unavailable'} + resize`);
  if (pane) {
    const paneActive = await page.$eval(pane, (el) => el.classList.contains('active') || el.offsetParent !== null).catch(() => false);
    log.info(`  [${name}] pane ${pane} ${paneActive ? 'active/visible' : 'NOT active'}`);
  }
  const start = Date.now();
  let gotData = false;
  while (Date.now() - start < 8000) {
    if (await hasDataRow(page, rowSel)) { gotData = true; break; }
    await page.waitForTimeout(500);
  }
  const rawCount = await countVisibleRows(page, rowSel);
  log.info(`  [${name}] dataRow=${gotData} after ${Date.now() - start}ms; visible data <tr>=${rawCount}`);
  if (rawCount > 0) {
    const sample = await page.$$eval(rowSel, (trs) => {
      const first = trs.find((tr) => tr.querySelectorAll('td').length);
      return first ? Array.from(first.querySelectorAll('td')).map((td) => (td.textContent || '').replace(/▼/g, '').trim()) : [];
    }).catch(() => []);
    log.info(`  [${name}] first row cells: ${JSON.stringify(sample)}`);
  }
  let rows = [];
  try {
    rows = await extractAllRows(page, { holderSel, headerSel, rowSel });
  } catch (e) {
    log.warn(`  [${name}] extractAllRows threw: ${e.message}`);
  }
  log.info(`  [${name}] extracted ${rows.length} unique row object(s)`);
  return rows;
}

function mapPricing(rowObjs) {
  return rowObjs
    .map((o) => ({
      item: clean(o.Item), description: clean(o.Description),
      cost: num(o.Cost), salesPrice: num(o['Sales Price']),
      defaultQty: clean(o['Default Qty']), frequency: clean(o.Frequency),
    }))
    .filter((p) => p.item);
}

function mapActivity(rowObjs) {
  return rowObjs
    .map((o) => {
      const txn = clean(o['Txn #']);
      return {
        txn: txn && txn !== '-n/a-' ? txn : null,
        type: clean(o.Type),
        message: clean(o.Message),
        timestamp: clean(o['Time Stamp']),
        user: clean(o.User),
      };
    })
    .filter((a) => a.type || a.message || a.timestamp);
}

async function fetchCustomerAccounts({ session, navigator }, { customers = [], onResult, accumulate = true } = {}) {
  const page = session.page;
  const sel = session.selectors.customerDetail;
  const results = [];

  for (let i = 0; i < customers.length; i++) {
    const c = customers[i];
    const rec = { customerId: c.customerId, customerName: c.customerName || null, detailUrl: navigator.url('customerDetail', c.customerId), status: 'ok', fetchedAt: new Date() };
    try {
      log.info(`[${i + 1}/${customers.length}] ${c.customerName || c.customerId} (id=${c.customerId})`);
      await session.withRetry(async () => {
        await navigator.gotoCustomerDetail(c.customerId);
        await page.waitForSelector(sel.accountNumber, { timeout: 30000 });
      }, 'open customer detail');

      const acctFieldFound = await page.$(sel.accountNumber).then((el) => !!el).catch(() => false);
      rec.accountNumber = await waitForFieldValue(page, sel.accountNumber, 12000);
      log.info(`  loaded detail url=${page.url()} · accountField=${acctFieldFound ? 'yes' : 'NO'} · account=${rec.accountNumber || '(none)'}`);

      rec.company = await val(page, sel.company);
      rec.serviceAddress1 = await val(page, sel.serviceAddress1);
      rec.serviceAddress2 = await val(page, sel.serviceAddress2);
      rec.serviceAddress3 = await val(page, sel.serviceAddress3);
      rec.serviceCity = await val(page, sel.serviceCity);
      rec.serviceState = await val(page, sel.serviceState);
      rec.serviceZip = await val(page, sel.serviceZip);
      rec.latitude = num(await val(page, sel.latitude));
      rec.longitude = num(await val(page, sel.longitude));
      rec.zone = await val(page, sel.zone);
      if (!rec.accountNumber) rec.status = 'no_account';

      rec.pricing = mapPricing(await fetchTab(page, log, { name: 'pricing', tabLink: sel.pricingTabLink, pane: sel.pricingPane, holderSel: sel.pricingHolder, headerSel: sel.pricingHeaders, rowSel: sel.pricingRows, refreshFn: 'refresh_PricingGrid' }));
      rec.routes = await fetchTab(page, log, { name: 'routes', tabLink: sel.routesTabLink, pane: sel.routesPane, holderSel: sel.routesHolder, headerSel: sel.routeHeaders, rowSel: sel.routeRows, refreshFn: 'refresh_RouteGrid' });
      rec.activity = mapActivity(await fetchTab(page, log, { name: 'activity', tabLink: sel.activityTabLink, pane: sel.activityPane, holderSel: sel.activityHolder, headerSel: sel.activityHeaders, rowSel: sel.activityRows, refreshFn: 'refresh_ActivityGrid' }));
      log.info(`  => STORED account=${rec.accountNumber || '(none)'} pricing=${rec.pricing.length} routes=${rec.routes.length} activity=${rec.activity.length} status=${rec.status}`);
    } catch (e) {
      rec.status = 'error';
      rec.error = e.message;
      rec.pricing = rec.pricing || [];
      rec.routes = rec.routes || [];
      rec.activity = rec.activity || [];
      log.warn(`  FAILED ${c.customerId}: ${e.message}`);
    }
    results.push(accumulate ? rec : rec.customerId);
    if (onResult) { try { await onResult(rec); } catch (e) { log.warn(`onResult error: ${e.message}`); } }
  }
  return accumulate ? results : { processed: results.length };
}

module.exports = { fetchCustomerAccounts };
