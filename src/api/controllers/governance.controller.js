'use strict';
const { models } = require('../../models');
const { parseFilters } = require('../lib/filters');
const { buildEnvelope } = require('../lib/envelope');

const {
  DataQualityIssue, InvoiceLineItem, ServiceCategory, ItemCategoryMapping, ImportBatch, SourceSyncState, SyncRun,
} = models;
const accountJob = require('../../services/routestar/accountSyncJob');
const distancesJob = require('../../services/mapbox/syncJob');

async function dqIssues(req, res) {
  const q = { tenantId: req.tenantId };
  if (req.query.severity && req.query.severity !== 'all') q.severity = req.query.severity;
  if (req.query.resolutionStatus && req.query.resolutionStatus !== 'all') q.resolutionStatus = req.query.resolutionStatus;
  if (req.query.issueType) q.issueType = req.query.issueType;
  const rows = await DataQualityIssue.find(q).sort({ detectedAt: -1 }).limit(2000).lean();
  const openCritical = rows.filter((r) => r.severity === 'critical' && r.resolutionStatus === 'open').length;
  res.json(buildEnvelope(rows, { meta: { dataQuality: { openCriticalIssues: openCritical } } }));
}

async function resolveDqIssue(req, res) {
  const { resolutionStatus = 'resolved', resolvedBy, resolutionNotes } = req.body || {};
  const updated = await DataQualityIssue.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.tenantId },
    { $set: { resolutionStatus, resolvedBy, resolutionNotes, resolvedAt: new Date() } },
    { new: true },
  ).lean();
  if (!updated) { const e = new Error('Issue not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  res.json(buildEnvelope(updated));
}

async function unmapped(req, res) {
  const cat = await ServiceCategory.findOne({ tenantId: req.tenantId, isUnmapped: true }, { _id: 1 }).lean();
  if (!cat) return res.json(buildEnvelope([]));
  const rows = await InvoiceLineItem.aggregate([
    { $match: { tenantId: req.tenantId, serviceCategoryId: cat._id } },
    { $group: { _id: '$sourceItemCode', count: { $sum: 1 }, sourceDescription: { $first: '$sourceDescription' } } },
    { $sort: { count: -1 } },
    { $limit: 500 },
  ]);
  res.json(buildEnvelope(rows.map((r) => ({ sourceItemCode: r._id, sourceDescription: r.sourceDescription, count: r.count }))));
}

async function createMapping(req, res) {
  const body = req.body || {};
  const doc = await ItemCategoryMapping.create({
    tenantId: req.tenantId,
    matchType: body.matchType || 'exact_code',
    matchValue: body.matchValue,
    serviceItemId: body.serviceItemId,
    serviceCategoryId: body.serviceCategoryId,
    priority: body.priority ?? 100,
    isActive: true,
    reviewStatus: body.reviewStatus || 'approved',
    createdBy: body.createdBy || 'api',
  });
  res.status(201).json(buildEnvelope(doc.toObject()));
}

async function importBatches(req, res) {
  const q = { tenantId: req.tenantId };
  if (req.query.sourceSystem) q.sourceSystem = req.query.sourceSystem;
  const rows = await ImportBatch.find(q).sort({ startedAt: -1 }).limit(500).lean();
  res.json(buildEnvelope(rows));
}

// GET /sync/status — live in-progress background jobs + recent run history + source watermarks.
async function syncStatus(req, res) {
  const acct = accountJob.snapshot();
  const dist = distancesJob.snapshot(req.tenant || req.tenantId);
  const running = [];
  if (acct && acct.running) {
    running.push({
      type: 'customer-accounts', label: 'Customer account fetch', phase: acct.phase,
      startedAt: acct.startedAt, progress: { stored: acct.stored, total: acct.total, withAccount: acct.withAccount },
    });
  }
  if (dist && dist.running) {
    running.push({
      type: 'company-distances', label: 'Distances / driving-time Mapbox sync', phase: dist.phase,
      startedAt: dist.startedAt, progress: { pairs: dist.pairs, synced: dist.synced, failed: dist.failed, remaining: dist.remaining },
    });
  }

  let history = [];
  try {
    history = await SyncRun.find({}).sort({ startedAt: -1 }).limit(50).lean();
  } catch { history = []; }
  history = history.map((h) => ({
    type: h.type, label: h.label || h.type, status: h.status,
    startedAt: h.startedAt, finishedAt: h.finishedAt || null,
    durationMs: h.durationMs != null ? h.durationMs : null,
    summary: h.summary || null, error: h.error || null,
  }));

  const watermarks = req.tenantId ? await SourceSyncState.find({ tenantId: req.tenantId }).lean() : [];

  res.json(buildEnvelope({ running, history, watermarks }, { meta: { generatedAt: new Date().toISOString() } }));
}

module.exports = { dqIssues, resolveDqIssue, unmapped, createMapping, importBatches, syncStatus };
