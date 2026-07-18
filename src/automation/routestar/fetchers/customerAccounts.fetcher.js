'use strict';
const logger = require('../../../utils/logger');

const log = logger.child('routestar:customer-accounts');
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };
const num = (v) => { const s = clean(v); if (s == null) return null; const n = parseFloat(s.replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; };

async function val(page, sel) {
  return page.$eval(sel, (el) => (el.value != null ? el.value : el.textContent) || '').then((v) => clean(v)).catch(() => null);
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

// Map the header-keyed pricing rows to normalized fields.
function mapPricing(rowObjs) {
  return rowObjs
    .map((o) => ({
      item: clean(o.Item), description: clean(o.Description),
      cost: num(o.Cost), salesPrice: num(o['Sales Price']),
      defaultQty: clean(o['Default Qty']), frequency: clean(o.Frequency),
    }))
    .filter((p) => p.item);
}

async function fetchCustomerAccounts({ session, navigator }, { customers = [], onResult, accumulate = true } = {}) {
  const page = session.page;
  const sel = session.selectors.customerDetail;
  const results = [];

  for (let i = 0; i < customers.length; i++) {
    const c = customers[i];
    const rec = { customerId: c.customerId, customerName: c.customerName || null, detailUrl: navigator.url('customerDetail', c.customerId), status: 'ok', fetchedAt: new Date() };
    try {
      log.info(`[${i + 1}/${customers.length}] ${c.customerName || c.customerId}`);
      await session.withRetry(async () => {
        await navigator.gotoCustomerDetail(c.customerId);
        await page.waitForSelector(sel.accountNumber, { timeout: 30000 });
      }, 'open customer detail');

      rec.accountNumber = await val(page, sel.accountNumber);
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

      try {
        await page.click(sel.pricingTabLink, { timeout: 5000 });
        await page.waitForTimeout(2500);
        await page.waitForSelector(sel.pricingRows, { timeout: 15000 }).catch(() => {});
        rec.pricing = mapPricing(await extractAllRows(page, { holderSel: sel.pricingHolder, headerSel: sel.pricingHeaders, rowSel: sel.pricingRows }));
        log.info(`  account=${rec.accountNumber || '(none)'} pricing rows=${rec.pricing.length}`);
      } catch (e) {
        rec.pricing = [];
        log.warn(`  pricing extract failed: ${e.message}`);
      }

      try {
        await page.click(sel.routesTabLink, { timeout: 5000 });
        await page.waitForTimeout(2500);
        await page.waitForSelector(sel.routeRows, { timeout: 15000 }).catch(() => {});
        rec.routes = await extractAllRows(page, { holderSel: sel.routesHolder, headerSel: sel.routeHeaders, rowSel: sel.routeRows });
        log.info(`  route rows=${rec.routes.length}`);
      } catch (e) {
        rec.routes = [];
        log.warn(`  routes extract failed: ${e.message}`);
      }
    } catch (e) {
      rec.status = 'error';
      rec.error = e.message;
      log.warn(`  failed: ${e.message}`);
    }
    results.push(accumulate ? rec : rec.customerId);
    if (onResult) { try { await onResult(rec); } catch (e) { log.warn(`onResult error: ${e.message}`); } }
  }
  return accumulate ? results : { processed: results.length };
}

module.exports = { fetchCustomerAccounts };
