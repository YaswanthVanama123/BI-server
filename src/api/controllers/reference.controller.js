'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { getPaging, pageMeta, sliceArray } = require('../lib/pagination');
const { getSourceDb } = require('../../config/database');
const { startSync, snapshot } = require('../../services/routestar/accountSyncJob');
const createdDateJob = require('../../services/routestar/createdDateSyncJob');
const { dec } = require('./_dims');

const { CustomerPricingItem, Employee, ServiceCategory, CustomerAccount, SyncRun } = models;

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const toDayKey = (d) => { if (!d) return null; const dt = new Date(d); return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10); };
// RouteStar's source onRoute field is sometimes the literal string "Empty"/"None"/
// "Choose.." — treat those as no value so the actual captured route wins.
const routeToken = (v) => { const s = clean(v); return s && !/^(empty|none|choose)/i.test(s) ? s : null; };

function mapStatus(c) {
  const name = `${c.customerName || ''} ${c.company || ''}`.trim();
  if (/^zzz/i.test(name)) return 'churned';
  if (c.active === false) return 'inactive';
  const s = String(c.status || '').toLowerCase();
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('suspend')) return 'suspended';
  if (s.includes('stop')) return 'stopped';
  if (s.includes('churn')) return 'churned';
  if (s.includes('inactiv')) return 'inactive';
  return 'active';
}

const TTL_MS = 300000;
function makeCache(ttl) {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (e && Date.now() - e.at < ttl) return e.v; if (e) m.delete(k); return null; },
    set(k, v) { m.set(k, { at: Date.now(), v }); if (m.size > 20) m.delete(m.keys().next().value); },
    del(k) { m.delete(k); },
  };
}
const customersCache = makeCache(TTL_MS);
function invalidateCustomers() { customersCache.del('all'); }

async function getAllCustomers() {
  const cached = customersCache.get('all');
  if (cached) return cached;
  const db = getSourceDb();
  const [docs, routeDocs, accts] = await Promise.all([
    db.collection('routestarcustomers').find({}, { projection: { customerId: 1, accountNumber: 1, customerName: 1, company: 1, contact: 1, status: 1, active: 1, onRoute: 1, createdDate: 1, createdAt: 1 } }).batchSize(5000).limit(20000).toArray(),
    db.collection('routestarcustomerroutes').find({}, { projection: { _id: 0, customerId: 1, frequency: 1, routeName: 1 } }).batchSize(5000).toArray(),
    CustomerAccount.find({}, { customerId: 1, routes: 1, accountNumber: 1, createdDate: 1, customerName: 1, company: 1 }).lean(),
  ]);
  const freqByCust = new Map();
  const routeByCust = new Map();
  for (const r of routeDocs) {
    if (r.customerId && r.frequency && !freqByCust.has(r.customerId)) freqByCust.set(r.customerId, r.frequency);
    if (r.customerId && r.routeName && !routeByCust.has(r.customerId)) routeByCust.set(r.customerId, r.routeName);
  }
  const acctRouteByCust = new Map();
  const acctFreqByCust = new Map();
  const acctAccountByCust = new Map();
  const acctCreatedByCust = new Map();
  const acctNameByCust = new Map();
  for (const a of accts) {
    const codes = new Set();
    let freq;
    for (const r of a.routes || []) {
      const rc = clean(r && (r.Route || r.route));
      if (rc) codes.add(String(rc).trim().toUpperCase());
      if (!freq) freq = clean(r && (r.Frequency || r.frequency));
    }
    if (codes.size) acctRouteByCust.set(a.customerId, [...codes].join(', '));
    if (freq) acctFreqByCust.set(a.customerId, freq);
    if (clean(a.accountNumber)) acctAccountByCust.set(a.customerId, clean(a.accountNumber));
    if (a.createdDate) acctCreatedByCust.set(a.customerId, a.createdDate);
    const an = clean(a.customerName) || clean(a.company);
    if (an) acctNameByCust.set(a.customerId, an);
  }
  // Universe = every customer from the source import UNION everyone stored in
  // bi_customeraccounts (which includes customers discovered from the live grid
  // that aren't in the source import yet), so they all appear in the list.
  const docById = new Map(docs.map((c) => [c.customerId, c]));
  const allIds = new Set(docById.keys());
  for (const a of accts) if (a.customerId) allIds.add(a.customerId);
  const data = [...allIds].map((id) => {
    const c = docById.get(id);
    const name = (c && (c.customerName || c.company || c.contact)) || acctNameByCust.get(id) || '(unknown)';
    return {
      _id: id,
      routeStarCustomerId: id,
      routeStarAccountNumber: (c && clean(c.accountNumber)) || acctAccountByCust.get(id) || null,
      customerName: name,
      customerStatus: c ? mapStatus(c) : mapStatus({ customerName: name }),
      routeCode: acctRouteByCust.get(id) || routeByCust.get(id) || routeToken(c && c.onRoute) || null,
      frequency: acctFreqByCust.get(id) || freqByCust.get(id) || null,
      createdDate: (c && toDayKey(c.createdDate)) || toDayKey(acctCreatedByCust.get(id)),
    };
  });
  data.sort((a, b) => String(a.customerName).localeCompare(String(b.customerName)));
  customersCache.set('all', data);
  return data;
}

async function customers(req, res) {
  const status = req.query.customerStatus && req.query.customerStatus !== 'all' ? req.query.customerStatus : null;
  const all = await getAllCustomers();
  let data = status ? all.filter((r) => r.customerStatus === status) : all;
  const term = clean(req.query.q);
  if (term) {
    const t = term.toLowerCase();
    data = data.filter((r) => `${r.customerName} ${r.routeCode || ''} ${r.routeStarAccountNumber || ''}`.toLowerCase().includes(t));
  }
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  if (from || to) {
    const lo = from || to;
    const hi = to || from;
    data = data.filter((r) => r.createdDate && r.createdDate >= lo && r.createdDate <= hi);
  }
  const total = data.length;
  const paging = getPaging(req.query, { defaultPageSize: 50, maxPageSize: 200 });
  const pageRows = sliceArray(data, paging);
  res.json(buildEnvelope(pageRows, { meta: { source: 'inventory_db', total }, page: pageMeta(total, paging, pageRows.length) }));
}

async function warm() {
  try { await getAllCustomers(); } catch (e) {}
}

function startWarmer() {
  setTimeout(() => { warm(); }, 5000);
  setInterval(() => { warm(); }, TTL_MS - 30000);
}

async function customerPricing(req, res) {
  const db = getSourceDb();
  const rows = await db.collection('routestarcustomerpricings').find({ customerId: req.params.id }).toArray();
  if (rows.length) {
    return res.json(buildEnvelope(rows.map((r) => ({
      sourceItemCode: clean(r.itemCode) || clean(r.itemName),
      description: clean(r.itemName),
      cost: undefined,
      salesPrice: Number(r.unitPrice || 0),
      defaultQuantity: 1,
      frequency: clean(r.priceLevel) || 'unknown',
    })), { meta: { source: 'inventory_db' } }));
  }

  const cur = await CustomerPricingItem.find({ tenantId: req.tenantId, customerId: req.params.id, isActive: true }).lean();
  res.json(buildEnvelope(cur.map((r) => ({
    sourceItemCode: r.sourceItemCode, description: r.sourceDescription,
    cost: dec(r.cost), salesPrice: dec(r.salesPrice), defaultQuantity: dec(r.defaultQuantity), frequency: r.normalizedFrequency,
  }))));
}

async function routes(req, res) {
  const db = getSourceDb();
  const [fromRoutes, fromCust] = await Promise.all([
    db.collection('routestarcustomerroutes').distinct('routeName'),
    db.collection('routestarcustomers').distinct('onRoute'),
  ]);
  const codes = [...new Set([...(fromRoutes || []), ...(fromCust || [])]
    .map((c) => String(c || '').trim().toUpperCase()).filter(Boolean))].sort();
  res.json(buildEnvelope(codes.map((code) => ({ routeCode: code, routeName: `Route ${code}`, isActive: true })), { meta: { source: 'inventory_db' } }));
}

async function employees(req, res) {
  const q = { tenantId: req.tenantId };
  if (req.query.department && req.query.department !== 'all') q.department = req.query.department;
  const rows = await Employee.find(q).lean();
  res.json(buildEnvelope(rows.map((e) => ({ _id: e._id, fullName: e.fullName, department: e.department, isTechnician: e.isTechnician }))));
}

async function serviceCategories(req, res) {
  const rows = await ServiceCategory.find({ tenantId: req.tenantId }).sort({ sortOrder: 1, name: 1 }).lean();
  res.json(buildEnvelope(rows.map((c) => ({ _id: c._id, categoryCode: c.categoryCode, name: c.name, isUnmapped: !!c.isUnmapped }))));
}

async function customerAccount(req, res) {
  const id = req.params.id;
  const db = getSourceDb();
  const [acct, cust] = await Promise.all([
    CustomerAccount.findOne({ customerId: id }).lean(),
    db.collection('routestarcustomers').findOne({ customerId: id }),
  ]);

  const service = {
    line1: clean(acct && acct.serviceAddress1) || clean(cust && cust.serviceAddress1) || null,
    line2: clean(acct && acct.serviceAddress2) || clean(cust && cust.serviceAddress2) || null,
    line3: clean(acct && acct.serviceAddress3) || clean(cust && cust.serviceAddress3) || null,
    city: clean(acct && acct.serviceCity) || clean(cust && cust.serviceCity) || null,
    state: clean(acct && acct.serviceState) || clean(cust && cust.serviceState) || null,
    zip: clean(acct && acct.serviceZip) || clean(cust && cust.serviceZip) || null,
    latitude: (acct && acct.latitude != null) ? acct.latitude : (cust && cust.latitude != null ? cust.latitude : null),
    longitude: (acct && acct.longitude != null) ? acct.longitude : (cust && cust.longitude != null ? cust.longitude : null),
    zone: clean(acct && acct.zone) || clean(cust && cust.zone) || null,
  };
  const billing = {
    line1: clean(cust && cust.billingAddress1) || null,
    line2: clean(cust && cust.billingAddress2) || null,
    line3: clean(cust && cust.billingAddress3) || null,
    city: clean(cust && cust.billingCity) || null,
    state: clean(cust && cust.billingState) || null,
    zip: clean(cust && cust.billingZip) || null,
  };

  let pricing = (acct && acct.pricing && acct.pricing.length) ? acct.pricing : null;
  if (!pricing) {
    const rows = await db.collection('routestarcustomerpricings').find({ customerId: id }).toArray();
    pricing = rows.map((r) => ({
      item: clean(r.itemCode) || clean(r.itemName), description: clean(r.itemName),
      cost: null, salesPrice: Number(r.unitPrice || 0), defaultQty: null, frequency: clean(r.priceLevel) || null,
    }));
  }

  let routes = (acct && acct.routes && acct.routes.length) ? acct.routes : null;
  if (!routes) {
    const rows = await db.collection('routestarcustomerroutes').find({ customerId: id }).toArray();
    routes = rows.map((r) => ({
      Route: clean(r.routeName) || clean(r.route), Frequency: clean(r.frequency), Day: clean(r.day),
      'Assigned To': clean(r.assignedTo), Stop: r.stopNumber != null ? r.stopNumber : (r.stop != null ? r.stop : null),
      Category: clean(r.category), 'Start Time': clean(r.startTime),
    }));
  }

  res.json(buildEnvelope({
    customerId: id,
    customerName: clean(acct && acct.customerName) || clean(cust && cust.customerName) || clean(cust && cust.company) || null,
    company: clean(acct && acct.company) || clean(cust && cust.company) || null,
    accountNumber: clean(acct && acct.accountNumber) || clean(cust && cust.accountNumber) || null,
    service,
    billing,
    pricing,
    routes,
    activity: (acct && acct.activity && acct.activity.length) ? acct.activity : [],
    fetchedAt: (acct && acct.fetchedAt) || null,
    source: acct ? 'bi_customeraccounts' : 'inventory_db',
  }));
}

async function accountSync(req, res) {
  const all = req.body && (req.body.all === true || req.body.all === '1' || req.body.all === 'true');
  const result = startSync({ all });
  res.json(buildEnvelope(result, { meta: { source: 'routestar' } }));
}

async function accountSyncStatus(req, res) {
  res.json(buildEnvelope(snapshot()));
}

async function accountFetchRows(req, res) {
  let runId = clean(req.query.runId) || null;
  let run = null;
  if (runId) {
    run = await SyncRun.findById(runId).lean().catch(() => null);
  } else {
    run = await SyncRun.findOne({ type: 'customer-accounts' }).sort({ startedAt: -1 }).lean();
    runId = run ? String(run._id) : null;
  }
  const match = runId ? { lastFetchRunId: runId } : { lastFetchRunId: { $ne: null } };
  const docs = await CustomerAccount.aggregate([
    { $match: match },
    { $project: {
      _id: 0, customerId: 1, customerName: 1, company: 1, accountNumber: 1, status: 1, fetchedAt: 1,
      pricingCount: { $size: { $ifNull: ['$pricing', []] } },
      routesCount: { $size: { $ifNull: ['$routes', []] } },
      activityCount: { $size: { $ifNull: ['$activity', []] } },
    } },
  ]);
  const rows = docs.map((d) => ({
    customerId: d.customerId,
    customerName: clean(d.customerName) || clean(d.company) || '(unknown)',
    accountNumber: clean(d.accountNumber) || null,
    pricingCount: d.pricingCount || 0,
    routesCount: d.routesCount || 0,
    activityCount: d.activityCount || 0,
    status: d.status || null,
    fetchedAt: d.fetchedAt || null,
  }));
  rows.sort((a, b) => String(a.customerName).localeCompare(String(b.customerName)));
  const total = rows.length;
  const paging = getPaging(req.query, { defaultPageSize: 50, maxPageSize: 1000 });
  const pageRows = sliceArray(rows, paging);
  res.json(buildEnvelope(pageRows, {
    meta: { runId, run: run ? { startedAt: run.startedAt, finishedAt: run.finishedAt, status: run.status, summary: run.summary } : null, total },
    page: pageMeta(total, paging, pageRows.length),
  }));
}

async function deleteAllAccounts(req, res) {
  const snap = snapshot();
  if (snap && snap.running) {
    const e = new Error('A customer fetch is currently running — wait for it to finish before deleting.');
    e.status = 409; e.code = 'SYNC_RUNNING';
    throw e;
  }
  const r = await CustomerAccount.deleteMany({});
  invalidateCustomers();
  res.json(buildEnvelope({ deleted: (r && r.deletedCount) || 0 }, { meta: { source: 'bi_customeraccounts' } }));
}

async function createdDateSync(req, res) {
  const all = req.body && (req.body.all === true || req.body.all === '1' || req.body.all === 'true');
  const result = createdDateJob.startSync({ all });
  res.json(buildEnvelope(result, { meta: { source: 'routestar' } }));
}

async function createdDateSyncStatus(req, res) {
  res.json(buildEnvelope(createdDateJob.snapshot()));
}

module.exports = { customers, customerPricing, customerAccount, accountSync, accountSyncStatus, accountFetchRows, deleteAllAccounts, createdDateSync, createdDateSyncStatus, routes, employees, serviceCategories, warm, startWarmer, invalidateCustomers };
