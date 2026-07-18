'use strict';
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };

const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
function customerIdFromLink(link) { const m = String(link || '').match(/customerdetail\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]) : null; }
function bucketKey(dk, g) {
  if (!dk) return null;
  if (g === 'day') return dk;
  if (g === 'week') { const d = new Date(`${dk}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
  return dk.slice(0, 7);
}
function categoryOf(li) {
  const name = clean(li.name) || '';
  if (name.includes(':')) return name.split(':')[0].trim();
  return name || clean(li.class) || 'Uncategorized';
}

// Load closed invoices for the range (+ customer route join, optional route filter). withLines pulls
// the embedded line items (needed only for the by-category breakdown).
async function loadInvoices(req, { withLines = false } = {}) {
  const db = getSourceDb();
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const routeCode = clean(req.query.routeCode);

  const and = [CLOSED];
  if (from || to) {
    const start = new Date(`${from || to}T00:00:00.000Z`);
    const end = new Date(`${to || from}T23:59:59.999Z`);
    and.push({ $or: [{ dateCompleted: { $gte: start, $lte: end } }, { invoiceDate: { $gte: start, $lte: end } }] });
  }
  const projection = { invoiceNumber: 1, customer: 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, total: 1, subtotal: 1 };
  if (withLines) projection.lineItems = 1;
  const docs = await db.collection('routestarinvoices').find({ $and: and }, { projection }).limit(50000).toArray();

  const custIds = [...new Set(docs.map((i) => customerIdFromLink(i.customer && i.customer.link)).filter(Boolean))];
  const custs = await db.collection('routestarcustomers')
    .find({ customerId: { $in: custIds } }, { projection: { customerId: 1, onRoute: 1 } }).toArray();
  const routeByCust = new Map(custs.map((c) => [c.customerId, (clean(c.onRoute) ? String(c.onRoute).trim().toUpperCase() : null)]));

  const out = [];
  for (const d of docs) {
    const cid = customerIdFromLink(d.customer && d.customer.link);
    const rc = (cid && routeByCust.get(cid)) || '(no route)';
    if (routeCode && rc !== routeCode) continue;
    out.push({
      invoiceNumber: d.invoiceNumber,
      customerId: cid || '(unknown)',
      customerName: (d.customer && d.customer.name) || '(unknown)',
      routeCode: rc,
      dateKey: dayKey(d.dateCompleted || d.invoiceDate),
      total: Number(d.total || 0),
      subtotal: Number(d.subtotal || 0),
      lineItems: withLines && Array.isArray(d.lineItems) ? d.lineItems : undefined,
    });
  }
  return { invoices: out, from, to, routeCode };
}

// GET /revenue/by-category — line-item revenue grouped by item category (name prefix / class).
async function byCategory(req, res) {
  const { invoices, from, to, routeCode } = await loadInvoices(req, { withLines: true });
  const cat = new Map();
  let totalRevenue = 0; let totalLines = 0;
  for (const inv of invoices) {
    for (const li of inv.lineItems || []) {
      const amount = Number(li.amount || 0);
      if (!amount) continue;
      const c = categoryOf(li);
      const o = cat.get(c) || { category: c, revenue: 0, lines: 0 };
      o.revenue += amount; o.lines += 1; cat.set(c, o);
      totalRevenue += amount; totalLines += 1;
    }
  }
  const rows = [...cat.values()].map((o) => ({
    category: o.category, revenue: round(o.revenue), lines: o.lines,
    pct: totalRevenue ? round((o.revenue / totalRevenue) * 100, 1) : 0,
  })).sort((a, b) => b.revenue - a.revenue);
  const kpis = {
    revenue: round(totalRevenue), categories: rows.length, lines: totalLines,
    topCategory: rows[0] ? rows[0].category : null,
    invoices: invoices.length,
  };
  res.json(buildEnvelope({ kpis, rows }, { meta: { source: 'inventory_db', note: 'line-item (pre-tax) revenue', from: from || null, to: to || null, routeCode: routeCode || null } }));
}

// GET /revenue/by-route — invoice revenue grouped by the customer's route.
async function byRoute(req, res) {
  const { invoices, from, to, routeCode } = await loadInvoices(req);
  const map = new Map();
  let totalRevenue = 0;
  for (const inv of invoices) {
    const o = map.get(inv.routeCode) || { routeCode: inv.routeCode, revenue: 0, stops: 0 };
    o.revenue += inv.total; o.stops += 1; map.set(inv.routeCode, o);
    totalRevenue += inv.total;
  }
  const rows = [...map.values()].map((o) => ({
    routeCode: o.routeCode, revenue: round(o.revenue), stops: o.stops,
    revenuePerStop: o.stops ? round(o.revenue / o.stops, 2) : 0,
    pct: totalRevenue ? round((o.revenue / totalRevenue) * 100, 1) : 0,
  })).sort((a, b) => b.revenue - a.revenue);
  const kpis = {
    revenue: round(totalRevenue), routes: rows.length, stops: invoices.length,
    revenuePerStop: invoices.length ? round(totalRevenue / invoices.length, 2) : 0,
    topRoute: rows[0] ? rows[0].routeCode : null,
  };
  res.json(buildEnvelope({ kpis, rows }, { meta: { source: 'inventory_db', from: from || null, to: to || null, routeCode: routeCode || null } }));
}

// GET /revenue/by-customer — invoice revenue grouped by customer.
async function byCustomer(req, res) {
  const { invoices, from, to, routeCode } = await loadInvoices(req);
  const map = new Map();
  let totalRevenue = 0;
  for (const inv of invoices) {
    const o = map.get(inv.customerId) || { customerId: inv.customerId, customer: inv.customerName, routeCode: inv.routeCode, revenue: 0, stops: 0 };
    o.revenue += inv.total; o.stops += 1; map.set(inv.customerId, o);
    totalRevenue += inv.total;
  }
  const rows = [...map.values()].map((o) => ({
    customer: o.customer, routeCode: o.routeCode, revenue: round(o.revenue), stops: o.stops,
    avgPerStop: o.stops ? round(o.revenue / o.stops, 2) : 0,
    pct: totalRevenue ? round((o.revenue / totalRevenue) * 100, 1) : 0,
  })).sort((a, b) => b.revenue - a.revenue);
  const kpis = {
    revenue: round(totalRevenue), customers: rows.length, stops: invoices.length,
    avgPerCustomer: rows.length ? round(totalRevenue / rows.length, 2) : 0,
    topCustomer: rows[0] ? rows[0].customer : null,
  };
  res.json(buildEnvelope({ kpis, rows }, { meta: { source: 'inventory_db', from: from || null, to: to || null, routeCode: routeCode || null } }));
}

// GET /revenue/per-stop — revenue per stop over time (granularity) + by route.
async function perStop(req, res) {
  const { invoices, from, to, routeCode } = await loadInvoices(req);
  const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'month';
  const bucket = new Map(); const route = new Map();
  let totalRevenue = 0;
  for (const inv of invoices) {
    totalRevenue += inv.total;
    const b = bucketKey(inv.dateKey, granularity);
    const ob = bucket.get(b) || { bucket: b, revenue: 0, stops: 0 };
    ob.revenue += inv.total; ob.stops += 1; bucket.set(b, ob);
    const or = route.get(inv.routeCode) || { routeCode: inv.routeCode, revenue: 0, stops: 0 };
    or.revenue += inv.total; or.stops += 1; route.set(inv.routeCode, or);
  }
  const series = [...bucket.values()].map((o) => ({
    bucket: o.bucket, revenue: round(o.revenue), stops: o.stops, revenuePerStop: o.stops ? round(o.revenue / o.stops, 2) : 0,
  })).sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  const byRoute = [...route.values()].map((o) => ({
    routeCode: o.routeCode, revenue: round(o.revenue), stops: o.stops, revenuePerStop: o.stops ? round(o.revenue / o.stops, 2) : 0,
  })).sort((a, b) => b.revenuePerStop - a.revenuePerStop);
  const kpis = {
    revenue: round(totalRevenue), stops: invoices.length,
    revenuePerStop: invoices.length ? round(totalRevenue / invoices.length, 2) : 0,
    routes: byRoute.length,
  };
  res.json(buildEnvelope({ kpis, series, byRoute }, { meta: { source: 'inventory_db', from: from || null, to: to || null, routeCode: routeCode || null, granularity } }));
}

module.exports = { byCategory, byRoute, byCustomer, perStop };
