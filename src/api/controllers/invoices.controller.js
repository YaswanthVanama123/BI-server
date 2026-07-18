'use strict';
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const LIMIT = 2000;

async function closedInvoices(req, res) {
  const db = getSourceDb();
  const filter = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };
  const [docs, total] = await Promise.all([
    db.collection('routestarinvoices').find(filter).sort({ invoiceDate: -1 }).limit(LIMIT).toArray(),
    db.collection('routestarinvoices').countDocuments(filter),
  ]);
  const data = docs.map((d) => ({
    invoiceNumber: d.invoiceNumber,
    invoiceDate: d.invoiceDate,
    dateCompleted: d.dateCompleted,
    customer: (d.customer && d.customer.name) || '',
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
    lineItemCount: Array.isArray(d.lineItems) ? d.lineItems.length : 0,
  }));
  res.json(buildEnvelope(data, {
    meta: { source: 'inventory_db', returned: data.length, total, truncated: total > LIMIT },
    page: { page: 1, pageSize: data.length, total },
  }));
}

async function invoiceDetail(req, res) {
  const db = getSourceDb();
  const d = await db.collection('routestarinvoices').findOne({ invoiceNumber: req.params.invoiceNumber });
  if (!d) { const e = new Error(`Invoice ${req.params.invoiceNumber} not found`); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  const cust = d.customer || {};
  const det = d.invoiceDetails || {};
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
      class: clean(li.class) || null,
      warehouse: clean(li.warehouse) || null,
      taxCode: clean(li.taxCode) || null,
      location: clean(li.location) || null,
      sku: clean(li.sku) || null,
    })),
  }, { meta: { source: 'inventory_db' } }));
}

module.exports = { closedInvoices, invoiceDetail };
