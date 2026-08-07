'use strict';
const { models } = require('../../models');
const { buildEnvelope } = require('../lib/envelope');
const { getPaging, pageMeta, sliceArray } = require('../lib/pagination');
const { getSourceDb } = require('../../config/database');
const { inFilterRange } = require('../lib/checkoutDate');
const { frequencyFor } = require('../../services/pricingMatch');

const { CustomerAccount, CompanyDistance, InvoiceFrequency, Tenant } = models;
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
function activityDateKey(ts) {
  const m = String(ts || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}
const customerIdFromLink = (link) => { const m = String(link || '').match(/customerdetail\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]) : null; };
const categoryOf = (item) => { const s = clean(item) || ''; return s.includes(':') ? s.split(':')[0].trim() : (s || null); };

function toMinutes(s) {
  const m = String(s || '').trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}
function dateBound(dk, days) { const d = new Date(`${dk}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d; }
function datePrefilter(from, to) {
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = dateBound(from, -2);
  if (to) range.$lte = dateBound(to, 2);
  return { dateCompleted: range };
}
function servicePhaseFor(freq) {
  const s = String(freq || '').toLowerCase().replace(/[\s_-]/g, '').replace(/\./g, '');
  if (!s || s.startsWith('choose') || s.includes('onetime')) return 'One-time';
  return 'Recurring';
}
function representativeFreq(lineItems, storedMap, pricing) {
  const counts = new Map();
  for (const li of lineItems || []) {
    const sk = `${clean(li.name) || ''}||${Number(li.rate || 0)}`;
    let f = storedMap && storedMap.has(sk) ? storedMap.get(sk) : frequencyFor(li, pricing);
    f = clean(f) || null;
    if (!f) continue;
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  let best = null; let bestN = 0;
  for (const [f, n] of counts) if (n > bestN) { best = f; bestN = n; }
  return best;
}
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
function makeCache() {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (e && Date.now() - e.at < TTL_MS) return e.v; if (e) m.delete(k); return null; },
    set(k, v) { m.set(k, { at: Date.now(), v }); if (m.size > 40) m.delete(m.keys().next().value); },
  };
}
const payloadCache = makeCache();

async function tenantId() {
  const env = require('../../config/env');
  const t = await Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  return t ? t._id : null;
}

async function pairMapFor(tid, names) {
  const map = new Map();
  if (!tid) return map;
  const q = { tenantId: tid, drivingMinutes: { $ne: null } };
  if (Array.isArray(names) && names.length) { q.fromCompany = { $in: names }; q.toCompany = { $in: names }; }
  const pairs = await CompanyDistance.find(q, { fromCompany: 1, toCompany: 1, drivingMinutes: 1, distanceMiles: 1 }).lean();
  for (const p of pairs) {
    const a = normName(p.fromCompany); const b = normName(p.toCompany);
    if (!map.has(`${a}||${b}`)) map.set(`${a}||${b}`, p);
    if (!map.has(`${b}||${a}`)) map.set(`${b}||${a}`, p);
  }
  return map;
}

async function buildRows(from, to) {
  const db = getSourceDb();
  const and = [CLOSED];
  const pre = datePrefilter(from, to);
  if (pre) and.push(pre);
  const invoices = (await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: { _id: 0, invoiceNumber: 1, 'customer.name': 1, 'customer.link': 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1, total: 1, serviceNotes: 1, 'invoiceDetails.serviceNotes': 1, 'lineItems.name': 1, 'lineItems.description': 1, 'lineItems.rate': 1 } })
    .batchSize(5000)
    .limit(50000).toArray()).filter((inv) => inFilterRange(inv, from, to));

  const invNums = invoices.map((i) => i.invoiceNumber).filter(Boolean);
  const [accts, custDocs, storedDocs, tid] = await Promise.all([
    CustomerAccount.find({}, { customerId: 1, serviceAddress1: 1, serviceAddress2: 1, serviceAddress3: 1, serviceCity: 1, serviceState: 1, serviceZip: 1, pricing: 1, routes: 1, activity: { $slice: 1 } }).lean(),
    db.collection('routestarcustomers').find({}, { projection: { customerId: 1, customerName: 1, company: 1, status: 1, active: 1 } }).batchSize(5000).limit(20000).toArray(),
    InvoiceFrequency.find({ invoiceNumber: { $in: invNums } }, { invoiceNumber: 1, lines: 1 }).lean(),
    tenantId(),
  ]);
  const acctById = new Map(accts.map((a) => [a.customerId, a]));
  const statusById = new Map();
  for (const c of custDocs) if (c.customerId) statusById.set(c.customerId, mapStatus(c));
  const storedByInvoice = new Map();
  for (const d of storedDocs) { const m = new Map(); for (const l of d.lines || []) m.set(`${l.item}||${l.rate}`, l.frequency || null); storedByInvoice.set(d.invoiceNumber, m); }

  const stops = invoices.map((inv) => {
    const cid = customerIdFromLink(inv.customer && inv.customer.link) || null;
    const rc = clean(inv.assignedTo) ? String(inv.assignedTo).trim().toUpperCase() : '(unassigned)';
    const dk = dayKey(inv.dateCompleted || inv.invoiceDate);
    const cats = [...new Set((inv.lineItems || []).map((li) => categoryOf(li.name)).filter(Boolean))];
    return {
      cid, rc, dk,
      arrMin: toMinutes(inv.arrivalTime),
      depMin: toMinutes(inv.departureTime),
      customerName: (inv.customer && inv.customer.name) || '',
      invoiceNumber: inv.invoiceNumber,
      arrivalTime: clean(inv.arrivalTime) || null,
      departureTime: clean(inv.departureTime) || null,
      total: Number(inv.total || 0),
      serviceNotes: clean(inv.serviceNotes) || clean(inv.invoiceDetails && inv.invoiceDetails.serviceNotes) || null,
      categories: cats,
      lineItems: inv.lineItems || [],
    };
  });

  const names = [...new Set(stops.map((s) => s.customerName).filter(Boolean))];
  const pairMap = await pairMapFor(tid, names);

  const byRouteDay = new Map();
  for (const s of stops) { const k = `${s.rc}||${s.dk}`; if (!byRouteDay.has(k)) byRouteDay.set(k, []); byRouteDay.get(k).push(s); }
  for (const arr of byRouteDay.values()) {
    arr.sort((a, b) => (a.arrMin ?? a.depMin ?? 1e9) - (b.arrMin ?? b.depMin ?? 1e9));
    for (let i = 0; i < arr.length; i++) {
      arr[i].seq = i + 1;
      if (i > 0) {
        const prev = arr[i - 1];
        const pair = pairMap.get(`${normName(prev.customerName)}||${normName(arr[i].customerName)}`);
        arr[i].travelMinutes = pair && pair.drivingMinutes != null ? pair.drivingMinutes : null;
        arr[i].travelMiles = pair && pair.distanceMiles != null ? pair.distanceMiles : null;
      }
    }
  }

  const rows = stops.map((s) => {
    const a = s.cid ? acctById.get(s.cid) : null;
    let serviceAddress = null; let billingAmount = null;
    const pricing = a ? (a.pricing || []) : [];
    if (a) {
      const cityLine = [a.serviceCity, a.serviceState, a.serviceZip].filter(Boolean).join(', ');
      serviceAddress = [a.serviceAddress1, a.serviceAddress2, a.serviceAddress3, cityLine].filter(Boolean).join(', ') || null;
      const prices = pricing.map((p) => Number(p.salesPrice || 0)).filter((x) => x > 0);
      if (prices.length) billingAmount = round(prices.reduce((t, x) => t + x, 0));
    }
    let frequency = representativeFreq(s.lineItems, storedByInvoice.get(s.invoiceNumber), pricing);
    if (!frequency && a) {
      for (const r of a.routes || []) { const f = clean(r && (r.Frequency || r.frequency)); if (f) { frequency = f; break; } }
      if (!frequency) { for (const p of pricing) { const f = clean(p.frequency); if (f) { frequency = f; break; } } }
    }
    return {
      serviceDate: s.dk,
      stopId: s.invoiceNumber,
      customerId: s.cid,
      customerName: s.customerName,
      serviceAddress,
      routeId: s.rc,
      stopSequence: s.seq,
      technicianId: s.rc,
      serviceNotes: s.serviceNotes,
      checkIn: s.arrivalTime,
      checkOut: s.departureTime,
      travelMinutes: s.travelMinutes != null ? s.travelMinutes : null,
      travelMiles: s.travelMiles != null ? s.travelMiles : null,
      serviceCategory: s.categories.join(', ') || null,
      serviceFrequency: frequency,
      servicePhase: servicePhaseFor(frequency),
      revenueAmount: round(s.total),
      chemicalSupplyCost: null,
      accountStatus: s.cid ? (statusById.get(s.cid) || null) : null,
      statusDate: (a && a.activity && a.activity[0]) ? activityDateKey(a.activity[0].timestamp) : null,
      billingCadence: frequency,
      billingAmount,
    };
  });
  rows.sort((a, b) => String(b.serviceDate || '').localeCompare(String(a.serviceDate || ''))
    || String(a.routeId).localeCompare(String(b.routeId))
    || (a.stopSequence - b.stopSequence));
  return rows;
}

async function dataPull(req, res) {
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  const key = `pull|${from || ''}|${to || ''}`;
  let rows = payloadCache.get(key);
  if (!rows) { rows = await buildRows(from, to); payloadCache.set(key, rows); }

  const paging = getPaging(req.query, { defaultPageSize: 50, maxPageSize: 500 });
  const total = rows.length;
  const pageRows = sliceArray(rows, paging);
  res.set('X-Cache', 'MISS');
  res.json(buildEnvelope(pageRows, {
    meta: { source: 'inventory_db + bi_customeraccounts + bi_companydistances', from: from || null, to: to || null, total },
    page: pageMeta(total, paging, pageRows.length),
  }));
}

module.exports = { dataPull };
