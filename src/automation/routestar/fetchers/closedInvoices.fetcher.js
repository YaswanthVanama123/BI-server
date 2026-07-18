'use strict';
const { MAPPING, toRawPayload } = require('../parsers/closedInvoices.parser');

async function fetchClosedInvoices({ session, navigator }, opts = {}) {
  const maxPages = opts.maxPages || Infinity;
  await session.withRetry(() => navigator.openClosedInvoices(), 'openClosedInvoices');

  const all = [];
  const seen = new Set();
  let pageNum = 0;
  while (pageNum < maxPages) {
    const rows = await session.extractGridRows(MAPPING);
    let newOnPage = 0;
    for (const r of rows) {
      const key = r.invoiceNumber || `${r.customerName}|${r.invoiceDate}|${r.invoiceTotal}`;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      all.push(toRawPayload(r, session));
      newOnPage++;
    }
    session.log.info(`closed-invoices page ${pageNum + 1}: ${rows.length} rows (${newOnPage} new, ${all.length} total)`);
    if (rows.length > 0 && newOnPage === 0) { session.log.info('all rows duplicated — stopping'); break; }
    pageNum++;
    if (pageNum >= maxPages) break;
    const advanced = await navigator.nextPage();
    if (!advanced) break;
  }
  return all;
}

module.exports = { fetchClosedInvoices };
