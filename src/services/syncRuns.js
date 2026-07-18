'use strict';
const { models } = require('../models');
const logger = require('../utils/logger');

const log = logger.child('sync-runs');
const { SyncRun } = models;

// Record the start of a background sync run; returns the doc id (or null if the DB write failed).
async function recordStart(type, label) {
  try {
    const doc = await SyncRun.create({ type, label: label || type, status: 'running', startedAt: new Date() });
    return doc._id;
  } catch (e) { log.warn(`recordStart failed: ${e.message}`); return null; }
}

// Mark a run finished (status 'done' or 'error') with a summary object.
async function recordFinish(id, { status = 'done', summary, error } = {}) {
  if (!id) return;
  try {
    const finishedAt = new Date();
    const doc = await SyncRun.findById(id);
    if (!doc) return;
    doc.status = status; doc.finishedAt = finishedAt;
    doc.durationMs = finishedAt.getTime() - new Date(doc.startedAt).getTime();
    if (summary !== undefined) doc.summary = summary;
    if (error) doc.error = error;
    await doc.save();
  } catch (e) { log.warn(`recordFinish failed: ${e.message}`); }
}

module.exports = { recordStart, recordFinish };
