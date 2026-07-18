'use strict';
const fs = require('fs');
const path = require('path');
const { RouteStarService } = require('../src/automation/routestar');

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }));
  const maxPages = args.pages ? parseInt(args.pages, 10) : 1;
  const svc = new RouteStarService();
  try {
    const rows = await svc.fetchClosedInvoices({ maxPages });
    const outFile = args.out || path.resolve(process.cwd(), `closed-invoices-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
    console.log(`\nextracted ${rows.length} closed invoices (${maxPages} page(s)) -> ${outFile}`);
    if (rows[0]) console.log('sample row:\n', JSON.stringify(rows[0], null, 2));
  } catch (e) {
    console.error('\nclosed-invoices fetch failed:', e.message);
    process.exitCode = 1;
  } finally {
    await svc.close();
  }
})();
