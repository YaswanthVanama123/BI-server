'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { findStale, lineHealth, refreshInvoices } = require('../src/services/routestar/invoiceRefresh');

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  await connectDatabase();
  const health = await lineHealth();
  console.log(`closed invoices: ${health.invoices} | lines ≠ subtotal: ${health.mismatched} (net ${health.mismatchAmount.toFixed(2)}) | refreshed so far: ${health.refreshed} | waiting: ${health.pending}`);

  if (args['dry-run']) {
    const stale = await findStale({ all: !!args.all, limit: args.limit ? Number(args.limit) : undefined });
    console.log(`would refresh ${stale.length} invoice(s):`);
    for (const s of stale.slice(0, 25)) console.log(`  ${s.invoiceNumber}  subtotal ${s.sourceSubtotal.toFixed(2)}  stored lines ${s.sourceLinesTotal.toFixed(2)}  (${s.reason})`);
  } else {
    let last = 0;
    const r = await refreshInvoices({
      all: !!args.all,
      limit: args.limit ? Number(args.limit) : undefined,
      onProgress: (p) => { if (p.refreshed + p.failed - last >= 10 || p.refreshed + p.failed === p.total) { last = p.refreshed + p.failed; console.log(`  ${last}/${p.total} processed (${p.fixed} now match, ${p.failed} failed)`); } },
    });
    console.log(`done: ${r.refreshed}/${r.total} refreshed, ${r.fixed} now match their subtotal, ${r.failed} failed.`);
  }
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('refresh:invoices failed:', e.message); process.exit(1); });
