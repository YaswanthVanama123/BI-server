'use strict';
const { models } = require('../../models');
const { getSourceDb, getEnviromasterDb } = require('../../config/database');
const { getLeg, geocode } = require('./mapboxService');
const logger = require('../../utils/logger');

const { RouteDriveLeg, CompanyDistance } = models;
const log = logger.child('drive-time');
const CLOSED = { $or: [{ invoiceType: 'closed' }, { status: { $in: ['Closed', 'Completed'] } }] };

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const round = (n, d = 1) => { const f = 10 ** d; return Math.round(n * f) / f; };
function toMinutes(s) {
  const m = String(s || '').trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}
function customerIdFromLink(link) { const m = String(link || '').match(/customerdetail\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]) : null; }
function validCoord(c) { return Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && !(c[0] === 0 && c[1] === 0); }
function coordOf(c) {
  const lat = Number(c && c.latitude); const lng = Number(c && c.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}
const sameCoord = (a, b) => validCoord(a) && validCoord(b) && Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
function buildAddress(c) {
  const line = clean(c.serviceAddress1) || clean(c.billingAddress1);
  const city = clean(c.serviceCity) || clean(c.billingCity);
  const state = clean(c.serviceState) || clean(c.billingState);
  const zip = clean(c.serviceZip) || clean(c.billingZip);
  return [line, city, state, zip].filter(Boolean).join(', ');
}

async function discover(tenant, { from, to, registerPairs = true } = {}) {
  const db = getSourceDb();
  const and = [CLOSED];
  if (from || to) {
    const start = new Date(`${from || to}T00:00:00.000Z`);
    const end = new Date(`${to || from}T23:59:59.999Z`);
    and.push({ $or: [{ dateCompleted: { $gte: start, $lte: end } }, { invoiceDate: { $gte: start, $lte: end } }] });
  }
  const invoices = await db.collection('routestarinvoices')
    .find({ $and: and }, { projection: { invoiceNumber: 1, customer: 1, assignedTo: 1, dateCompleted: 1, invoiceDate: 1, arrivalTime: 1, departureTime: 1 } })
    .limit(50000).toArray();

  const custIds = [...new Set(invoices.map((i) => customerIdFromLink(i.customer && i.customer.link)).filter(Boolean))];
  const custs = await db.collection('routestarcustomers')
    .find({ customerId: { $in: custIds } }, { projection: { customerId: 1, latitude: 1, longitude: 1 } }).toArray();
  const custMap = new Map(custs.map((c) => [c.customerId, c]));

  const stops = [];
  for (const inv of invoices) {
    const cid = customerIdFromLink(inv.customer && inv.customer.link);
    const cust = cid ? custMap.get(cid) : null;
    const dk = dayKey(inv.dateCompleted || inv.invoiceDate);
    if (!dk) continue;
    stops.push({
      invoiceNumber: inv.invoiceNumber, dateKey: dk,
      routeCode: clean(inv.assignedTo) ? String(inv.assignedTo).trim().toUpperCase() : '(unassigned)',
      customerId: cid, customer: (inv.customer && inv.customer.name) || '',
      arrMin: toMinutes(inv.arrivalTime), depMin: toMinutes(inv.departureTime),
      arrival: clean(inv.arrivalTime), departure: clean(inv.departureTime),
      coord: cust ? coordOf(cust) : null,
    });
  }

  const groups = new Map();
  for (const s of stops) { const k = `${s.routeCode}||${s.dateKey}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }

  const now = new Date();
  const legOps = [];
  const pairOps = [];
  const pairSeen = new Set();
  for (const arr of groups.values()) {
    arr.sort((a, b) => (a.arrMin ?? a.depMin ?? 1e9) - (b.arrMin ?? b.depMin ?? 1e9));
    for (let i = 0; i < arr.length - 1; i++) {
      const cur = arr[i]; const nxt = arr[i + 1];
      let status = 'ok'; let observedGap = null;
      if (cur.depMin == null || nxt.arrMin == null) status = 'missing_times';
      else { observedGap = nxt.arrMin - cur.depMin; if (observedGap < 0) status = 'negative_gap'; }
      legOps.push({
        updateOne: {
          filter: { tenantId: tenant._id, dateKey: cur.dateKey, routeCode: cur.routeCode, fromInvoiceNumber: cur.invoiceNumber, toInvoiceNumber: nxt.invoiceNumber },
          update: { $set: {
            tenantId: tenant._id, dateKey: cur.dateKey, routeCode: cur.routeCode,
            fromInvoiceNumber: cur.invoiceNumber, toInvoiceNumber: nxt.invoiceNumber,
            fromCustomer: cur.customer, toCustomer: nxt.customer, fromCustomerId: cur.customerId, toCustomerId: nxt.customerId,
            fromDeparture: cur.departure, toArrival: nxt.arrival, fromCoord: cur.coord || undefined, toCoord: nxt.coord || undefined,
            observedGapMinutes: observedGap != null ? round(observedGap, 1) : undefined, status, computedAt: now,
          } },
          upsert: true,
        },
      });
      if (registerPairs && cur.customerId && nxt.customerId) {
        const pk = `${cur.customerId}||${nxt.customerId}`;
        if (!pairSeen.has(pk)) {
          pairSeen.add(pk);
          pairOps.push({
            updateOne: {
              filter: { tenantId: tenant._id, fromCustomerId: cur.customerId, toCustomerId: nxt.customerId },

              update: {
                $setOnInsert: { tenantId: tenant._id, fromCustomerId: cur.customerId, toCustomerId: nxt.customerId, status: 'pending', drivingMinutes: null, distanceMiles: null },
                $set: { fromCompany: cur.customer, toCompany: nxt.customer, fromCoord: cur.coord || undefined, toCoord: nxt.coord || undefined },
              },
              upsert: true,
            },
          });
        }
      }
    }
  }
  const delFilter = { tenantId: tenant._id };
  if (from || to) delFilter.dateKey = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  await RouteDriveLeg.deleteMany(delFilter);
  await bulkInChunks(RouteDriveLeg, legOps);
  if (registerPairs) await bulkInChunks(CompanyDistance, pairOps);
  return { legs: legOps.length, pairs: pairOps.length, groups: groups.size };
}

async function bulkInChunks(Model, ops, size = 1000) {
  for (let i = 0; i < ops.length; i += size) {
    await Model.bulkWrite(ops.slice(i, i + size), { ordered: false });
  }
}

const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function addrOf(c) {
  return [clean(c && c.address), clean(c && c.city), clean(c && c.state), clean(c && c.zipCode)].filter(Boolean).join(', ');
}
async function discoverFromMapDistance(tenant, { limit = 500000 } = {}) {
  const db = await getEnviromasterDb();
  const records = await db.collection('mapdistancerecords')
    .find({}, { projection: { customerId: 1, destinationCustomerName: 1, distanceMiles: 1 } })
    .limit(limit).toArray();
  const custs = await db.collection('routestarcustomers')
    .find({}, { projection: { routeStarId: 1, name: 1, company: 1, address: 1, city: 1, state: 1, zipCode: 1 } })
    .toArray();
  const byObjId = new Map();
  const byName = new Map();
  for (const c of custs) {
    byObjId.set(String(c._id), c);
    const n = normName(c.name); const co = normName(c.company);
    if (n && !byName.has(n)) byName.set(n, c);
    if (co && !byName.has(co)) byName.set(co, c);
  }

  const pairs = new Map();
  let matchedSource = 0; let unresolvedDest = 0;
  for (const r of records) {
    const srcId = r.customerId != null ? String(r.customerId) : '';
    const destName = clean(r.destinationCustomerName);
    if (!srcId || !destName) continue;
    const src = byObjId.get(srcId) || null;
    const dest = byName.get(normName(destName)) || null;
    const fromId = src ? (clean(src.routeStarId) || String(src._id)) : srcId;
    const toId = dest ? (clean(dest.routeStarId) || String(dest._id)) : `name:${normName(destName)}`;
    if (fromId === toId) continue;
    const pk = `${fromId}||${toId}`;
    const dist = Number.isFinite(r.distanceMiles) ? round(r.distanceMiles, 2) : null;
    let p = pairs.get(pk);
    if (!p) {
      p = {
        fromId, toId,
        fromCompany: (src && (clean(src.company) || clean(src.name))) || fromId,
        toCompany: destName,
        fromAddress: src ? addrOf(src) : '',
        toAddress: dest ? addrOf(dest) : '',
        dist,
      };
      pairs.set(pk, p);
      if (src) matchedSource += 1;
      if (!dest) unresolvedDest += 1;
    } else if (p.dist == null && dist != null) {
      p.dist = dist;
    }
  }

  const pairOps = [];
  for (const p of pairs.values()) {
    pairOps.push({
      updateOne: {
        filter: { tenantId: tenant._id, fromCustomerId: p.fromId, toCustomerId: p.toId },

        update: {
          $setOnInsert: { tenantId: tenant._id, fromCustomerId: p.fromId, toCustomerId: p.toId, status: 'pending', drivingMinutes: null },
          $set: {
            fromCompany: p.fromCompany, toCompany: p.toCompany, source: 'mapdistance',
            fromAddress: p.fromAddress || undefined, toAddress: p.toAddress || undefined,
            ...(p.dist != null ? { distanceMiles: p.dist } : {}),
          },
        },
        upsert: true,
      },
    });
  }
  await bulkInChunks(CompanyDistance, pairOps);
  const result = { records: records.length, customers: custs.length, pairs: pairOps.length, matchedSource, unresolvedDest };
  log.info(`discover(mapdistance): ${JSON.stringify(result)}`);
  return result;
}

async function syncDrivingTimes(tenant, { limit = 5000 } = {}) {
  const pending = await CompanyDistance.find({ tenantId: tenant._id, status: 'pending' }).limit(limit).lean();
  if (!pending.length) return { processed: 0, synced: 0, failed: 0, geocoded: 0, remaining: 0 };

  const needCoord = new Set();
  for (const p of pending) { if (!validCoord(p.fromCoord)) needCoord.add(p.fromCustomerId); if (!validCoord(p.toCoord)) needCoord.add(p.toCustomerId); }
  const custById = new Map();
  if (needCoord.size) {
    const db = getSourceDb();
    const custs = await db.collection('routestarcustomers').find(
      { customerId: { $in: [...needCoord] } },
      { projection: { customerId: 1, latitude: 1, longitude: 1, serviceAddress1: 1, serviceCity: 1, serviceState: 1, serviceZip: 1, billingAddress1: 1, billingCity: 1, billingState: 1, billingZip: 1 } },
    ).toArray();
    for (const c of custs) custById.set(c.customerId, c);
  }

  const geoCache = new Map();
  let geocoded = 0;
  async function coordFor(custId, stored, address) {
    if (validCoord(stored)) return stored;
    const cacheKey = custId || address;
    if (cacheKey && geoCache.has(cacheKey)) return geoCache.get(cacheKey);
    let coord = null;

    if (address) { try { coord = await geocode(address); if (coord) geocoded += 1; } catch { coord = null; } }

    if (!coord && custById.has(custId)) {
      const c = custById.get(custId);
      coord = coordOf(c);
      if (!coord) { const addr = buildAddress(c); if (addr) { try { coord = await geocode(addr); if (coord) geocoded += 1; } catch { coord = null; } } }
    }
    if (cacheKey) geoCache.set(cacheKey, coord);
    return coord;
  }

  const now = new Date();
  let synced = 0; let failed = 0;
  for (const p of pending) {
    const fromCoord = await coordFor(p.fromCustomerId, p.fromCoord, p.fromAddress);
    const toCoord = await coordFor(p.toCustomerId, p.toCoord, p.toAddress);
    let status = 'ok'; let driving = null; let dist = null; let hash;
    if (!validCoord(fromCoord) || !validCoord(toCoord)) status = 'missing_coords';
    else if (sameCoord(fromCoord, toCoord)) { status = 'same_location'; driving = 0; dist = 0; }
    else {
      try { const m = await getLeg({ from: fromCoord, to: toCoord, profile: 'driving', now }); driving = round(m.durationMinutes, 1); dist = round(m.distanceMiles, 2); hash = m.requestHash; }
      catch (e) { status = 'mapbox_failed'; }
    }

    const keepDist = p.source === 'mapdistance' && p.distanceMiles != null ? p.distanceMiles : dist;
    await CompanyDistance.updateOne(
      { _id: p._id },
      { $set: { fromCoord: validCoord(fromCoord) ? fromCoord : undefined, toCoord: validCoord(toCoord) ? toCoord : undefined, drivingMinutes: driving, distanceMiles: keepDist, status, mapboxRequestHash: hash, syncedAt: now } },
    );
    if (status === 'ok' || status === 'same_location') synced += 1; else failed += 1;
  }
  const remaining = await CompanyDistance.countDocuments({ tenantId: tenant._id, status: 'pending' });
  log.info(`sync: ${synced} synced, ${failed} failed, ${geocoded} geocoded, ${remaining} still pending`);
  return { processed: pending.length, synced, failed, geocoded, remaining };
}

module.exports = { discover, discoverFromMapDistance, syncDrivingTimes };
