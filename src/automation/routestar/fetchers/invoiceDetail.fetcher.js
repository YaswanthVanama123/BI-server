'use strict';
const selectors = require('../selectors');

const sel = selectors.invoiceDetail;
const money = (s) => {
  const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

async function dismissModals(page) {
  try {
    const open = await page.$('.modal.show, .modal.in');
    if (open) { await page.keyboard.press('Escape'); await page.waitForTimeout(500); }
  } catch (e) { void e; }
}

async function openLineItems(page) {
  await dismissModals(page);
  const tab = await page.$(sel.lineItemsTab);
  if (tab) {
    try { await tab.click(); } catch (e) { await tab.evaluate((el) => el.click()); }
    await page.waitForTimeout(1500);
  }
  await page.waitForSelector(`${sel.itemsTable} table.htCore`, { timeout: 30000 });
  await page.waitForTimeout(1500);
}

async function extract(page) {
  return page.evaluate((s) => {
    const fieldValue = (q) => {
      const el = document.querySelector(q);
      if (!el) return '';
      return (el.value != null && el.value !== '') ? el.value : (el.textContent || '');
    };
    const rows = Array.from(document.querySelectorAll(`${s.itemsTable} table.htCore tbody tr`));
    const items = [];
    for (const tr of rows) {
      const td = (n) => {
        const c = tr.querySelector(`td:nth-of-type(${n})`);
        return c ? (c.textContent || '').replace('▼', '').trim() : '';
      };
      const name = td(1);
      if (!name || name === 'Choose..') continue;
      items.push({ name, description: td(2), quantity: td(3), rate: td(4), amount: td(5), class: td(6), warehouse: td(7), taxCode: td(8), location: td(9) });
    }
    return { items, subtotal: fieldValue(s.subtotal), tax: fieldValue(s.tax), total: fieldValue(s.total) };
  }, sel);
}

async function fetchInvoiceDetail({ session, navigator }, { invoiceNumber, detailUrl } = {}) {
  if (detailUrl) await session.goto(session.absoluteUrl(detailUrl));
  else await navigator.gotoInvoiceDetail(invoiceNumber);
  await session.page.waitForTimeout(2000);
  await openLineItems(session.page);
  const raw = await extract(session.page);
  return {
    invoiceNumber,
    subtotal: money(raw.subtotal),
    tax: money(raw.tax),
    total: money(raw.total),
    items: raw.items.map((it) => ({
      name: it.name,
      description: it.description,
      quantity: money(it.quantity),
      rate: money(it.rate),
      amount: money(it.amount),
      class: it.class,
      warehouse: it.warehouse,
      taxCode: it.taxCode,
      location: it.location,
    })),
  };
}

module.exports = { fetchInvoiceDetail };
