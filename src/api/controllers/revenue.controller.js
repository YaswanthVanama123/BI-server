'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');
const { itemKey } = require('../../services/pricingMatch');

const { CustomerAccount } = models;
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const customerIdFromLink = (link) => { const m = String(link || '').match(/customerdetail\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]) : null; };

const YEARLY = {
  weekly: 52, 'every week': 52,
  'bi-weekly': 26, biweekly: 26, 'every 2 weeks': 26, 'every other week': 26, eow: 26, 'eow odd': 26, 'eow even': 26,
  'every 4 weeks': 13, 'every 6 weeks': round(52 / 6, 2), 'every 8 weeks': 6.5,
  monthly: 12, 'every month': 12, 'bi-monthly': 6, bimonthly: 6, 'every other month': 6,
  quarterly: 4, 'every quarter': 4, 'bi-annual': 2, 'bi annual': 2, 'semi-annual': 2, 'semi annual': 2, 'twice a year': 2,
  annual: 1, annually: 1, yearly: 1, 'once a year': 1, 'one time': 1, 'one-time': 1,
};
const perYear = (freq) => { const f = String(freq || '').toLowerCase().replace(/\s+/g, ' ').trim(); return YEARLY[f] != null ? YEARLY[f] : 0; };
const categoryOf = (item) => { const s = clean(item) || ''; return s.includes(':') ? s.split(':')[0].trim() : (s || 'Uncategorized'); };
const labelOf = (item) => { const s = clean(item) || ''; const i = s.lastIndexOf(':'); return ((i >= 0 ? s.slice(i + 1) : s).trim()) || 'Uncategorized'; };
const primaryRoute = (routes) => { for (const r of routes || []) { const rc = clean(r && (r.Route || r.route)); if (rc) return String(rc).trim().toUpperCase(); } return null; };

function buildAnd(from, to) {
  const and = [CLOSED];
  if (from || to) {
    const start = new Date(`${from || to}T00:00:00.000Z`);
    const end = new Date(`${to || from}T23:59:59.999Z`);
    and.push({ $or: [{ dateCompleted: { $gte: start, $lte: end } }, { invoiceDate: { $gte: start, $lte: end } }] });
  }
  return and;
}
function parseParams(req) {
  return {
    from: clean(req.query.from),
    to: clean(req.query.to),
    routeCode: (clean(req.query.routeCode) || '').toUpperCase() || undefined,
  };
}

const TTL_MS = 300000;
function makeCache() {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (e && Date.now() - e.at < TTL_MS) return e.v; if (e) m.delete(k); return null; },
    set(k, v) { m.set(k, { at: Date.now(), v }); if (m.size > 300) m.delete(m.keys().next().value); },
  };
}
const reconCache = makeCache();
const rawInvCache = makeCache();
const payloadCache = makeCache();

async function computeReconciliation(from, to, routeCode) {
  const db = getSourceDb();
  const and = buildAnd(from, to);

  const accts = await CustomerAccount.find({}, { customerId: 1, customerName: 1, company: 1, pricing: 1, routes: 1 }).lean();
  const cust = new Map();
  const getRec = (cid, name) => {
    let r = cust.get(cid);
    if (!r) { r = { customerId: cid, customer: name || cid, routeCounts: new Map(), pricingRoute: null, expByItem: new Map(), actByItem: new Map(), expected: 0, actual: 0, invoices: [] }; cust.set(cid, r); }
    return r;
  };

  for (const a of accts) {
    const r = getRec(a.customerId, clean(a.customerName) || clean(a.company) || a.customerId);
    r.pricingRoute = primaryRoute(a.routes);
    for (const p of a.pricing || []) {
      const times = perYear(p.frequency); if (times <= 0) continue;
      const rev = (Number(p.salesPrice) || 0) * (Number(p.defaultQty) || 1) * times;
      const key = itemKey(p.item);
      const e = r.expByItem.get(key) || { item: labelOf(p.item), category: categoryOf(p.item), frequency: p.frequency || null, expected: 0 };
      e.expected += rev; r.expByItem.set(key, e); r.expected += rev;
    }
  }

  const invoices = await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: { _id: 0, invoiceNumber: 1, 'customer.name': 1, 'customer.link': 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, total: 1, lineItems: 1 } })
    .batchSize(5000)
    .limit(50000).toArray();
  for (const inv of invoices) {
    const cid = customerIdFromLink(inv.customer && inv.customer.link) || '(unknown)';
    const r = getRec(cid, (inv.customer && inv.customer.name) || '(unknown)');
    const rc = clean(inv.assignedTo) ? String(inv.assignedTo).trim().toUpperCase() : '(unassigned)';
    r.routeCounts.set(rc, (r.routeCounts.get(rc) || 0) + 1);
    let invTotal = 0;
    for (const li of inv.lineItems || []) {
      const amt = Number(li.amount || 0); invTotal += amt;
      const key = itemKey(li.name);
      const a = r.actByItem.get(key) || { item: labelOf(li.name), category: categoryOf(li.name), actual: 0 };
      a.actual += amt; r.actByItem.set(key, a);
    }
    r.actual += invTotal;
    r.invoices.push({ invoiceNumber: inv.invoiceNumber, date: dayKey(inv.dateCompleted || inv.invoiceDate), total: Number(inv.total || 0), lineCount: (inv.lineItems || []).length, route: rc });
  }

  const records = [];
  for (const r of cust.values()) {
    let route = '(unassigned)';
    if (r.routeCounts.size) route = [...r.routeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    else if (r.pricingRoute) route = r.pricingRoute;
    if (routeCode && route !== routeCode) continue;
    r.route = route;
    if (r.expected > 0 || r.actual > 0) records.push(r);
  }
  return { records, routeCode, from, to };
}

async function getReconciliation(from, to, routeCode) {
  const key = `${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = reconCache.get(key);
  if (cached) return cached;
  const v = await computeReconciliation(from, to, routeCode);
  reconCache.set(key, v);
  return v;
}

async function getClosedInvoiceLines(from, to) {
  const key = `${from || ''}|${to || ''}`;
  const cached = rawInvCache.get(key);
  if (cached) return cached;
  const db = getSourceDb();
  const invoices = await db.collection('routestarinvoices')
    .find({ $and: buildAnd(from, to) }, { projection: { _id: 0, invoiceNumber: 1, 'customer.name': 1, 'customer.link': 1, dateCompleted: 1, invoiceDate: 1, lineItems: 1 } })
    .batchSize(5000)
    .limit(50000).toArray();
  rawInvCache.set(key, invoices);
  return invoices;
}

function itemRows(r) {
  const keys = new Set([...r.expByItem.keys(), ...r.actByItem.keys()]);
  const rows = [];
  for (const k of keys) {
    const e = r.expByItem.get(k);
    const a = r.actByItem.get(k);
    const expected = e ? e.expected : 0;
    const actual = a ? a.actual : 0;
    rows.push({
      item: (e && e.item) || (a && a.item) || k,
      category: (e && e.category) || (a && a.category) || 'Uncategorized',
      frequency: e ? e.frequency : null,
      expected: round(expected), invoiced: round(actual), remaining: round(expected - actual),
    });
  }
  return rows.sort((x, y) => y.expected - x.expected || y.invoiced - x.invoiced);
}

function totals(records) {
  const expected = records.reduce((t, r) => t + r.expected, 0);
  const invoiced = records.reduce((t, r) => t + r.actual, 0);
  return { expected: round(expected), invoiced: round(invoiced), remaining: round(expected - invoiced), collectedPct: expected ? round((invoiced / expected) * 100, 1) : null };
}

async function byCustomer(req, res) {
  const { from, to, routeCode } = parseParams(req);
  const pkey = `cust|${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const { records } = await getReconciliation(from, to, routeCode);
  const rows = records.map((r) => ({
    customerId: r.customerId, customer: r.customer, routeCode: r.route,
    expected: round(r.expected), invoiced: round(r.actual), remaining: round(r.expected - r.actual),
    pct: r.expected ? round((r.actual / r.expected) * 100, 1) : null, invoices: r.invoices.length,
  })).sort((a, b) => b.invoiced - a.invoiced);
  const t = totals(records);
  const payload = buildEnvelope({ kpis: { ...t, customers: rows.length }, rows }, { meta: { source: 'pricing (expected) + invoices (actual)', routeCode: routeCode || null } });
  payloadCache.set(pkey, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

async function customerDetail(req, res) {
  const { from, to, routeCode } = parseParams(req);
  const pkey = `cd|${req.params.id}|${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const { records } = await getReconciliation(from, to, routeCode);
  const r = records.find((x) => x.customerId === req.params.id);
  if (!r) { const e = new Error(`Customer ${req.params.id} not found in range`); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  const payload = buildEnvelope({
    customerId: r.customerId, customer: r.customer, routeCode: r.route,
    expected: round(r.expected), invoiced: round(r.actual), remaining: round(r.expected - r.actual),
    pct: r.expected ? round((r.actual / r.expected) * 100, 1) : null,
    items: itemRows(r),
    invoices: r.invoices.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))),
  });
  payloadCache.set(pkey, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

async function byCategory(req, res) {
  const { from, to, routeCode } = parseParams(req);
  const pkey = `cat|${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const { records } = await getReconciliation(from, to, routeCode);
  const map = new Map();
  for (const r of records) {
    for (const [k, e] of r.expByItem) { const o = map.get(k) || { category: e.item, expected: 0, invoiced: 0 }; o.expected += e.expected; map.set(k, o); }
    for (const [k, a] of r.actByItem) { const o = map.get(k) || { category: a.item, expected: 0, invoiced: 0 }; o.invoiced += a.actual; map.set(k, o); }
  }
  const t = totals(records);
  const rows = [...map.values()].map((o) => ({ category: o.category, expected: round(o.expected), invoiced: round(o.invoiced), remaining: round(o.expected - o.invoiced), pct: o.expected ? round((o.invoiced / o.expected) * 100, 1) : null }))
    .sort((a, b) => b.invoiced - a.invoiced);
  const payload = buildEnvelope({ kpis: { ...t, categories: rows.length }, rows }, { meta: { source: 'pricing + invoices', routeCode: routeCode || null } });
  payloadCache.set(pkey, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

async function categoryDetail(req, res) {
  const name = clean(req.query.name);
  const { from, to, routeCode } = parseParams(req);
  const pkey = `cdt|${name || ''}|${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }

  const wantKey = itemKey(name);
  const [{ records }, invoices] = await Promise.all([getReconciliation(from, to, routeCode), getClosedInvoiceLines(from, to)]);
  const custRows = [];
  const invoiceRows = [];
  const wantRoute = (routeCode || '').toUpperCase();
  const custRoute = new Map(records.map((r) => [r.customerId, r.route]));
  for (const inv of invoices) {
    const cid = customerIdFromLink(inv.customer && inv.customer.link) || '(unknown)';
    if (wantRoute && (custRoute.get(cid) || '') !== wantRoute) continue;
    let amt = 0;
    for (const li of inv.lineItems || []) { if (itemKey(li.name) === wantKey) amt += Number(li.amount || 0); }
    if (amt > 0) invoiceRows.push({ invoiceNumber: inv.invoiceNumber, customer: (inv.customer && inv.customer.name) || '', date: dayKey(inv.dateCompleted || inv.invoiceDate), amount: round(amt) });
  }
  for (const r of records) {
    const e = r.expByItem.get(wantKey);
    const a = r.actByItem.get(wantKey);
    const exp = e ? e.expected : 0;
    const act = a ? a.actual : 0;
    if (exp > 0 || act > 0) custRows.push({ customerId: r.customerId, customer: r.customer, routeCode: r.route, expected: round(exp), invoiced: round(act), remaining: round(exp - act) });
  }
  custRows.sort((a, b) => b.invoiced - a.invoiced);
  invoiceRows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const payload = buildEnvelope({ category: name, customers: custRows, invoices: invoiceRows });
  payloadCache.set(pkey, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

async function byRoute(req, res) {
  const { from, to, routeCode } = parseParams(req);
  const pkey = `rt|${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const { records } = await getReconciliation(from, to, routeCode);
  const map = new Map();
  for (const r of records) {
    const o = map.get(r.route) || { routeCode: r.route, expected: 0, invoiced: 0, stops: 0, customers: 0 };
    o.expected += r.expected; o.invoiced += r.actual; o.stops += r.invoices.length; o.customers += 1; map.set(r.route, o);
  }
  const t = totals(records);
  const rows = [...map.values()].map((o) => ({ routeCode: o.routeCode, expected: round(o.expected), invoiced: round(o.invoiced), remaining: round(o.expected - o.invoiced), stops: o.stops, customers: o.customers, pct: o.expected ? round((o.invoiced / o.expected) * 100, 1) : null }))
    .sort((a, b) => b.invoiced - a.invoiced);
  const payload = buildEnvelope({ kpis: { ...t, routes: rows.length }, rows });
  payloadCache.set(pkey, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

async function perStop(req, res) {
  const { from, to, routeCode } = parseParams(req);
  const pkey = `stop|${from || ''}|${to || ''}|${routeCode || ''}`;
  const cached = payloadCache.get(pkey);
  if (cached) { res.set('X-Cache', 'HIT'); return res.json(cached); }
  const { records } = await getReconciliation(from, to, routeCode);
  const map = new Map();
  let invoiced = 0; let stops = 0; let expected = 0;
  for (const r of records) {
    invoiced += r.actual; expected += r.expected; stops += r.invoices.length;
    const o = map.get(r.route) || { routeCode: r.route, invoiced: 0, stops: 0, expected: 0 };
    o.invoiced += r.actual; o.stops += r.invoices.length; o.expected += r.expected; map.set(r.route, o);
  }
  const byRouteRows = [...map.values()].map((o) => ({ routeCode: o.routeCode, invoiced: round(o.invoiced), stops: o.stops, revenuePerStop: o.stops ? round(o.invoiced / o.stops, 2) : 0, expected: round(o.expected) }))
    .sort((a, b) => b.revenuePerStop - a.revenuePerStop);
  const topCustomers = records.map((r) => ({ customerId: r.customerId, customer: r.customer, routeCode: r.route, invoiced: round(r.actual), stops: r.invoices.length, revenuePerStop: r.invoices.length ? round(r.actual / r.invoices.length, 2) : 0 }))
    .sort((a, b) => b.invoiced - a.invoiced).slice(0, 50);
  const payload = buildEnvelope({ kpis: { invoiced: round(invoiced), expected: round(expected), remaining: round(expected - invoiced), stops, revenuePerStop: stops ? round(invoiced / stops, 2) : 0, routes: byRouteRows.length }, byRoute: byRouteRows, byCustomer: topCustomers });
  payloadCache.set(pkey, payload);
  res.set('X-Cache', 'MISS');
  res.json(payload);
}

function commonRanges() {
  const d = new Date();
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const today = iso(d);
  const week = new Date(d); week.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return [
    { from: `${d.getFullYear()}-01-01`, to: today },
    { from: iso(new Date(d.getFullYear(), d.getMonth(), 1)), to: today },
    { from: iso(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1)), to: today },
    { from: iso(week), to: today },
  ];
}

const fakeReq = (from, to) => ({ query: { from, to }, params: {} });
const fakeRes = () => ({ set() {}, json() {} });

let warming = false;
async function warm() {
  if (warming) return;
  warming = true;
  try {
    for (const r of commonRanges()) {
      try {
        await getReconciliation(r.from, r.to, undefined);
        await Promise.all([
          byCategory(fakeReq(r.from, r.to), fakeRes()),
          byRoute(fakeReq(r.from, r.to), fakeRes()),
          byCustomer(fakeReq(r.from, r.to), fakeRes()),
          perStop(fakeReq(r.from, r.to), fakeRes()),
        ]);
      } catch (e) { /* db not ready yet */ }
    }
  } finally { warming = false; }
}

function startWarmer() {
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, TTL_MS - 30000);
}

module.exports = { byCategory, categoryDetail, byRoute, byCustomer, customerDetail, perStop, warm, startWarmer };
