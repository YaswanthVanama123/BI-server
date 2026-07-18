'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { getSourceDb } = require('../../config/database');
const { startSync, snapshot } = require('../../services/routestar/accountSyncJob');
const { dec } = require('./_dims');

const { CustomerPricingItem, Employee, ServiceCategory, CustomerAccount } = models;

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };

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

async function customers(req, res) {
  const db = getSourceDb();
  const status = req.query.customerStatus && req.query.customerStatus !== 'all' ? req.query.customerStatus : null;
  const [docs, routeDocs, accts] = await Promise.all([
    db.collection('routestarcustomers').find({}).limit(20000).toArray(),
    db.collection('routestarcustomerroutes').find({}, { projection: { customerId: 1, frequency: 1, routeName: 1 } }).toArray(),
    CustomerAccount.find({}, { customerId: 1, routes: 1 }).lean(),
  ]);
  const freqByCust = new Map();
  const routeByCust = new Map();
  for (const r of routeDocs) {
    if (r.customerId && r.frequency && !freqByCust.has(r.customerId)) freqByCust.set(r.customerId, r.frequency);
    if (r.customerId && r.routeName && !routeByCust.has(r.customerId)) routeByCust.set(r.customerId, r.routeName);
  }
  const acctRouteByCust = new Map();
  const acctFreqByCust = new Map();
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
  }
  let data = docs.map((c) => ({
    _id: c.customerId,
    routeStarCustomerId: c.customerId,
    routeStarAccountNumber: clean(c.accountNumber) || null,
    customerName: c.customerName || c.company || c.contact || '(unknown)',
    customerStatus: mapStatus(c),
    routeCode: clean(c.onRoute) || routeByCust.get(c.customerId) || acctRouteByCust.get(c.customerId) || null,
    frequency: freqByCust.get(c.customerId) || acctFreqByCust.get(c.customerId) || null,
  }));
  if (status) data = data.filter((r) => r.customerStatus === status);
  data.sort((a, b) => String(a.customerName).localeCompare(String(b.customerName)));
  res.json(buildEnvelope(data, { meta: { source: 'inventory_db' }, page: { page: 1, pageSize: data.length, total: data.length } }));
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

module.exports = { customers, customerPricing, customerAccount, accountSync, accountSyncStatus, routes, employees, serviceCategories };
