'use strict';

async function revealAllColumns(page) {
  try {
    await page.evaluate(() => { if (typeof window.showAllHidden === 'function') window.showAllHidden(); });
    await page.waitForTimeout(1500);
  } catch (e) {}
}

async function extractPage(page) {
  return page.evaluate(() => {
    const master = document.querySelector('div.ht_master');
    if (!master) return [];
    const headerThs = Array.from(master.querySelectorAll('table.htCore thead tr th'));
    const colIndex = {};
    headerThs.forEach((th, i) => {
      const label = (th.textContent || '').trim().toLowerCase();
      if (label) colIndex[label] = i - 1;
    });
    const createdIdx = colIndex.created;
    const rows = Array.from(master.querySelectorAll('table.htCore tbody tr'));
    const out = [];
    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (!tds.length) continue;
      const link = tr.querySelector('a[href*="customerdetail/"]');
      let customerId = null;
      if (link && link.href) {
        const m = link.href.match(/customerdetail\/([^/?#]+)/);
        if (m) customerId = decodeURIComponent(m[1]);
      }
      if (!customerId) continue;
      const created = (createdIdx != null && tds[createdIdx]) ? (tds[createdIdx].textContent || '').trim() : '';
      out.push({ customerId, created: created || null });
    }
    return out;
  });
}

async function currentPageNo(page) {
  return page.evaluate(() => {
    const active = document.querySelector('.pagination li.active');
    if (!active) return null;
    const lp = active.getAttribute('data-lp');
    const n = parseInt(lp || (active.textContent || '').trim(), 10);
    return Number.isNaN(n) ? null : n;
  });
}

async function maxVisiblePage(page) {
  return page.evaluate(() => {
    let max = 0;
    document.querySelectorAll('.pagination li:not(.prev):not(.next)').forEach((li) => {
      const n = parseInt(li.getAttribute('data-lp') || (li.textContent || '').trim(), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    });
    return max;
  });
}

async function clickPageLink(page, target, dataSettleMs) {
  const link = await page.$(`.pagination li[data-lp="${target}"]:not(.prev):not(.next) a, .pagination li[data-lp="${target}"]:not(.prev):not(.next)`);
  if (!link) return false;
  try { await link.click({ timeout: 5000 }); } catch (e) { await link.evaluate((el) => el.click()); }
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    if ((await currentPageNo(page)) === target) { await page.waitForTimeout(dataSettleMs); return true; }
  }
  return false;
}

async function gotoPage(page, target, dataSettleMs) {
  if ((await currentPageNo(page)) === target) return true;
  for (let guard = 0; guard < 80; guard++) {
    if (await clickPageLink(page, target, dataSettleMs)) return true;
    const nextSet = await page.$('.pagination li.next');
    if (!nextSet) return false;
    const disabled = await nextSet.evaluate((el) => el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true');
    if (disabled) return false;
    const beforeMax = await maxVisiblePage(page);
    const a = (await nextSet.$('a')) || nextSet;
    try { await a.scrollIntoViewIfNeeded(); } catch (e) {}
    try { await a.click({ timeout: 5000 }); } catch (e) { await a.evaluate((el) => el.click()); }
    let advanced = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      if ((await maxVisiblePage(page)) > beforeMax) { advanced = true; break; }
    }
    if (!advanced) return false;
    await page.waitForTimeout(dataSettleMs);
  }
  return false;
}

async function fetchCustomerCreatedDates({ session, navigator }, { onPage, maxPages = 1000 } = {}) {
  await navigator.openCustomers();
  await revealAllColumns(session.page);
  const dataSettleMs = (session.config && session.config.grid && session.config.grid.dataSettleMs) || 2000;

  const all = [];
  const seen = new Set();
  let pageNo = 1;
  while (pageNo <= maxPages) {
    const rows = await extractPage(session.page);
    const fresh = [];
    for (const r of rows) {
      if (!r.customerId || seen.has(r.customerId)) continue;
      seen.add(r.customerId);
      fresh.push(r);
      all.push(r);
    }
    if (onPage && fresh.length) await onPage(fresh, pageNo);
    const advanced = await gotoPage(session.page, pageNo + 1, dataSettleMs);
    if (!advanced) break;
    pageNo += 1;
  }
  return all;
}

module.exports = { fetchCustomerCreatedDates };
