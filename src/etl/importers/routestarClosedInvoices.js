'use strict';
const { models } = require('../../models');
const { dqIssue } = require('../importBatchRunner');
const {
  toMoney, moneyToNum, parseLocalDateTime, periodKeys, diffMinutes,
} = require('../../utils/util');
const { resolveCustomer } = require('./resolvers/customerResolver');
const { resolveEmployeeByTechName } = require('./resolvers/employeeResolver');
const { attributeRoute } = require('./resolvers/routeResolver');

const { Invoice, ServiceVisit } = models;

module.exports = {
  name: 'routestar_closed_invoices',
  sourceSystem: 'routestar',
  sourceEntity: 'closed_invoice',
  rawModel: models.RawRouteStarInvoices,

  getSourceRecordId(row) { return String(row['Invoice #'] || '').trim(); },

  async processRecord(row, ctx) {
    const { tenant, batch, now, sourceRecordId, recordHash, rawUnchanged } = ctx;
    const tz = tenant.reportingTimezone;
    const dq = [];

    if (rawUnchanged) {
      const exists = await Invoice.exists({ tenantId: tenant._id, invoiceNumber: sourceRecordId });
      if (exists) return { syncStatus: 'unchanged', curatedTouches: {}, dq: [] };
    }

    const invDate = parseLocalDateTime(row['Invoice Date'], null, tz);
    const completed = parseLocalDateTime(row['Date Completed'], null, tz);
    const arrival = parseLocalDateTime(row['Date Completed'] || row['Invoice Date'], row['Arrival Time'], tz);
    const departure = parseLocalDateTime(row['Date Completed'] || row['Invoice Date'], row['Departure Time'], tz);
    const modified = parseLocalDateTime((row['Last Modified'] || '').split(' ')[0], (row['Last Modified'] || '').split(' ').slice(1).join(' '), tz);
    const serviceDate = completed.utc || invDate.utc;
    const keys = periodKeys(serviceDate, tz);

    const subtotal = toMoney(row['Subtotal']);
    const total = toMoney(row['Total']);

    const customer = await resolveCustomer(tenant, {
      routeStarCustomerId: row['Customer ID'], routeStarAccountNumber: row['Account #'], displayName: row['Customer'], batch, now,
    });
    if (!customer) {
      dq.push(dqIssue(tenant, batch, 'missing_customer_ref', 'error', 'invoices', null, sourceRecordId, 'routestar',
        `Invoice ${sourceRecordId} has no resolvable customer (Customer ID='${row['Customer ID']}')`, now, { row: row['Customer'] }));
    }
    const technician = await resolveEmployeeByTechName(tenant, row['Assigned To']);
    if (!technician) {
      dq.push(dqIssue(tenant, batch, 'missing_employee_mapping', 'warning', 'serviceVisits', null, sourceRecordId, 'routestar',
        `Technician '${row['Assigned To']}' not mapped to an employee`, now));
    }
    const attribution = await attributeRoute(tenant, { visitRouteCode: row['Route'], invoiceRouteCode: row['Route'], technician, customer, serviceDate });
    if (attribution.method === 'unassigned' && row['Route']) {
      dq.push(dqIssue(tenant, batch, 'missing_route_mapping', 'warning', 'serviceVisits', null, sourceRecordId, 'routestar',
        `Route code '${row['Route']}' not found in routes`, now));
    }

    const sourceElapsed = parseElapsed(row['Elapsed Time']);
    const calcElapsed = diffMinutes(departure.utc, arrival.utc);
    const elapsed = validateElapsed({ arrival: arrival.utc, departure: departure.utc, sourceElapsed, calcElapsed });
    if (elapsed.status === 'variance') {
      dq.push(dqIssue(tenant, batch, 'elapsed_time_variance', 'warning', 'serviceVisits', null, sourceRecordId, 'routestar',
        `Source elapsed ${sourceElapsed}m vs calculated ${calcElapsed}m`, now, { sourceElapsed, calcElapsed }));
    }
    if (elapsed.status === 'negative') {
      dq.push(dqIssue(tenant, batch, 'departure_before_arrival', 'error', 'serviceVisits', null, sourceRecordId, 'routestar',
        `Departure before arrival for invoice ${sourceRecordId}`, now));
    }

    const source = {
      sourceSystem: 'routestar', sourceRecordId, sourceEntity: 'closed_invoice',
      sourceModifiedAt: modified.utc, importedAt: now, lastSyncedAt: now, importBatchId: batch._id,
      recordHash, syncStatus: 'inserted', dataQualityStatus: dqStatus(dq),
    };

    const isRevenue = !['void', 'credit'].includes(mapInvoiceStatus(row['Invoice Type'], total));
    const invoiceRes = await Invoice.updateOne(
      { tenantId: tenant._id, invoiceNumber: sourceRecordId },
      {
        $setOnInsert: { tenantId: tenant._id, invoiceNumber: sourceRecordId, 'source.importedAt': now },
        $set: {
          customerId: customer && customer._id, routeStarAccountNumber: (row['Account #'] || '').trim() || undefined,
          invoiceType: mapInvoiceType(row['Invoice Type']), status: 'closed',
          invoiceDate: invDate.utc, dateCompleted: completed.utc, enteredBy: row['Entered By'],
          assignedToEmployeeId: technician && technician._id, routeId: attribution.routeId,
          customerGrouping: row['Customer Grouping'], subtotal, total, isRevenueRecognized: isRevenue,
          monthKey: keys.monthKey, source,
        },
      },
      { upsert: true }
    );
    const invoiceDoc = await Invoice.findOne({ tenantId: tenant._id, invoiceNumber: sourceRecordId }, { _id: 1 });

    await ServiceVisit.updateOne(
      { tenantId: tenant._id, routeStarInvoiceNumber: sourceRecordId },
      {
        $setOnInsert: { tenantId: tenant._id, routeStarInvoiceNumber: sourceRecordId, 'source.importedAt': now },
        $set: {
          invoiceId: invoiceDoc && invoiceDoc._id, customerId: customer && customer._id,
          locationId: customer && customer.primaryLocationId, routeId: attribution.routeId,
          routeAttributionMethod: attribution.method, routeAttributionConfidence: attribution.confidence,
          technicianId: technician && technician._id, serviceDate,
          dateKey: keys.dateKey, isoWeek: keys.isoWeek, monthKey: keys.monthKey,
          arrivalAt: arrival.utc, arrivalLocal: arrival.local, departureAt: departure.utc, departureLocal: departure.local,
          timezone: tz, sourceElapsedTimeMinutes: sourceElapsed != null ? String(sourceElapsed) : undefined,
          calculatedElapsedTimeMinutes: calcElapsed != null ? String(calcElapsed) : undefined,
          elapsedTimeVarianceMinutes: elapsed.variance != null ? String(elapsed.variance) : undefined,
          elapsedTimeValidationStatus: elapsed.status,
          serviceDurationMinutes: elapsed.duration != null ? String(elapsed.duration) : undefined,
          completionStatus: 'completed', serviceNotes: row['Service Notes'], enteredBy: row['Entered By'],
          source: { ...source, sourceEntity: 'service_visit' },
        },
      },
      { upsert: true }
    );

    const syncStatus = invoiceRes.upsertedCount ? 'inserted' : 'updated';
    return {
      syncStatus,
      controlAmount: moneyToNum(total), loadedAmount: moneyToNum(total),
      watermark: modified.utc,
      curatedTouches: {
        techDates: technician ? [`${technician._id}|${keys.dateKey}`] : [],
        routeMonths: attribution.routeId ? [`${attribution.routeId}|${keys.monthKey}`] : [],
        customerMonths: customer ? [`${customer._id}|${keys.monthKey}`] : [],
      },
      dq,
    };
  },

  async recalcAffected(ctx) {
    const { recalcRouteLegsForKeys } = require('../../services/mapbox/routeLegCalculator');
    const { refreshDailyTechnician, refreshMonthlyRoute, refreshMonthlyCustomer } = require('../../services/analytics/rebuildSummaries');
    await recalcRouteLegsForKeys(ctx.tenant, [...ctx.touched.techDates], ctx.batch);
    await refreshDailyTechnician(ctx.tenant, [...ctx.touched.techDates], ctx.batch);
    await refreshMonthlyRoute(ctx.tenant, [...ctx.touched.routeMonths], ctx.batch);
    await refreshMonthlyCustomer(ctx.tenant, [...ctx.touched.customerMonths], ctx.batch);
  },
};

function parseElapsed(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  if (s.includes(':')) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
  const n = Number(s); return Number.isNaN(n) ? undefined : n;
}
function validateElapsed({ arrival, departure, sourceElapsed, calcElapsed }, toleranceMin = 10) {
  if (!arrival || !departure) return { status: 'missing_times', duration: undefined, variance: undefined };
  if (calcElapsed < 0) return { status: 'negative', duration: undefined, variance: undefined };
  const variance = sourceElapsed != null ? sourceElapsed - calcElapsed : undefined;
  const status = variance != null && Math.abs(variance) > toleranceMin ? 'variance' : 'ok';
  return { status, duration: calcElapsed, variance };
}
function mapInvoiceType(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('recur')) return 'recurring';
  if (s.includes('credit')) return 'credit';
  if (s.includes('trip')) return 'trip_charge';
  if (s.includes('one')) return 'one_time';
  return 'unknown';
}
function mapInvoiceStatus(type, total) {
  if (String(type || '').toLowerCase().includes('credit')) return 'credit';
  if (moneyToNum(total) < 0) return 'credit';
  return 'closed';
}
function dqStatus(dq) {
  if (dq.some((d) => d.severity === 'critical')) return 'quarantined';
  if (dq.some((d) => d.severity === 'error')) return 'error';
  if (dq.length) return 'warning';
  return 'clean';
}
