'use strict';
const mongoose = require('mongoose');
const { Schema, baseOptions } = require('./common');

const syncRunSchema = new Schema({
  type: { type: String, required: true },
  label: { type: String },
  status: { type: String, enum: ['running', 'done', 'error'], required: true, default: 'running' },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date },
  durationMs: { type: Number },
  summary: { type: Schema.Types.Mixed },
  error: { type: String },
}, baseOptions);
syncRunSchema.index({ type: 1, startedAt: -1 });
syncRunSchema.index({ startedAt: -1 });

module.exports = { SyncRun: mongoose.model('SyncRun', syncRunSchema) };
