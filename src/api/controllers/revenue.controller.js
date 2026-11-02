'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');
const { inFilterRange, filterDayKey } = require('../lib/checkoutDate');
const { itemKey, frequencyFor } = require('../../services/pricingMatch');
const { snapshotMap } = require('../../services/invoiceSnapshots');
const {
  UNITEMIZED_KEY, UNITEMIZED_LABEL, cents, dollars, netCents, taxCents, grossCents, effectiveLines,
} = require('../lib/invoiceMoney');

const { CustomerAccount, InvoiceFrequency } = models;
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const customerIdFromLink = (link) => { const m = String(link || '').match(/customerdetail\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]) : null; };
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const routeOf = (v) => (clean(v) ? String(v).trim().toUpperCase() : '(UNASSIGNED)');

const YEARLY = {
  weekly: 52, 'every week': 52,
  'bi-weekly': 26, biweekly: 26, 'every 2 weeks': 26, 'every other week': 26, eow: 26, 'eow odd': 26, 'eow even': 26,
  'every 4 weeks': 13, 'every 6 weeks': round(52 / 6, 2), 'every 8 weeks': 6.5,
  monthly: 12, 'every month': 12, 'bi-monthly': 6, bimonthly: 6, 'every other month': 6,
  quarterly: 4, 'every quarter': 4, 'bi-annual': 2, 'bi annual': 2, 'semi-annual': 2, 'semi annual': 2, 'twice a year': 2,
  annual: 1, annually: 1, yearly: 1, 'once a year': 1, 'one time': 1, 'one-time': 1,
};
const YEARLY_PATTERNS = [
  [/^monthly ?week ?\d+$/, () => 12],
  [/^every ?(\d+) ?weeks?$/, (m) => round(52 / Number(m[1]), 2)],
  [/^every ?(\d+) ?months?$/, (m) => round(12 / Number(m[1]), 2)],
];
const perYear = (freq) => {
  const f = String(freq || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (YEARLY[f] != null) return YEARLY[f];
  for (const [rx, fn] of YEARLY_PATTERNS) {
    const m = rx.exec(f);
    if (m && (m[1] == null || Number(m[1]) > 0)) return fn(m);
  }
  return 0;
};
const ONE_TIME = 'One Time';
const ONE_TIME_ALIASES = new Set(['one time', 'one-time', 'onetime']);
const itemFrequencyLabel = (freq) => {
  const f = String(freq == null ? '' : freq).toLowerCase().replace(/\s+/g, ' ').trim();
  return (!f || f.startsWith('choose') || ONE_TIME_ALIASES.has(f)) ? ONE_TIME : clean(freq);
};
const categoryOf = (item) => { const s = clean(item) || ''; return s.includes(':') ? s.split(':')[0].trim() : (s || 'Uncategorized'); };
const labelOf = (item) => { const s = clean(item) || ''; const i = s.lastIndexOf(':'); return ((i >= 0 ? s.slice(i + 1) : s).trim()) || 'Uncategorized'; };
const keyFor = (name) => (name === UNITEMIZED_LABEL ? UNITEMIZED_KEY : itemKey(name));
const primaryRoute = (routes) => { for (const r of routes || []) { const rc = clean(r && (r.Route || r.route)); if (rc) return String(rc).trim().toUpperCase(); } return null; };
const allRouteCodes = (routes) => { const set = new Set(); for (const r of routes || []) { const rc = clean(r && (r.Route || r.route)); if (rc) set.add(String(rc).trim().toUpperCase()); } return [...set]; };

function dateBound(dk, days) {
  const d = new Date(`${dk}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function datePrefilter(from, to) {
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = dateBound(from, -2);
  if (to) range.$lte = dateBound(to, 2);
  return { dateCompleted: range };
}
function buildAnd(from, to) {
  const and = [CLOSED];
  const pre = datePrefilter(from, to);
  if (pre) and.push(pre);
  return and;
}
function parseParams(req) {
  return {
    from: clean(req.query.from),
    to: clean(req.query.to),
    routeCode: (clean(req.query.routeCode) || '').toUpperCase() || undefined,
  };
}
function routeAnd(routeCode) {
  if (routeCode === '(UNASSIGNED)') return { $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }, { assignedTo: '' }] };
  if (routeCode) return { assignedTo: new RegExp(`^\\s*${escapeRegex(routeCode)}\\s*$`, 'i') };
  return null;
}

const TTL_MS = 300000;
function makeCache() {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (e && Date.now() - e.at < TTL_MS) return e.v; if (e) m.delete(k); return null; },
    set(k, v) { m.set(k, { at: Date.now(), v }); if (m.size > 40) m.delete(m.keys().next().value); },
    clear() { m.clear(); },
  };
}
const reconCache = makeCache();
const inputCache = makeCache();
const payloadCache = makeCache();

function invalidate() { reconCache.clear(); inputCache.clear(); payloadCache.clear(); }

const INVOICE_PROJECTION = {
  _id: 0, invoiceNumber: 1, 'customer.name': 1, 'customer.link': 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1,
  arrivalTime: 1, departureTime: 1, subtotal: 1, tax: 1, total: 1,
  'lineItems.name': 1, 'lineItems.description': 1, 'lineItems.quantity': 1, 'lineItems.amount': 1, 'lineItems.rate': 1,
};

function decorate(inv, snap) {
  const eff = effectiveLines(inv, snap);
  const net = netCents(inv);
  const lines = (eff.lines || []).map((li) => ({
    name: li.name, description: li.description, quantity: Number(li.quantity || 0), rate: Number(li.rate || 0), amountCents: cents(li.amount),
  }));
  const lineSum = lines.reduce((t, l) => t + l.amountCents, 0);
  return {
    invoiceNumber: inv.invoiceNumber,
    customerId: customerIdFromLink(inv.customer && inv.customer.link) || '(unknown)',
    customer: clean(inv.customer && inv.customer.name) || '(unknown)',
    route: routeOf(inv.assignedTo),
    date: filterDayKey(inv) || dayKey(inv.dateCompleted || inv.invoiceDate),
    checkIn: clean(inv.arrivalTime) || null,
    checkOut: clean(inv.departureTime) || null,
    net,
    tax: taxCents(inv),
    gross: grossCents(inv),
    lines,
    linesSource: eff.source,
    unitemized: net - lineSum,
  };
}

function itemAmounts(inv) {
  const out = new Map();
  for (const l of inv.lines) {
    const key = itemKey(l.name);
    const e = out.get(key) || { item: labelOf(l.name), category: categoryOf(l.name), cents: 0, qty: 0, lines: 0 };
    e.cents += l.amountCents; e.qty += l.quantity; e.lines += 1;
    out.set(key, e);
  }
  if (inv.unitemized !== 0) out.set(UNITEMIZED_KEY, { item: UNITEMIZED_LABEL, category: UNITEMIZED_LABEL, cents: inv.unitemized, qty: 0, lines: 0 });
  return out;
}

async function loadInvoices(from, to, extraAnd = []) {
  const docs = await getSourceDb().collection('routestarinvoices')
    .find({ $and: [...buildAnd(from, to), ...extraAnd] }, { projection: INVOICE_PROJECTION })
    .batchSize(5000)
    .limit(50000).toArray();
  const snaps = await snapshotMap();
  return docs.filter((inv) => inFilterRange(inv, from, to)).map((inv) => decorate(inv, snaps.get(inv.invoiceNumber)));
}

async function getInputs(from, to) {
  const key = `${from || ''}|${to || ''}`;
  const cached = inputCache.get(key);
  if (cached) return cached;
  const [accts, invoices] = await Promise.all([
    CustomerAccount.find({}, { customerId: 1, customerName: 1, company: 1, pricing: 1, routes: 1 }).lean(),
    loadInvoices(from, to),
  ]);
  const inputs = { accts, invoices };
  inputCache.set(key, inputs);
  return inputs;
}

function computeReconciliation({ accts, invoices }, routeCode) {
  const counts = new Map();
  for (const inv of invoices) {
    const m = counts.get(inv.customerId) || new Map();
    m.set(inv.route, (m.get(inv.route) || 0) + 1);
    counts.set(inv.customerId, m);
  }
  const acctById = new Map(accts.map((a) => [a.customerId, a]));
  const primaryOf = (cid) => {
    const m = counts.get(cid);
    if (m && m.size) return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return primaryRoute((acctById.get(cid) || {}).routes) || '(UNASSIGNED)';
  };

  const cust = new Map();
  const getRec = (cid, name) => {
    let r = cust.get(cid);
    if (!r) {
      r = { customerId: cid, customer: name || cid, expByItem: new Map(), actByItem: new Map(), expected: 0, actualCents: 0, taxCents: 0, grossCents: 0, invoices: [] };
      cust.set(cid, r);
    }
    return r;
  };

  for (const a of accts) {
    if (routeCode && primaryOf(a.customerId) !== routeCode) continue;
    const r = getRec(a.customerId, clean(a.customerName) || clean(a.company) || a.customerId);
    for (const p of a.pricing || []) {
      const times = perYear(p.frequency); if (times <= 0) continue;
      const rev = (Number(p.salesPrice) || 0) * (Number(p.defaultQty) || 1) * times;
      const key = itemKey(p.item);
      const e = r.expByItem.get(key) || { item: labelOf(p.item), category: categoryOf(p.item), frequency: p.frequency || null, expected: 0 };
      e.expected += rev; r.expByItem.set(key, e); r.expected += rev;
    }
  }

  for (const inv of invoices) {
    if (routeCode && inv.route !== routeCode) continue;
    const r = getRec(inv.customerId, inv.customer);
    for (const [key, e] of itemAmounts(inv)) {
      const a = r.actByItem.get(key) || { item: e.item, category: e.category, actualCents: 0 };
      a.actualCents += e.cents; r.actByItem.set(key, a);
    }
    r.actualCents += inv.net; r.taxCents += inv.tax; r.grossCents += inv.gross;
    r.invoices.push({ invoiceNumber: inv.invoiceNumber, date: inv.date, route: inv.route, net: inv.net, tax: inv.tax, gross: inv.gross, lineCount: inv.lines.length, linesMatch: inv.unitemized === 0 });
  }

  const records = [];
  for (const r of cust.values()) {
    const acct = acctById.get(r.customerId);
    r.route = routeCode || primaryOf(r.customerId);
    const list = new Set([...(acct ? allRouteCodes(acct.routes) : []), ...r.invoices.map((i) => i.route)]);
    r.routes = list.size ? [...list] : [r.route];
    r.actual = dollars(r.actualCents);
    if (r.expected > 0 || r.invoices.length > 0) records.push(r);
  }
  return records;
}

async function getReconciliation(from, to, routeCode) {
  const key = `${from || ''}|${to || ''}|${routeCode || ''}`;
  let records = reconCache.get(key);
  if (!records) {
    records = computeReconciliation(await getInputs(from, to), routeCode);
    reconCache.set(key, records);
  }
  return { records, routeCode, from, to };
}

const invoiceOut = (i) => ({ invoiceNumber: i.invoiceNumber, date: i.date, route: i.route, subtotal: dollars(i.net), tax: dollars(i.tax), total: dollars(i.gross), lineCount: i.lineCount, linesMatch: i.linesMatch });

function itemRows(r) {
  const keys = new Set([...r.expByItem.keys(), ...r.actByItem.keys()]);
  const rows = [];
  for (const k of keys) {
    const e = r.expByItem.get(k);
    const a = r.actByItem.get(k);
    const expected = e ? e.expected : 0;
    const actual = a ? dollars(a.actualCents) : 0;
    rows.push({
      item: (e && e.item) || (a && a.item) || k,
      category: (e && e.category) || (a && a.category) || 'Uncategorized',
      frequency: e ? e.frequency : null,
      expected: round(expected), invoiced: actual, remaining: round(expected - actual),
    });
  }
  return rows.sort((x, y) => y.expected - x.expected || y.invoiced - x.invoiced);
}

function totals(records) {
  const expected = records.reduce((t, r) => t + r.expected, 0);
  const invoiced = dollars(records.reduce((t, r) => t + r.actualCents, 0));
  return {
    expected: round(expected),
    invoiced,
    tax: dollars(records.reduce((t, r) => t + r.taxCents, 0)),
    billed: dollars(records.reduce((t, r) => t + r.grossCents, 0)),
    remaining: round(expected - invoiced),
    collectedPct: expected ? round((invoiced / expected) * 100, 1) : null,
    invoices: records.reduce((t, r) => t + r.invoices.length, 0),
  };
}

const BASIS = 'net: invoice subtotal before tax (tax and billed shown separately)';

async function cached(pkey, res, build) {
  const hit = payloadCache.get(pkey);
  if (hit) { res.set('X-Cache', 'HIT'); return res.json(hit); }
  const payload = await build();
  payloadCache.set(pkey, payload);
  res.set('X-Cache', 'MISS');
  return res.json(payload);
}

async function byCustomer(req, res) {
  const { from, to, routeCode } = parseParams(req);
  return cached(`cust|${from || ''}|${to || ''}|${routeCode || ''}`, res, async () => {
    const { records } = await getReconciliation(from, to, routeCode);
    const rows = records.map((r) => ({
      customerId: r.customerId, customer: r.customer, routeCode: r.route, routes: r.routes,
      expected: round(r.expected), invoiced: r.actual, tax: dollars(r.taxCents), billed: dollars(r.grossCents),
      remaining: round(r.expected - r.actual), pct: r.expected ? round((r.actual / r.expected) * 100, 1) : null, invoices: r.invoices.length,
    })).sort((a, b) => b.invoiced - a.invoiced);
    return buildEnvelope({ kpis: { ...totals(records), customers: rows.length }, rows }, { meta: { source: 'pricing (expected) + invoices (actual)', basis: BASIS, routeCode: routeCode || null, from: from || null, to: to || null } });
  });
}

async function customerDetail(req, res) {
  const { from, to, routeCode } = parseParams(req);
  return cached(`cd|${req.params.id}|${from || ''}|${to || ''}|${routeCode || ''}`, res, async () => {
    const { records } = await getReconciliation(from, to, routeCode);
    const r = records.find((x) => x.customerId === req.params.id);
    if (!r) { const e = new Error(`Customer ${req.params.id} not found in range`); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
    return buildEnvelope({
      customerId: r.customerId, customer: r.customer, routeCode: r.route, routes: r.routes,
      expected: round(r.expected), invoiced: r.actual, tax: dollars(r.taxCents), billed: dollars(r.grossCents),
      remaining: round(r.expected - r.actual), pct: r.expected ? round((r.actual / r.expected) * 100, 1) : null,
      items: itemRows(r),
      invoices: r.invoices.map(invoiceOut).sort((a, b) => String(b.date).localeCompare(String(a.date))),
    }, { meta: { basis: BASIS } });
  });
}

async function byCategory(req, res) {
  const { from, to, routeCode } = parseParams(req);
  return cached(`cat|${from || ''}|${to || ''}|${routeCode || ''}`, res, async () => {
    const { records } = await getReconciliation(from, to, routeCode);
    const map = new Map();
    for (const r of records) {
      for (const [k, e] of r.expByItem) { const o = map.get(k) || { category: e.item, expected: 0, invoicedCents: 0 }; o.expected += e.expected; map.set(k, o); }
      for (const [k, a] of r.actByItem) { const o = map.get(k) || { category: a.item, expected: 0, invoicedCents: 0 }; o.invoicedCents += a.actualCents; map.set(k, o); }
    }
    const rows = [...map.values()].map((o) => {
      const invoiced = dollars(o.invoicedCents);
      return { category: o.category, expected: round(o.expected), invoiced, remaining: round(o.expected - invoiced), pct: o.expected ? round((invoiced / o.expected) * 100, 1) : null };
    }).sort((a, b) => b.invoiced - a.invoiced);
    return buildEnvelope({ kpis: { ...totals(records), categories: rows.length }, rows }, { meta: { source: 'pricing + invoices', basis: BASIS, routeCode: routeCode || null } });
  });
}

async function categoryDetail(req, res) {
  const name = clean(req.query.name);
  const { from, to, routeCode } = parseParams(req);
  return cached(`cdt|${name || ''}|${from || ''}|${to || ''}|${routeCode || ''}`, res, async () => {
    const wantKey = keyFor(name);
    const [{ records }, inputs] = await Promise.all([getReconciliation(from, to, routeCode), getInputs(from, to)]);
    const invoiceRows = [];
    for (const inv of inputs.invoices) {
      if (routeCode && inv.route !== routeCode) continue;
      const e = itemAmounts(inv).get(wantKey);
      if (e && e.cents !== 0) invoiceRows.push({ invoiceNumber: inv.invoiceNumber, customer: inv.customer, date: inv.date, amount: dollars(e.cents) });
    }
    const custRows = [];
    for (const r of records) {
      const e = r.expByItem.get(wantKey);
      const a = r.actByItem.get(wantKey);
      const exp = e ? e.expected : 0;
      const act = a ? dollars(a.actualCents) : 0;
      if (exp > 0 || act !== 0) custRows.push({ customerId: r.customerId, customer: r.customer, routeCode: r.route, expected: round(exp), invoiced: act, remaining: round(exp - act) });
    }
    custRows.sort((a, b) => b.invoiced - a.invoiced);
    invoiceRows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return buildEnvelope({ category: name, customers: custRows, invoices: invoiceRows }, { meta: { basis: BASIS } });
  });
}

async function byRoute(req, res) {
  const { from, to, routeCode } = parseParams(req);
  return cached(`rt|${from || ''}|${to || ''}|${routeCode || ''}`, res, async () => {
    const { records } = await getReconciliation(from, to, routeCode);
    const map = new Map();
    const row = (rt) => {
      let o = map.get(rt);
      if (!o) { o = { routeCode: rt, expected: 0, net: 0, tax: 0, gross: 0, stops: 0, customers: new Set() }; map.set(rt, o); }
      return o;
    };
    for (const r of records) {
      for (const inv of r.invoices) {
        const o = row(inv.route);
        o.net += inv.net; o.tax += inv.tax; o.gross += inv.gross; o.stops += 1; o.customers.add(r.customerId);
      }
      if (r.expected > 0) row(r.route).expected += r.expected;
    }
    const rows = [...map.values()].map((o) => {
      const invoiced = dollars(o.net);
      return {
        routeCode: o.routeCode, expected: round(o.expected), invoiced, tax: dollars(o.tax), billed: dollars(o.gross),
        remaining: round(o.expected - invoiced), stops: o.stops, customers: o.customers.size,
        pct: o.expected ? round((invoiced / o.expected) * 100, 1) : null,
      };
    }).sort((a, b) => b.invoiced - a.invoiced);
    return buildEnvelope({ kpis: { ...totals(records), routes: rows.length }, rows }, { meta: { basis: BASIS, routeCode: routeCode || null } });
  });
}

async function perStop(req, res) {
  const { from, to, routeCode } = parseParams(req);
  return cached(`stop|${from || ''}|${to || ''}|${routeCode || ''}`, res, async () => {
    const { records } = await getReconciliation(from, to, routeCode);
    const map = new Map();
    const row = (rt) => { let o = map.get(rt); if (!o) { o = { routeCode: rt, net: 0, stops: 0, expected: 0 }; map.set(rt, o); } return o; };
    for (const r of records) {
      for (const inv of r.invoices) { const o = row(inv.route); o.net += inv.net; o.stops += 1; }
      if (r.expected > 0) row(r.route).expected += r.expected;
    }
    const t = totals(records);
    const byRouteRows = [...map.values()].filter((o) => o.stops > 0).map((o) => ({
      routeCode: o.routeCode, invoiced: dollars(o.net), stops: o.stops, revenuePerStop: o.stops ? round(dollars(o.net) / o.stops, 2) : 0, expected: round(o.expected),
    })).sort((a, b) => b.revenuePerStop - a.revenuePerStop);
    const topCustomers = records.filter((r) => r.invoices.length).map((r) => ({
      customerId: r.customerId, customer: r.customer, routeCode: r.route, invoiced: r.actual, stops: r.invoices.length,
      revenuePerStop: round(r.actual / r.invoices.length, 2),
    })).sort((a, b) => b.invoiced - a.invoiced).slice(0, 50);
    return buildEnvelope({
      kpis: {
        invoiced: t.invoiced, tax: t.tax, billed: t.billed, expected: t.expected, remaining: t.remaining,
        stops: t.invoices, revenuePerStop: t.invoices ? round(t.invoiced / t.invoices, 2) : 0, routes: byRouteRows.length,
      },
      byRoute: byRouteRows,
      byCustomer: topCustomers,
    }, { meta: { basis: BASIS, stopDefinition: 'one closed invoice (including $0 invoices)', routeCode: routeCode || null } });
  });
}

async function drillData(from, to, { routeCode, customerId, category, frequency } = {}) {
  const extra = [];
  const ra = routeAnd(routeCode);
  if (ra) extra.push(ra);
  if (customerId) extra.push({ 'customer.link': new RegExp(`customerdetail/${escapeRegex(customerId)}(?:[/?#]|$)`, 'i') });
  const invoices = (await loadInvoices(from, to, extra)).filter((inv) => !customerId || inv.customerId === customerId);

  const wantKey = category ? keyFor(category) : null;
  const freqFilter = frequency ? String(frequency) : null;
  const NONE = '(none)';
  let pricingByCid = null; let storedByInvoice = null;
  if (freqFilter) {
    const cids = [...new Set(invoices.map((i) => i.customerId))];
    const [accts, storedDocs] = await Promise.all([
      CustomerAccount.find({ customerId: { $in: cids } }, { customerId: 1, pricing: 1 }).lean(),
      InvoiceFrequency.find({ invoiceNumber: { $in: invoices.map((i) => i.invoiceNumber) } }, { invoiceNumber: 1, lines: 1 }).lean(),
    ]);
    pricingByCid = new Map(accts.map((a) => [a.customerId, a.pricing || []]));
    storedByInvoice = new Map();
    for (const d of storedDocs) { const m = new Map(); for (const l of d.lines || []) m.set(`${l.item}||${l.rate}`, l.frequency || null); storedByInvoice.set(d.invoiceNumber, m); }
  }

  const custMap = new Map();
  const itemMap = new Map();
  const invoiceRows = [];
  let taxC = 0; let grossC = 0;
  const targetFreq = freqFilter === NONE ? ONE_TIME : freqFilter;
  for (const inv of invoices) {
    let amount = 0; let matched = 0;
    const measured = wantKey || freqFilter;
    const parts = [];
    if (freqFilter) {
      const pricing = pricingByCid.get(inv.customerId) || [];
      const sm = storedByInvoice.get(inv.invoiceNumber);
      for (const l of inv.lines) {
        const key = itemKey(l.name);
        if (wantKey && key !== wantKey) continue;
        const sk = `${clean(l.name) || ''}||${Number(l.rate || 0)}`;
        const lf = itemFrequencyLabel(sm && sm.has(sk) ? sm.get(sk) : frequencyFor(l, pricing));
        if (lf !== targetFreq) continue;
        parts.push({ key, item: labelOf(l.name), category: categoryOf(l.name), cents: l.amountCents, qty: l.quantity, lines: 1 });
      }
    } else {
      for (const [key, e] of itemAmounts(inv)) {
        if (wantKey && key !== wantKey) continue;
        parts.push({ key, item: e.item, category: e.category, cents: e.cents, qty: e.qty, lines: e.lines });
      }
    }
    for (const p of parts) {
      amount += p.cents; matched += p.lines || 1;
      const it = itemMap.get(p.key) || { item: p.item, category: p.category, qty: 0, invoicedCents: 0, lines: 0 };
      it.qty += p.qty; it.invoicedCents += p.cents; it.lines += p.lines; itemMap.set(p.key, it);
    }
    if (measured && matched === 0) continue;
    const value = measured ? amount : inv.net;
    if (!measured) { taxC += inv.tax; grossC += inv.gross; }
    const c = custMap.get(inv.customerId) || { customerId: inv.customerId, customer: inv.customer, cents: 0, stops: 0 };
    c.cents += value; c.stops += 1; custMap.set(inv.customerId, c);
    invoiceRows.push({
      invoiceNumber: inv.invoiceNumber, customerId: inv.customerId, customer: inv.customer, date: inv.date, route: inv.route,
      checkIn: inv.checkIn, checkOut: inv.checkOut, amount: dollars(value), subtotal: dollars(inv.net), tax: dollars(inv.tax), total: dollars(inv.gross),
      lineCount: measured ? matched : inv.lines.length,
    });
  }
  const customers = [...custMap.values()].map((c) => ({ customerId: c.customerId, customer: c.customer, invoiced: dollars(c.cents), stops: c.stops })).sort((a, b) => b.invoiced - a.invoiced);
  const items = [...itemMap.values()].map((i) => ({ item: i.item, category: i.category, qty: round(i.qty, 2), invoiced: dollars(i.invoicedCents), lines: i.lines })).sort((a, b) => b.invoiced - a.invoiced);
  invoiceRows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const invoicedCents = [...custMap.values()].reduce((t, c) => t + c.cents, 0);
  return {
    kpis: {
      invoiced: dollars(invoicedCents),
      tax: (wantKey || freqFilter) ? null : dollars(taxC),
      billed: (wantKey || freqFilter) ? null : dollars(grossC),
      stops: invoiceRows.length, customers: customers.length, items: items.length,
    },
    customers, invoices: invoiceRows, items,
  };
}

async function routeDetail(req, res) {
  const { from, to, routeCode } = parseParams(req);
  if (!routeCode) { const e = new Error('routeCode is required'); e.status = 400; e.code = 'BAD_REQUEST'; throw e; }
  return cached(`rtd|${routeCode}|${from || ''}|${to || ''}`, res, async () => {
    const d = await drillData(from, to, { routeCode });
    return buildEnvelope({ routeCode, ...d }, { meta: { source: 'invoices (actual)', basis: BASIS, from: from || null, to: to || null } });
  });
}

async function drill(req, res) {
  const { from, to, routeCode } = parseParams(req);
  const rc = routeCode && routeCode !== 'ALL' ? routeCode : undefined;
  const customerId = clean(req.query.customerId);
  const category = clean(req.query.category);
  const frequency = clean(req.query.frequency);
  return cached(`drl|${rc || ''}|${customerId || ''}|${category || ''}|${frequency || ''}|${from || ''}|${to || ''}`, res, async () => {
    const d = await drillData(from, to, { routeCode: rc, customerId, category, frequency });
    return buildEnvelope({ routeCode: rc || null, customerId: customerId || null, category: category || null, frequency: frequency || null, ...d }, { meta: { source: 'invoices (actual)', basis: BASIS, from: from || null, to: to || null } });
  });
}

async function customersOverview(req, res) {
  const { from, to, routeCode } = parseParams(req);
  const term = clean(req.query.q);
  return cached(`cov|${from || ''}|${to || ''}|${routeCode || ''}|${term || ''}`, res, async () => {
    const db = getSourceDb();
    const rx = term ? new RegExp(escapeRegex(term), 'i') : null;
    const and = buildAnd(from, to);
    const ra = routeAnd(routeCode);
    if (ra) and.push(ra);
    if (rx) and.push({ 'customer.name': rx });

    const invoices = (await db.collection('routestarinvoices')
      .find({ $and: and }, { projection: { _id: 0, invoiceNumber: 1, 'customer.name': 1, 'customer.link': 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1, subtotal: 1, tax: 1, total: 1 } })
      .batchSize(5000)
      .limit(50000).toArray()).filter((inv) => inFilterRange(inv, from, to));

    const custMap = new Map();
    const monthMap = new Map();
    for (const inv of invoices) {
      const cid = customerIdFromLink(inv.customer && inv.customer.link) || '(unknown)';
      const name = clean(inv.customer && inv.customer.name) || '(unknown)';
      const rc = routeOf(inv.assignedTo);
      const dk = filterDayKey(inv) || dayKey(inv.dateCompleted || inv.invoiceDate);
      const net = netCents(inv);
      const c = custMap.get(cid) || { customerId: cid, customer: name, invoices: 0, cents: 0, firstDate: null, lastDate: null, routeCounts: new Map() };
      c.invoices += 1; c.cents += net;
      if (dk) { if (!c.firstDate || dk < c.firstDate) c.firstDate = dk; if (!c.lastDate || dk > c.lastDate) c.lastDate = dk; }
      c.routeCounts.set(rc, (c.routeCounts.get(rc) || 0) + 1);
      custMap.set(cid, c);
      if (dk) { const mk = dk.slice(0, 7); const m = monthMap.get(mk) || { month: mk, invoices: 0, cents: 0 }; m.invoices += 1; m.cents += net; monthMap.set(mk, m); }
    }

    const rows = [...custMap.values()].map((c) => {
      let route = '(UNASSIGNED)';
      if (c.routeCounts.size) route = [...c.routeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const invoiced = dollars(c.cents);
      return { customerId: c.customerId, customer: c.customer, routeCode: route, invoices: c.invoices, invoiced, avgInvoice: c.invoices ? round(invoiced / c.invoices) : 0, firstDate: c.firstDate, lastDate: c.lastDate };
    }).sort((a, b) => b.invoices - a.invoices);

    const routeMap = new Map();
    for (const r of rows) {
      const rm = routeMap.get(r.routeCode) || { routeCode: r.routeCode, customers: 0, invoices: 0, invoiced: 0 };
      rm.customers += 1; rm.invoices += r.invoices; rm.invoiced += r.invoiced; routeMap.set(r.routeCode, rm);
    }
    const byRouteRows = [...routeMap.values()].map((r) => ({ routeCode: r.routeCode, customers: r.customers, invoices: r.invoices, invoiced: round(r.invoiced) })).sort((a, b) => b.customers - a.customers);
    const months = [...monthMap.values()].map((m) => ({ month: m.month, invoices: m.invoices, invoiced: dollars(m.cents) })).sort((a, b) => a.month.localeCompare(b.month));

    const start = from ? new Date(`${from}T00:00:00.000Z`) : null;
    const end = to ? new Date(`${to}T23:59:59.999Z`) : null;
    const inRoute = (onRoute) => {
      if (!routeCode) return true;
      return routeOf(onRoute) === routeCode;
    };
    const custDocs = await db.collection('routestarcustomers')
      .find({}, { projection: { _id: 0, customerId: 1, customerName: 1, company: 1, onRoute: 1, accountNumber: 1, createdDate: 1, createdAt: 1 } })
      .limit(20000).toArray();
    const acctCreated = new Map();
    try {
      const accts = await CustomerAccount.find({ createdDate: { $ne: null } }, { customerId: 1, createdDate: 1 }).lean();
      for (const a of accts) { if (a.createdDate) acctCreated.set(a.customerId, a.createdDate); }
    } catch (e) { void e; }
    const newMonthMap = new Map();
    const newCustomerRows = [];
    for (const c of custDocs) {
      if (!inRoute(c.onRoute)) continue;
      if (rx && !(rx.test(c.customerName || '') || rx.test(c.company || '') || rx.test(c.accountNumber || ''))) continue;
      const created = c.createdDate || acctCreated.get(c.customerId);
      if (!created) continue;
      const cd = new Date(created);
      if (Number.isNaN(cd.getTime())) continue;
      if (start && cd < start) continue;
      if (end && cd > end) continue;
      const dk = cd.toISOString().slice(0, 10);
      newCustomerRows.push({ customerId: c.customerId, customer: clean(c.customerName) || clean(c.company) || c.customerId, routeCode: routeOf(c.onRoute), accountNumber: clean(c.accountNumber) || null, createdDate: dk });
      const mk = dk.slice(0, 7);
      newMonthMap.set(mk, (newMonthMap.get(mk) || 0) + 1);
    }
    newCustomerRows.sort((a, b) => String(b.createdDate).localeCompare(String(a.createdDate)));
    const newByMonth = [...newMonthMap.entries()].map(([month, count]) => ({ month, newCustomers: count })).sort((a, b) => a.month.localeCompare(b.month));

    const totalInvoices = rows.reduce((t, r) => t + r.invoices, 0);
    const totalInvoiced = dollars([...custMap.values()].reduce((t, c) => t + c.cents, 0));
    const customers = rows.length;
    return buildEnvelope({
      kpis: {
        customers,
        newCustomers: newCustomerRows.length,
        invoices: totalInvoices,
        invoiced: totalInvoiced,
        avgInvoicesPerCustomer: customers ? round(totalInvoices / customers, 1) : 0,
        avgRevenuePerCustomer: customers ? round(totalInvoiced / customers) : 0,
      },
      topByInvoices: rows.slice(0, 15).map((r) => ({ customer: r.customer, invoices: r.invoices })),
      topByRevenue: rows.slice().sort((a, b) => b.invoiced - a.invoiced).slice(0, 15).map((r) => ({ customer: r.customer, invoiced: r.invoiced })),
      byRoute: byRouteRows,
      months,
      newByMonth,
      newCustomerRows,
      rows,
    }, { meta: { source: 'invoices (actual)', basis: BASIS, from: from || null, to: to || null, routeCode: routeCode || null } });
  });
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
      } catch (e) { void e; }
    }
  } finally { warming = false; }
}

function startWarmer() {
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, TTL_MS - 30000);
}

async function itemFrequency(req, res) {
  const { from, to } = parseParams(req);
  return cached(`itemfreq|${from || ''}|${to || ''}`, res, async () => {
    const { invoices } = await getInputs(from, to);
    const cids = [...new Set(invoices.map((i) => i.customerId))];
    const [accts, storedDocs] = await Promise.all([
      CustomerAccount.find({ customerId: { $in: cids } }, { customerId: 1, pricing: 1 }).lean(),
      InvoiceFrequency.find({ invoiceNumber: { $in: invoices.map((i) => i.invoiceNumber) } }, { invoiceNumber: 1, lines: 1 }).lean(),
    ]);
    const pricingByCid = new Map(accts.map((a) => [a.customerId, a.pricing || []]));
    const storedByInvoice = new Map();
    for (const d of storedDocs) {
      const m = new Map();
      for (const l of d.lines || []) m.set(`${l.item}||${l.rate}`, l.frequency || null);
      storedByInvoice.set(d.invoiceNumber, m);
    }

    const map = new Map();
    const itemKeys = new Set();
    for (const inv of invoices) {
      const pricing = pricingByCid.get(inv.customerId) || [];
      const sm = storedByInvoice.get(inv.invoiceNumber);
      for (const li of inv.lines) {
        const key = itemKey(li.name);
        if (!key) continue;
        itemKeys.add(key);
        const sk = `${clean(li.name) || ''}||${Number(li.rate || 0)}`;
        let freq = sm && sm.has(sk) ? sm.get(sk) : frequencyFor(li, pricing);
        freq = itemFrequencyLabel(freq);
        const gkey = `${key}||${freq}`;
        let r = map.get(gkey);
        if (!r) { r = { item: labelOf(li.name), category: categoryOf(li.name), frequency: freq, occurrences: 0, qty: 0, cents: 0, invoices: new Set(), customers: new Set() }; map.set(gkey, r); }
        r.occurrences += 1;
        r.qty += li.quantity;
        r.cents += li.amountCents;
        if (inv.invoiceNumber) r.invoices.add(inv.invoiceNumber);
        r.customers.add(inv.customerId);
      }
    }

    const rows = [...map.values()].map((r) => ({
      item: r.item,
      category: r.category,
      frequency: r.frequency,
      perYear: round(perYear(r.frequency), 1) || null,
      occurrences: r.occurrences,
      invoices: r.invoices.size,
      customers: r.customers.size,
      qty: round(r.qty, 2),
      invoiced: dollars(r.cents),
    })).sort((a, b) => b.invoiced - a.invoiced);

    const kpis = {
      items: itemKeys.size,
      occurrences: rows.reduce((t, r) => t + r.occurrences, 0),
      invoiced: dollars([...map.values()].reduce((t, r) => t + r.cents, 0)),
      unitemized: dollars(invoices.reduce((t, i) => t + i.unitemized, 0)),
      invoices: new Set(invoices.map((i) => i.invoiceNumber)).size,
    };

    return buildEnvelope({ kpis, rows }, { meta: { source: 'invoices + pricing', basis: 'line items (refreshed from RouteStar where stale)', from: from || null, to: to || null } });
  });
}

module.exports = { byCategory, categoryDetail, byRoute, routeDetail, drill, customersOverview, byCustomer, customerDetail, perStop, itemFrequency, warm, startWarmer, invalidate };
