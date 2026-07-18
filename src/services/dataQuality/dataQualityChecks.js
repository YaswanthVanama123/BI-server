'use strict';
const { models } = require('../../models');
const {
  Invoice, InvoiceLineItem, ServiceVisit, Customer, PayrollPeriod, DataQualityIssue, BusinessRule,
} = models;

async function runSweep(tenant, now = new Date()) {
  const issues = [];
  issues.push(...await duplicateAccountNumbers(tenant));
  issues.push(...await invoiceTotalMismatch(tenant));
  issues.push(...await lineAmountMismatch(tenant));
  issues.push(...await revenueIncludedVoid(tenant));
  issues.push(...await unmappedServiceItems(tenant));
  issues.push(...await payrollPeriodOverlap(tenant));
  issues.push(...await invoicesWithoutVisits(tenant));
  await upsertIssues(tenant, issues, now);
  return issues.length;
}

async function duplicateAccountNumbers(tenant) {
  const dups = await Customer.aggregate([
    { $match: { tenantId: tenant._id, routeStarAccountNumber: { $type: 'string' } } },
    { $group: { _id: '$routeStarAccountNumber', ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  return dups.map((d) => mk('duplicate_account_number', 'error', 'customers', d.ids[0], String(d._id),
    `Account # '${d._id}' shared by ${d.n} customers`, { ids: d.ids }));
}

async function invoiceTotalMismatch(tenant) {
  const tol = await ruleNumber(tenant, 'invoiceTotalTolerance', 0.01);
  const bad = await Invoice.aggregate([
    { $match: { tenantId: tenant._id, lineItemsTotal: { $ne: null } } },
    { $addFields: { diff: { $abs: { $subtract: [{ $toDouble: '$total' }, { $toDouble: '$lineItemsTotal' }] } } } },
    { $match: { diff: { $gt: tol } } }, { $limit: 5000 },
  ]);
  return bad.map((i) => mk('invoice_total_mismatch', 'error', 'invoices', i._id, i.invoiceNumber,
    `Invoice total ${i.total} ≠ Σ lines ${i.lineItemsTotal}`, { diff: i.diff }));
}

async function lineAmountMismatch(tenant) {
  const tol = await ruleNumber(tenant, 'lineAmountTolerance', 0.01);
  const bad = await InvoiceLineItem.aggregate([
    { $match: { tenantId: tenant._id } },
    { $addFields: { diff: { $abs: { $subtract: [{ $toDouble: '$sourceAmount' }, { $toDouble: '$calculatedAmount' }] } } } },
    { $match: { diff: { $gt: tol } } }, { $limit: 5000 },
  ]);
  return bad.map((l) => mk('line_amount_mismatch', 'warning', 'invoiceLineItems', l._id, l.sourceItemCode,
    `Line amount ${l.sourceAmount} ≠ qty×rate ${l.calculatedAmount}`, { diff: l.diff }));
}

async function revenueIncludedVoid(tenant) {
  const bad = await Invoice.find({ tenantId: tenant._id, status: { $in: ['void', 'credit'] }, isRevenueRecognized: true }).limit(5000).lean();
  return bad.map((i) => mk('revenue_included_void', 'error', 'invoices', i._id, i.invoiceNumber,
    `Void/credit invoice flagged as revenue-recognized`, {}));
}

async function unmappedServiceItems(tenant) {
  const cat = await models.ServiceCategory.findOne({ tenantId: tenant._id, isUnmapped: true }, { _id: 1 });
  if (!cat) return [];
  const rows = await InvoiceLineItem.aggregate([
    { $match: { tenantId: tenant._id, serviceCategoryId: cat._id } },
    { $group: { _id: '$sourceItemCode', n: { $sum: 1 }, sample: { $first: '$sourceDescription' } } },
    { $sort: { n: -1 } }, { $limit: 500 },
  ]);
  return rows.map((r) => mk('unknown_service_item_category', 'warning', 'invoiceLineItems', null, r._id,
    `Unmapped item '${r._id}' (${r.sample}) on ${r.n} lines — needs itemCategoryMappings entry`, { count: r.n }));
}

async function payrollPeriodOverlap(tenant) {
  const periods = await PayrollPeriod.find({ tenantId: tenant._id }).sort({ periodStart: 1 }).lean();
  const out = [];
  for (let i = 1; i < periods.length; i++) {
    if (periods[i].periodStart < periods[i - 1].periodEnd) {
      out.push(mk('payroll_period_overlap', 'error', 'payrollPeriods', periods[i]._id, null,
        `Payroll period overlaps prior period`, { prev: periods[i - 1]._id }));
    }
  }
  return out;
}

async function invoicesWithoutVisits(tenant) {
  const rows = await Invoice.aggregate([
    { $match: { tenantId: tenant._id, status: 'closed' } },
    { $lookup: { from: ServiceVisit.collection.name, localField: '_id', foreignField: 'invoiceId', as: 'v' } },
    { $match: { v: { $size: 0 } } }, { $limit: 2000 },
  ]);
  return rows.map((i) => mk('invoice_without_service_visit', 'warning', 'invoices', i._id, i.invoiceNumber,
    `Closed invoice has no linked service visit`, {}));
}

function mk(issueType, severity, collectionName, recordId, sourceRecordId, description, context) {
  return { issueType, severity, collectionName, recordId, sourceRecordId, description, context };
}
async function upsertIssues(tenant, issues, now) {
  for (const i of issues) {
    await DataQualityIssue.updateOne(
      { tenantId: tenant._id, issueType: i.issueType, collectionName: i.collectionName, recordId: i.recordId || null, sourceRecordId: i.sourceRecordId || null },
      { $set: { ...i, tenantId: tenant._id, detectedAt: now }, $setOnInsert: { resolutionStatus: 'open' } },
      { upsert: true }
    );
  }
}
async function ruleNumber(tenant, key, fallback) {
  const r = await BusinessRule.findOne({ tenantId: tenant._id, key }).sort({ effectiveStart: -1 });
  return r ? Number(r.value) : fallback;
}

module.exports = { runSweep };
