'use strict';
const { models } = require('../../models');
const { dqIssue } = require('../importBatchRunner');
const { toMoney, moneyToNum, periodKeys, zonedWallClockToUtc, diffMinutes, pad } = require('../../utils/util');

const {
  Customer, Employee, ServiceCategory, ItemCategoryMapping, ServiceItem, Invoice, InvoiceLineItem, ServiceVisit,
} = models;

const cache = { unmappedCatId: null, catByCode: new Map(), empByName: new Map(), catMappingsLoaded: false, mappings: [] };

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const norm = (v) => String(v || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
function dqStatus(dq) {
  if (dq.some((d) => d.severity === 'error' || d.severity === 'critical')) return 'error';
  if (dq.length) return 'warning';
  return 'clean';
}
function sourceStage(sourceRecordId, sourceEntity, recordHash, batchId, now, status) {
  return {
    sourceSystem: 'routestar', sourceRecordId, sourceEntity,
    importedAt: { $ifNull: ['$source.importedAt', now] },
    lastSyncedAt: now, importBatchId: batchId, recordHash,
    syncStatus: { $cond: [{ $ifNull: ['$source.recordHash', false] }, 'updated', 'inserted'] },
    dataQualityStatus: status,
  };
}
function parseElapsedMin(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  if (s.includes(':')) { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0); }
  const n = Number(s); return Number.isNaN(n) ? undefined : n;
}
function timeParts(timeStr) {
  const m = String(timeStr || '').trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return { h, mi };
}

function combine(serviceDate, timeStr, tz) {
  if (!serviceDate || !timeStr) return { utc: undefined, local: undefined };
  const { dateKey } = periodKeys(serviceDate, tz);
  const [y, mo, d] = dateKey.split('-').map(Number);
  const tp = timeParts(timeStr);
  if (!tp) return { utc: undefined, local: undefined };
  return { utc: zonedWallClockToUtc(y, mo, d, tp.h, tp.mi, tz), local: `${dateKey}T${pad(tp.h)}:${pad(tp.mi)}:00` };
}
function customerIdFromLink(link) {
  const m = String(link || '').match(/customerdetail\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : '';
}
function mapInvoiceType(row) {
  if (moneyToNum(toMoney(row.total)) < 0) return 'credit';
  return 'unknown';
}

async function ensureUnmapped(tenantId) {
  if (cache.unmappedCatId) return cache.unmappedCatId;
  const cat = await ServiceCategory.findOne({ tenantId, isUnmapped: true }, { _id: 1 }).lean();
  if (!cat) { const e = new Error('No UNMAPPED service category — run `npm run seed` first.'); e.fatal = true; throw e; }
  cache.unmappedCatId = cat._id;
  return cat._id;
}
async function resolveCategory(tenantId, sourceItemCode) {
  const code = clean(sourceItemCode);
  if (code && cache.catByCode.has(code)) return cache.catByCode.get(code);
  if (!cache.catMappingsLoaded) {
    cache.mappings = await ItemCategoryMapping.find({ tenantId, isActive: true, matchType: 'exact_code' }, { matchValue: 1, serviceCategoryId: 1 }).lean();
    cache.catMappingsLoaded = true;
  }
  const hit = code && cache.mappings.find((m) => m.matchValue === code);
  const id = hit ? hit.serviceCategoryId : await ensureUnmapped(tenantId);
  if (code) cache.catByCode.set(code, id);
  return id;
}
async function resolveServiceItemId(tenantId, code) {
  const c = clean(code);
  if (!c) return undefined;
  const it = await ServiceItem.findOne({ tenantId, itemCode: c }, { _id: 1 }).lean();
  return it ? it._id : undefined;
}

async function resolveCustomer(tenant, row, now, batch, dq) {
  const rsId = customerIdFromLink(row.customer && row.customer.link);
  const name = clean(row.customer && row.customer.name) || '(unknown)';
  if (rsId) {
    let c = await Customer.findOne({ tenantId: tenant._id, routeStarCustomerId: rsId }, { _id: 1, defaultRouteId: 1, primaryLocationId: 1 }).lean();
    if (!c) {
      await Customer.updateOne(
        { tenantId: tenant._id, routeStarCustomerId: rsId },
        [{ $set: {
          tenantId: tenant._id, routeStarCustomerId: rsId, customerName: name,
          customerStatus: 'unknown', customerStatusEffectiveAt: { $ifNull: ['$customerStatusEffectiveAt', now] },
          source: sourceStage(rsId, 'customer_shell', 'shell', batch._id, now, 'warning'),
        } }], { upsert: true },
      );
      c = await Customer.findOne({ tenantId: tenant._id, routeStarCustomerId: rsId }, { _id: 1, defaultRouteId: 1, primaryLocationId: 1 }).lean();
    }
    return c;
  }

  dq.push(dqIssue(tenant, batch, 'missing_customer_ref', 'warning', 'invoices', null, row.invoiceNumber, 'routestar', `Invoice ${row.invoiceNumber} has no customer link`, now, { name }));
  const synthetic = `NAME:${norm(name)}`;
  await Customer.updateOne(
    { tenantId: tenant._id, routeStarCustomerId: synthetic },
    [{ $set: { tenantId: tenant._id, routeStarCustomerId: synthetic, customerName: name, customerStatus: 'unknown', customerStatusEffectiveAt: { $ifNull: ['$customerStatusEffectiveAt', now] }, source: sourceStage(synthetic, 'customer_shell', 'shell', batch._id, now, 'warning') } }],
    { upsert: true },
  );
  return Customer.findOne({ tenantId: tenant._id, routeStarCustomerId: synthetic }, { _id: 1, defaultRouteId: 1, primaryLocationId: 1 }).lean();
}

async function resolveTechnician(tenant, assignedTo, now, batch) {
  const name = clean(assignedTo);
  if (!name) return null;
  const key = norm(name);
  if (cache.empByName.has(key)) return cache.empByName.get(key);
  const code = `RS:${key}`;
  let emp = await Employee.findOne({ tenantId: tenant._id, employeeCode: code }, { _id: 1 }).lean();
  if (!emp) {
    await Employee.updateOne(
      { tenantId: tenant._id, employeeCode: code },
      { $set: { tenantId: tenant._id, employeeCode: code, fullName: name, isTechnician: true, employmentType: 'hourly', status: 'active', routeStarTechId: name } },
      { upsert: true },
    );
    emp = await Employee.findOne({ tenantId: tenant._id, employeeCode: code }, { _id: 1 }).lean();
  }
  cache.empByName.set(key, emp._id);
  return emp._id;
}

module.exports = {
  name: 'inventory_closed_invoices',
  sourceSystem: 'routestar',
  sourceEntity: 'closed_invoice',
  rawModel: models.RawRouteStarInvoices,

  getSourceRecordId(row) { return String(row.invoiceNumber || '').trim(); },

  async processRecord(row, ctx) {
    const { tenant, batch, now, sourceRecordId, recordHash, rawUnchanged } = ctx;
    const tz = tenant.reportingTimezone;
    const dq = [];
    if (!sourceRecordId) return { syncStatus: 'rejected', curatedTouches: {}, dq: [] };
    if (rawUnchanged && await Invoice.exists({ tenantId: tenant._id, invoiceNumber: sourceRecordId })) {
      return { syncStatus: 'unchanged', curatedTouches: {}, dq: [] };
    }

    const serviceDate = row.dateCompleted || row.invoiceDate;
    const keys = periodKeys(serviceDate, tz);
    const arrival = combine(serviceDate, row.arrivalTime, tz);
    const departure = combine(serviceDate, row.departureTime, tz);

    const customer = await resolveCustomer(tenant, row, now, batch, dq);
    const technicianId = await resolveTechnician(tenant, row.assignedTo, now, batch);
    if (row.assignedTo && !technicianId) {  }

    const routeId = customer && customer.defaultRouteId ? customer.defaultRouteId : undefined;
    const attributionMethod = routeId ? 'customer_default' : 'unassigned';

    const sourceElapsed = parseElapsedMin(row.elapsedTime);
    const calcElapsed = diffMinutes(departure.utc, arrival.utc);
    let elapsedStatus = 'ok';
    let duration;
    if (!arrival.utc || !departure.utc) elapsedStatus = 'missing_times';
    else if (calcElapsed < 0) { elapsedStatus = 'negative'; dq.push(dqIssue(tenant, batch, 'departure_before_arrival', 'error', 'serviceVisits', null, sourceRecordId, 'routestar', `Departure before arrival on ${sourceRecordId}`, now)); }
    else { duration = calcElapsed; const tol = 10; if (sourceElapsed != null && Math.abs(sourceElapsed - calcElapsed) > tol) { elapsedStatus = 'variance'; dq.push(dqIssue(tenant, batch, 'elapsed_time_variance', 'warning', 'serviceVisits', null, sourceRecordId, 'routestar', `Source elapsed ${sourceElapsed}m vs calculated ${calcElapsed}m on ${sourceRecordId}`, now)); } }

    const status = String(row.status || '') === 'Cancelled' ? 'void' : 'closed';
    const isRevenue = status !== 'void';
    const subtotal = toMoney(row.subtotal);
    const total = toMoney(row.total);
    const lineItems = Array.isArray(row.lineItems) ? row.lineItems : [];
    const lineTotal = lineItems.reduce((s, li) => s + moneyToNum(toMoney(li.amount)), 0);
    const totalVariance = moneyToNum(total) - lineTotal;
    const reconciliationStatus = lineItems.length === 0 ? 'no_lines' : (Math.abs(totalVariance) > 0.01 ? 'variance' : 'ok');
    if (reconciliationStatus === 'variance') dq.push(dqIssue(tenant, batch, 'invoice_total_mismatch', 'error', 'invoices', null, sourceRecordId, 'routestar', `Total ${moneyToNum(total)} != Σlines ${lineTotal.toFixed(2)} on ${sourceRecordId}`, now));

    await Invoice.updateOne(
      { tenantId: tenant._id, invoiceNumber: sourceRecordId },
      [{ $set: {
        tenantId: tenant._id, invoiceNumber: sourceRecordId,
        customerId: customer && customer._id,
        invoiceType: mapInvoiceType(row), status,
        invoiceDate: row.invoiceDate, dateCompleted: row.dateCompleted,
        enteredBy: clean(row.enteredBy), assignedToEmployeeId: technicianId, routeId,
        customerGrouping: clean(row.customerGrouping),
        subtotal, taxTotal: toMoney(row.tax), total,
        lineItemsTotal: toMoney(lineTotal), totalVariance: toMoney(totalVariance), reconciliationStatus,
        isRevenueRecognized: isRevenue, monthKey: keys.monthKey,
        source: sourceStage(sourceRecordId, 'closed_invoice', recordHash, batch._id, now, dqStatus(dq)),
      } }], { upsert: true },
    );
    const invoice = await Invoice.findOne({ tenantId: tenant._id, invoiceNumber: sourceRecordId }, { _id: 1 }).lean();

    const lineDocs = [];
    const categoryIds = new Set();
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      const sourceItemCode = clean(li.sku) || clean(li.name) || `LINE-${i + 1}`;
      const categoryId = await resolveCategory(tenant._id, clean(li.name) || sourceItemCode);
      categoryIds.add(String(categoryId));
      const qty = toMoney(li.quantity) || toMoney(0);
      const rate = toMoney(li.rate) || toMoney(0);
      const srcAmt = toMoney(li.amount) || toMoney(0);
      const calcAmt = toMoney(moneyToNum(qty) * moneyToNum(rate));
      const variance = moneyToNum(srcAmt) - moneyToNum(calcAmt);
      lineDocs.push({
        tenantId: tenant._id, invoiceId: invoice._id, customerId: customer && customer._id, lineNumber: i + 1,
        serviceItemId: await resolveServiceItemId(tenant._id, li.name), serviceCategoryId: categoryId,
        routeId, technicianId,
        sourceItemCode, sourceDescription: clean(li.description) || clean(li.name),
        quantity: qty, rate, sourceAmount: srcAmt, calculatedAmount: calcAmt,
        amountVariance: toMoney(variance), validationStatus: moneyToNum(srcAmt) < 0 ? 'negative' : (Math.abs(variance) > 0.01 ? 'variance' : 'ok'),
        class: clean(li.class), warehouse: clean(li.warehouse), taxCode: clean(li.taxCode), itemLocation: clean(li.location),
        invoiceDate: row.invoiceDate, serviceDate, invoiceStatus: status, isRevenueRecognized: isRevenue, monthKey: keys.monthKey,
        source: {
          sourceSystem: 'routestar', sourceRecordId: `${sourceRecordId}#${i + 1}`, sourceEntity: 'invoice_line',
          importedAt: now, lastSyncedAt: now, importBatchId: batch._id, recordHash, syncStatus: 'inserted', dataQualityStatus: 'clean',
        },
      });
    }

    await ServiceVisit.updateOne(
      { tenantId: tenant._id, routeStarInvoiceNumber: sourceRecordId },
      [{ $set: {
        tenantId: tenant._id, routeStarInvoiceNumber: sourceRecordId,
        invoiceId: invoice._id, customerId: customer && customer._id,
        locationId: customer && customer.primaryLocationId, routeId,
        routeAttributionMethod: attributionMethod, routeAttributionConfidence: 'low',
        technicianId, serviceCategoryIds: [...categoryIds].map((s) => s),
        serviceDate, dateKey: keys.dateKey, isoWeek: keys.isoWeek, monthKey: keys.monthKey,
        arrivalAt: arrival.utc, arrivalLocal: arrival.local, departureAt: departure.utc, departureLocal: departure.local,
        timezone: tz,
        sourceElapsedTimeMinutes: sourceElapsed != null ? String(sourceElapsed) : undefined,
        calculatedElapsedTimeMinutes: calcElapsed != null ? String(calcElapsed) : undefined,
        elapsedTimeVarianceMinutes: (sourceElapsed != null && calcElapsed != null) ? String(sourceElapsed - calcElapsed) : undefined,
        elapsedTimeValidationStatus: elapsedStatus,
        serviceDurationMinutes: duration != null ? String(duration) : undefined,
        completionStatus: status === 'void' ? 'cancelled' : 'completed',
        serviceNotes: clean(row.serviceNotes), enteredBy: clean(row.enteredBy),
        source: sourceStage(sourceRecordId, 'service_visit', recordHash, batch._id, now, dqStatus(dq)),
      } }], { upsert: true },
    );
    const visit = await ServiceVisit.findOne({ tenantId: tenant._id, routeStarInvoiceNumber: sourceRecordId }, { _id: 1 }).lean();

    await InvoiceLineItem.deleteMany({ tenantId: tenant._id, invoiceId: invoice._id });
    if (lineDocs.length) {
      lineDocs.forEach((d) => { d.serviceVisitId = visit._id; });
      await InvoiceLineItem.insertMany(lineDocs, { ordered: false });
    }

    return {
      syncStatus: 'updated',
      controlAmount: moneyToNum(total), loadedAmount: moneyToNum(total),
      watermark: row.lastModified,
      curatedTouches: {
        techDates: technicianId ? [`${technicianId}|${keys.dateKey}`] : [],
        routeMonths: routeId ? [`${routeId}|${keys.monthKey}`] : [],
        customerMonths: customer ? [`${customer._id}|${keys.monthKey}`] : [],
      },
      dq,
    };
  },

  async recalcAffected() {  },
};
