'use strict';
const { buildEnvelope } = require('../lib/envelope');
const { getPaging, pageMeta } = require('../lib/pagination');
const { getSourceDb } = require('../../config/database');
const { models } = require('../../models');
const { frequencyFor } = require('../../services/pricingMatch');

const { CustomerAccount, InvoiceFrequency } = models;
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const customerIdFromLink = (link) => { const m = String(link || '').match(/customerdetail\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]) : null; };

const TTL_MS = 300000;
function makeCache() {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (e && Date.now() - e.at < TTL_MS) return e.v; if (e) m.delete(k); return null; },
    set(k, v) { m.set(k, { at: Date.now(), v }); if (m.size > 300) m.delete(m.keys().next().value); },
  };
}
const payloadCache = makeCache();

const PROJECTION = {
  $project: {
    _id: 0, invoiceNumber: 1, invoiceDate: 1, dateCompleted: 1,
    customerName: '$customer.name', assignedTo: 1, invoiceType: 1, status: 1,
    customerGrouping: 1, arrivalTime: 1, departureTime: 1, elapsedTime: 1,
    subtotal: 1, total: 1, isComplete: 1, isPosted: 1,
    lineItemCount: { $size: { $ifNull: ['$lineItems', []] } },
  },
};

async function loadClosedInvoices(query) {
  const db = getSourceDb();
  const and = [{ $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] }];

  const from = clean(query.from);
  const to = clean(query.to);
  if (from || to) {
    const start = new Date(`${from || to}T00:00:00.000Z`);
    const end = new Date(`${to || from}T23:59:59.999Z`);
    and.push({ $or: [{ dateCompleted: { $gte: start, $lte: end } }, { invoiceDate: { $gte: start, $lte: end } }] });
  }
  const rc = clean(query.routeCode);
  if (rc && rc.toLowerCase() !== 'all') and.push({ assignedTo: new RegExp(`^${escapeRegex(rc)}$`, 'i') });
  const term = clean(query.q);
  if (term) {
    const rx = new RegExp(escapeRegex(term), 'i');
    and.push({ $or: [{ 'customer.name': rx }, { invoiceNumber: rx }] });
  }
  const filter = { $and: and };

  const paging = getPaging(query, { defaultPageSize: 50, maxPageSize: 200 });
  const coll = db.collection('routestarinvoices');
  const total = await coll.countDocuments(filter);
  const docs = await coll.aggregate([
    { $match: filter },
    { $sort: { invoiceDate: -1 } },
    { $skip: paging.skip },
    { $limit: paging.all ? Math.max(Math.min(total, paging.limit), 1) : paging.limit },
    PROJECTION,
  ]).toArray();

  const data = docs.map((d) => ({
    invoiceNumber: d.invoiceNumber,
    invoiceDate: d.invoiceDate,
    dateCompleted: d.dateCompleted,
    customer: d.customerName || '',
    assignedTo: clean(d.assignedTo) || null,
    invoiceType: clean(d.invoiceType) || null,
    status: clean(d.status) || null,
    customerGrouping: clean(d.customerGrouping) || null,
    arrivalTime: clean(d.arrivalTime) || null,
    departureTime: clean(d.departureTime) || null,
    elapsedTime: clean(d.elapsedTime) || null,
    subtotal: Number(d.subtotal || 0),
    total: Number(d.total || 0),
    isComplete: !!d.isComplete,
    isPosted: !!d.isPosted,
    lineItemCount: d.lineItemCount || 0,
  }));

  return buildEnvelope(data, {
    meta: { source: 'inventory_db', returned: data.length, total },
    page: pageMeta(total, paging, data.length),
  });
}

async function closedInvoices(req, res) {
  const q = req.query || {};
  const key = `inv|${clean(q.from) || ''}|${clean(q.to) || ''}|${clean(q.routeCode) || ''}|${clean(q.q) || ''}|${q.page || ''}|${q.pageSize || ''}`;
  const cached = payloadCache.get(key);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const payload = await loadClosedInvoices(q);
  payloadCache.set(key, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

async function warm() {
  try {
    const d = new Date();
    const year = `${d.getFullYear()}-01-01`;
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const combos = [
      {},
      { page: '1', pageSize: '25' },
      { from: year, to: today, page: '1', pageSize: '25' },
    ];
    for (const q of combos) {
      try {
        const key = `inv|${clean(q.from) || ''}|${clean(q.to) || ''}|${clean(q.routeCode) || ''}|${clean(q.q) || ''}|${q.page || ''}|${q.pageSize || ''}`;
        payloadCache.set(key, await loadClosedInvoices(q));
      } catch (e) { /* db not ready */ }
    }
  } catch (e) { /* ignore */ }
}

function startWarmer() {
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, TTL_MS - 30000);
}

async function invoiceDetail(req, res) {
  const db = getSourceDb();
  const d = await db.collection('routestarinvoices').findOne({ invoiceNumber: req.params.invoiceNumber });
  if (!d) { const e = new Error(`Invoice ${req.params.invoiceNumber} not found`); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  const cust = d.customer || {};
  const det = d.invoiceDetails || {};

  const cid = customerIdFromLink(cust.link);
  const [stored, acct] = await Promise.all([
    InvoiceFrequency.findOne({ invoiceNumber: d.invoiceNumber }).lean(),
    cid ? CustomerAccount.findOne({ customerId: cid }, { pricing: 1 }).lean() : null,
  ]);
  const pricing = (acct && acct.pricing) || [];
  const storedByKey = new Map((stored && stored.lines ? stored.lines : []).map((l) => [`${l.item}||${l.rate}`, l.frequency]));
  const freqFor = (li) => {
    const k = `${clean(li.name) || ''}||${Number(li.rate || 0)}`;
    if (storedByKey.has(k)) return storedByKey.get(k) || null;
    return frequencyFor(li, pricing);
  };

  res.json(buildEnvelope({
    invoiceNumber: d.invoiceNumber,
    invoiceDate: d.invoiceDate,
    dateCompleted: d.dateCompleted,
    lastModified: d.lastModified,
    customer: cust.name || '',
    customerEmail: clean(cust.email) || null,
    customerPhone: clean(cust.phone) || null,
    assignedTo: clean(d.assignedTo) || null,
    enteredBy: clean(d.enteredBy) || null,
    invoiceType: clean(d.invoiceType) || null,
    status: clean(d.status) || null,
    customerGrouping: clean(d.customerGrouping) || null,
    arrivalTime: clean(d.arrivalTime) || null,
    departureTime: clean(d.departureTime) || null,
    elapsedTime: clean(d.elapsedTime) || null,
    subtotal: Number(d.subtotal || 0),
    tax: Number(d.tax || 0),
    total: Number(d.total || 0),
    serviceNotes: clean(d.serviceNotes) || clean(det.serviceNotes) || null,
    signedBy: clean(det.signedBy) || null,
    memo: clean(det.invoiceMemo) || null,
    lineItems: (Array.isArray(d.lineItems) ? d.lineItems : []).map((li) => ({
      name: clean(li.name) || '',
      description: clean(li.description) || '',
      quantity: Number(li.quantity || 0),
      rate: Number(li.rate || 0),
      amount: Number(li.amount || 0),
      frequency: freqFor(li),
      class: clean(li.class) || null,
      warehouse: clean(li.warehouse) || null,
      taxCode: clean(li.taxCode) || null,
      location: clean(li.location) || null,
      sku: clean(li.sku) || null,
    })),
  }, { meta: { source: 'inventory_db' } }));
}

module.exports = { closedInvoices, invoiceDetail, warm, startWarmer };
