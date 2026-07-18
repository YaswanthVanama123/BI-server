'use strict';
const mongoose = require('mongoose');
const { Schema, baseOptions, enums, COLLECTION_PREFIX } = require('./common');

const importBatchSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  sourceSystem: { type: String, enum: enums.SOURCE_SYSTEMS, required: true },
  sourceEntity: { type: String, required: true },
  fileName: { type: String },
  fileHash: { type: String },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date },
  status: { type: String, enum: ['running', 'completed', 'failed', 'partial'], required: true, default: 'running' },
  counts: {
    read: { type: Number, default: 0 },
    inserted: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    unchanged: { type: Number, default: 0 },
    rejected: { type: Number, default: 0 },
  },
  reconciliation: {
    sourceRowCount: { type: Number },
    sourceTotalAmount: { type: Schema.Types.Decimal128 },
    loadedRowCount: { type: Number },
    loadedTotalAmount: { type: Schema.Types.Decimal128 },
    matched: { type: Boolean },
  },
  watermarkBefore: { type: Schema.Types.Mixed },
  watermarkAfter: { type: Schema.Types.Mixed },
  errorSummary: { type: String },
}, baseOptions);
importBatchSchema.index({ tenantId: 1, sourceSystem: 1, startedAt: -1 });
importBatchSchema.index({ status: 1 });

const sourceSyncStateSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  sourceSystem: { type: String, enum: enums.SOURCE_SYSTEMS, required: true },
  sourceEntity: { type: String, required: true },
  lastSuccessfulSyncAt: { type: Date },
  lastWatermark: { type: Schema.Types.Mixed },
  lastBatchId: { type: Schema.Types.ObjectId, ref: 'ImportBatch' },
  cursor: { type: Schema.Types.Mixed },
  status: { type: String, enum: ['idle', 'running', 'error'], required: true, default: 'idle' },
  retryCount: { type: Number, required: true, default: 0 },
}, baseOptions);
sourceSyncStateSchema.index({ tenantId: 1, sourceSystem: 1, sourceEntity: 1 }, { unique: true });

const dataQualityIssueSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  issueType: { type: String, required: true },
  severity: { type: String, enum: enums.DQ_SEVERITY, required: true },
  collectionName: { type: String, required: true },
  recordId: { type: Schema.Types.ObjectId },
  sourceRecordId: { type: String },
  sourceSystem: { type: String, enum: enums.SOURCE_SYSTEMS },
  description: { type: String, required: true },
  context: { type: Schema.Types.Mixed },
  detectedAt: { type: Date, required: true },
  detectedByBatchId: { type: Schema.Types.ObjectId, ref: 'ImportBatch' },
  resolutionStatus: { type: String, enum: enums.DQ_RESOLUTION, required: true, default: 'open' },
  resolvedAt: { type: Date },
  resolvedBy: { type: String },
  resolutionNotes: { type: String },
}, baseOptions);
dataQualityIssueSchema.index({ tenantId: 1, resolutionStatus: 1, severity: 1, detectedAt: -1 });
dataQualityIssueSchema.index({ tenantId: 1, issueType: 1 });
dataQualityIssueSchema.index({ tenantId: 1, collectionName: 1, recordId: 1 });

const auditLogSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  entity: { type: String, required: true },
  entityId: { type: Schema.Types.ObjectId },
  action: { type: String, enum: ['insert', 'update', 'supersede', 'delete', 'recompute'], required: true },
  actor: { type: String, enum: ['etl', 'user', 'system'], required: true },
  actorId: { type: String },
  batchId: { type: Schema.Types.ObjectId, ref: 'ImportBatch' },
  before: { type: Schema.Types.Mixed },
  after: { type: Schema.Types.Mixed },
  changedFields: { type: [String], default: [] },
  at: { type: Date, required: true },
}, baseOptions);
auditLogSchema.index({ tenantId: 1, entity: 1, entityId: 1, at: -1 });

function makeRawModel(modelName, collectionName) {
  const rawSchema = new Schema({
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    sourceSystem: { type: String, enum: enums.SOURCE_SYSTEMS, required: true },
    sourceEntity: { type: String, required: true },
    importBatchId: { type: Schema.Types.ObjectId, ref: 'ImportBatch', required: true },
    sourceRecordId: { type: String, required: true },
    recordHash: { type: String, required: true },
    rawPayload: { type: Schema.Types.Mixed, required: true },
    rawHeaders: { type: [String] },
    rowNumber: { type: Number },
    importedAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    supersededByHash: { type: String },
    parseStatus: { type: String, enum: ['parsed', 'parse_error'], required: true, default: 'parsed' },
    parseErrors: { type: [String] },
  }, { timestamps: true, minimize: false, collection: `${COLLECTION_PREFIX}${collectionName}` });
  rawSchema.index(
    { tenantId: 1, sourceSystem: 1, sourceEntity: 1, sourceRecordId: 1, recordHash: 1 }, { unique: true }
  );
  rawSchema.index({ tenantId: 1, importBatchId: 1 });
  return mongoose.model(modelName, rawSchema);
}

module.exports = {
  ImportBatch: mongoose.model('ImportBatch', importBatchSchema),
  SourceSyncState: mongoose.model('SourceSyncState', sourceSyncStateSchema),
  DataQualityIssue: mongoose.model('DataQualityIssue', dataQualityIssueSchema),
  AuditLog: mongoose.model('AuditLog', auditLogSchema),
  RawRouteStarInvoices: makeRawModel('RawRouteStarInvoices', 'raw_routestar_invoices'),
  RawRouteStarInvoiceLines: makeRawModel('RawRouteStarInvoiceLines', 'raw_routestar_invoice_lines'),
  RawRouteStarCustomers: makeRawModel('RawRouteStarCustomers', 'raw_routestar_customers'),
  RawRouteStarPricing: makeRawModel('RawRouteStarPricing', 'raw_routestar_pricing'),
  RawRouteStarCustomerRoutes: makeRawModel('RawRouteStarCustomerRoutes', 'raw_routestar_customer_routes'),
  RawRouteStarItems: makeRawModel('RawRouteStarItems', 'raw_routestar_items'),
  RawAdpPayroll: makeRawModel('RawAdpPayroll', 'raw_adp_payroll'),
  RawFastcashWeekly: makeRawModel('RawFastcashWeekly', 'raw_fastcash_weekly'),
  RawEnviromasterSupply: makeRawModel('RawEnviromasterSupply', 'raw_enviromaster_supply'),
};
