'use strict';

const { connectDatabase, getSourceDb, disconnectDatabase } = require('../src/config/database');
const { filterDayKey } = require('../src/api/lib/checkoutDate');
const { linesCents, netCents, grossCents, effectiveLines } = require('../src/api/lib/invoiceMoney');
const { snapshotMap } = require('../src/services/invoiceSnapshots');

const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const routeOf = (v) => (String(v || '').trim() ? String(v).trim().toUpperCase() : '(UNASSIGNED)');
const bound = (dk, days) => { const d = new Date(`${dk}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d; };

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const today = new Date().toISOString().slice(0, 10);
  const from = args.from || `${today.slice(0, 4)}-01-01`;
  const to = args.to || today;
  const route = args.route ? String(args.route).toUpperCase() : null;
  const named = String(args.invoices || 'NRV10671,NRV8139,NRV8965,NRV9418,NRV8969').split(',').map((s) => s.trim()).filter(Boolean);

  await connectDatabase();
  const coll = getSourceDb().collection('routestarinvoices');
  const docs = (await coll.find(
    { $and: [CLOSED, { dateCompleted: { $gte: bound(from, -2), $lte: bound(to, 2) } }] },
    { projection: { _id: 0, invoiceNumber: 1, assignedTo: 1, dateCompleted: 1, arrivalTime: 1, departureTime: 1, subtotal: 1, tax: 1, total: 1, lineItems: 1 } },
  ).toArray()).filter((d) => { const dk = filterDayKey(d); return dk && dk >= from && dk <= to && (!route || routeOf(d.assignedTo) === route); });
  const snaps = await snapshotMap();

  let net = 0; let stored = 0; let effective = 0; let gross = 0; let zero = 0; let staleStored = 0; let staleEffective = 0;
  for (const d of docs) {
    const n = netCents(d);
    const eff = linesCents(effectiveLines(d, snaps.get(d.invoiceNumber)).lines);
    net += n; gross += grossCents(d); stored += linesCents(d.lineItems); effective += eff;
    if (n === 0) zero += 1;
    if (linesCents(d.lineItems) !== n) staleStored += 1;
    if (eff !== n) staleEffective += 1;
  }
  console.log(`\nClosed invoices ${from} → ${to}${route ? ` on ${route}` : ''}: ${docs.length} (${zero} at $0, all counted as stops)`);
  console.log(`  BI revenue (net, invoice subtotal before tax) : ${usd(net)}`);
  console.log(`  billed incl. tax                              : ${usd(gross)}  (tax ${usd(gross - net)})`);
  console.log(`  stored line items (inventory_db)              : ${usd(stored)}  — ${staleStored} invoice(s) don't add up to their subtotal`);
  console.log(`  line items after BI refresh                   : ${usd(effective)}  — ${staleEffective} still don't add up`);

  const found = await coll.find({ invoiceNumber: { $in: named } }, { projection: { _id: 0, invoiceNumber: 1, subtotal: 1, tax: 1, total: 1, lineItems: 1 } }).toArray();
  console.log('\nInvoices from the root-cause report:');
  for (const n of named) {
    const d = found.find((x) => x.invoiceNumber === n);
    if (!d) { console.log(`  ${n}: not found`); continue; }
    const eff = effectiveLines(d, snaps.get(n));
    console.log(`  ${n}: subtotal ${usd(netCents(d))} | stored lines ${usd(linesCents(d.lineItems))} | BI lines ${usd(linesCents(eff.lines))} (${eff.source})`);
  }
  console.log('');
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('verify:revenue failed:', e.message); process.exit(1); });
