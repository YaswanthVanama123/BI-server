'use strict';
const { connectDatabase, disconnectDatabase, getSourceDb } = require('../src/config/database');
const { models } = require('../src/models');
const { frequencyFor } = require('../src/services/pricingMatch');

const { CustomerAccount, InvoiceFrequency } = models;
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const customerIdFromLink = (link) => { const m = String(link || '').match(/customerdetail\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]) : null; };
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const all = !!args.all;
  const limit = args.limit ? Number(args.limit) : 0;
  await connectDatabase();
  const src = getSourceDb();

  const accts = await CustomerAccount.find({}, { customerId: 1, pricing: 1 }).lean();
  const pricingByCust = new Map(accts.map((a) => [a.customerId, a.pricing || []]));

  const done = all ? new Set() : new Set((await InvoiceFrequency.find({}, { invoiceNumber: 1 }).lean()).map((d) => d.invoiceNumber));

  const cursor = src.collection('routestarinvoices').find(CLOSED, { projection: { invoiceNumber: 1, customer: 1, lineItems: 1 } });
  let processed = 0; let stored = 0; let matched = 0; let ops = [];
  for await (const d of cursor) {
    if (!d.invoiceNumber || done.has(d.invoiceNumber)) continue;
    if (limit && processed >= limit) break;
    const cid = customerIdFromLink(d.customer && d.customer.link);
    const pricing = (cid && pricingByCust.get(cid)) || [];
    const lines = (Array.isArray(d.lineItems) ? d.lineItems : []).map((li) => {
      const f = frequencyFor(li, pricing);
      if (f) matched += 1;
      return { item: clean(li.name) || '', description: clean(li.description) || '', rate: Number(li.rate || 0), amount: Number(li.amount || 0), frequency: f || null };
    });
    ops.push({ updateOne: { filter: { invoiceNumber: d.invoiceNumber }, update: { $set: { invoiceNumber: d.invoiceNumber, customerId: cid, customer: (d.customer && d.customer.name) || null, lines, matchedAt: new Date() } }, upsert: true } });
    processed += 1;
    if (ops.length >= 1000) { await InvoiceFrequency.bulkWrite(ops, { ordered: false }); stored += ops.length; ops = []; }
  }
  if (ops.length) { await InvoiceFrequency.bulkWrite(ops, { ordered: false }); stored += ops.length; }

  console.log(`enriched ${stored} invoice(s) (${matched} line-item frequencies matched)${all ? ' [--all]' : ' [new only]'}`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('enrich:frequencies failed:', e.message); process.exit(1); });
