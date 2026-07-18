'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const { Schema } = mongoose;
const { Decimal128 } = mongoose.Schema.Types;

const COLLECTION_PREFIX = process.env.BI_COLLECTION_PREFIX ?? 'bi_';
if (COLLECTION_PREFIX) {
  const base = mongoose.pluralize() || ((n) => n);
  mongoose.pluralize((name) => `${COLLECTION_PREFIX}${base(name)}`);
}

function toMoney(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const s = typeof v === 'number' ? v.toFixed(4) : String(v).trim();
  return mongoose.Types.Decimal128.fromString(s);
}

const crypto = require('crypto');
function recordHash(obj) {
  const canonical = JSON.stringify(sortKeys(obj));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object' && !(o instanceof Date)) {
    return Object.keys(o).sort().reduce((acc, k) => {
      const v = o[k];
      if (v !== undefined && v !== null && v !== '') acc[k] = sortKeys(v);
      return acc;
    }, {});
  }
  return o;
}

const SOURCE_SYSTEMS = ['routestar', 'adp', 'fastcash', 'enviromaster', 'quickbooks', 'mapbox', 'manual'];
const SYNC_STATUS = ['inserted', 'updated', 'unchanged', 'rejected', 'superseded'];
const DQ_STATUS = ['clean', 'warning', 'error', 'quarantined'];

const sourceSchema = new Schema({
  sourceSystem: { type: String, enum: SOURCE_SYSTEMS, required: true },
  sourceRecordId: { type: String, required: true, trim: true },
  sourceEntity: { type: String, required: true },
  sourceUrl: { type: String },
  sourceCreatedAt: { type: Date },
  sourceModifiedAt: { type: Date },
  importedAt: { type: Date, required: true },
  lastSyncedAt: { type: Date, required: true },
  importBatchId: { type: Schema.Types.ObjectId, ref: 'ImportBatch', required: true },
  recordHash: { type: String, required: true },
  syncStatus: { type: String, enum: SYNC_STATUS, required: true },
  dataQualityStatus: { type: String, enum: DQ_STATUS, required: true, default: 'clean' },
  rawRef: { type: Schema.Types.ObjectId },
}, { _id: false });

const pointSchema = new Schema({
  type: { type: String, enum: ['Point'], default: 'Point' },
  coordinates: { type: [Number], required: true },
}, { _id: false });

const lineStringSchema = new Schema({
  type: { type: String, enum: ['LineString'], default: 'LineString' },
  coordinates: { type: [[Number]], required: true },
}, { _id: false });

const effectiveDates = {
  effectiveStart: { type: Date, required: true },
  effectiveEnd: { type: Date, default: null },
};

const baseOptions = { timestamps: true, minimize: false };

function withSourceIndexes(schema) {
  schema.index(
    { tenantId: 1, 'source.sourceSystem': 1, 'source.sourceRecordId': 1 },
    { unique: true, name: 'uniq_tenant_source_record' }
  );
  schema.index({ tenantId: 1, 'source.sourceModifiedAt': 1 }, { name: 'watermark' });
  return schema;
}

module.exports = {
  Schema, Decimal128, toMoney, recordHash, sortKeys, COLLECTION_PREFIX,
  sourceSchema, pointSchema, lineStringSchema, effectiveDates, baseOptions, withSourceIndexes,
  enums: {
    SOURCE_SYSTEMS, SYNC_STATUS, DQ_STATUS,
    CUSTOMER_STATUS: ['active', 'suspended', 'stopped', 'cancelled', 'churned', 'inactive', 'unknown'],
    FREQUENCY: ['weekly', 'biweekly', 'monthly', 'twice_monthly', 'quarterly', 'semiannual', 'annual', 'one_time', 'custom', 'unknown'],
    EMPLOYMENT_TYPE: ['hourly', 'salaried'],
    INVOICE_TYPE: ['recurring', 'one_time', 'credit', 'adjustment', 'trip_charge', 'unknown'],
    INVOICE_STATUS: ['open', 'closed', 'void', 'credit', 'paid'],
    COMPLETION_STATUS: ['completed', 'cancelled', 'suspended', 'missed'],
    ROUTE_ATTRIBUTION: ['visit', 'invoice', 'tech_assignment', 'customer_default', 'unassigned'],
    LEG_STATUS: ['ok', 'missing_coords', 'missing_times', 'overlap', 'same_location', 'different_tech',
      'crosses_midnight', 'negative_gap', 'large_gap', 'first_stop', 'last_stop', 'mapbox_failed', 'duration_gt_gap'],
    DQ_SEVERITY: ['info', 'warning', 'error', 'critical'],
    DQ_RESOLUTION: ['open', 'acknowledged', 'resolved', 'ignored'],
  },
};
