'use strict';
const mongoose = require('mongoose');
const { Schema, sourceSchema, baseOptions, withSourceIndexes, enums } = require('./common');

const serviceVisitSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  routeStarInvoiceNumber: { type: String, trim: true },
  invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  locationId: { type: Schema.Types.ObjectId, ref: 'CustomerLocation' },
  routeId: { type: Schema.Types.ObjectId, ref: 'Route' },
  routeAttributionMethod: { type: String, enum: enums.ROUTE_ATTRIBUTION, required: true, default: 'unassigned' },
  routeAttributionConfidence: { type: String, enum: ['high', 'medium', 'low'], required: true, default: 'low' },
  technicianId: { type: Schema.Types.ObjectId, ref: 'Employee' },
  serviceCategoryIds: { type: [Schema.Types.ObjectId], default: [] },
  serviceDate: { type: Date, required: true },
  dateKey: { type: String, required: true },
  isoWeek: { type: String, required: true },
  monthKey: { type: String, required: true },
  arrivalAt: { type: Date },
  arrivalLocal: { type: String },
  departureAt: { type: Date },
  departureLocal: { type: String },
  timezone: { type: String, required: true, default: 'America/New_York' },
  sourceElapsedTimeMinutes: { type: Schema.Types.Decimal128 },
  calculatedElapsedTimeMinutes: { type: Schema.Types.Decimal128 },
  elapsedTimeVarianceMinutes: { type: Schema.Types.Decimal128 },
  elapsedTimeValidationStatus: {
    type: String,
    enum: ['ok', 'variance', 'missing_times', 'negative', 'overlap', 'crosses_midnight'],
    required: true, default: 'missing_times',
  },
  serviceDurationMinutes: { type: Schema.Types.Decimal128 },
  completionStatus: { type: String, enum: enums.COMPLETION_STATUS, required: true, default: 'completed' },
  serviceNotes: { type: String },
  enteredBy: { type: String },
  outgoingRouteLegId: { type: Schema.Types.ObjectId, ref: 'RouteLeg' },
  source: { type: sourceSchema, required: true },
}, baseOptions);
serviceVisitSchema.index({ tenantId: 1, technicianId: 1, serviceDate: 1, arrivalAt: 1 });
serviceVisitSchema.index({ tenantId: 1, routeId: 1, serviceDate: 1 });
serviceVisitSchema.index({ tenantId: 1, customerId: 1, serviceDate: 1 });
serviceVisitSchema.index({ tenantId: 1, invoiceId: 1 });
serviceVisitSchema.index({ tenantId: 1, completionStatus: 1, serviceDate: 1 });
serviceVisitSchema.index({ tenantId: 1, monthKey: 1, technicianId: 1 });
serviceVisitSchema.index({ tenantId: 1, elapsedTimeValidationStatus: 1 });

const invoiceSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  invoiceNumber: { type: String, required: true, trim: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  routeStarAccountNumber: { type: String },
  invoiceType: { type: String, enum: enums.INVOICE_TYPE, required: true, default: 'unknown' },
  status: { type: String, enum: enums.INVOICE_STATUS, required: true, default: 'closed' },
  invoiceDate: { type: Date, required: true },
  dateCompleted: { type: Date },
  enteredBy: { type: String },
  assignedToEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
  routeId: { type: Schema.Types.ObjectId, ref: 'Route' },
  customerGrouping: { type: String },
  subtotal: { type: Schema.Types.Decimal128, required: true, default: '0' },
  taxTotal: { type: Schema.Types.Decimal128 },
  total: { type: Schema.Types.Decimal128, required: true, default: '0' },
  lineItemsTotal: { type: Schema.Types.Decimal128 },
  totalVariance: { type: Schema.Types.Decimal128 },
  reconciliationStatus: { type: String, enum: ['ok', 'variance', 'no_lines'], required: true, default: 'no_lines' },
  isRevenueRecognized: { type: Boolean, required: true, default: true },
  monthKey: { type: String, required: true },
  source: { type: sourceSchema, required: true },
}, baseOptions);
invoiceSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ tenantId: 1, customerId: 1, invoiceDate: 1 });
invoiceSchema.index({ tenantId: 1, routeId: 1, invoiceDate: 1 });
invoiceSchema.index({ tenantId: 1, status: 1, invoiceDate: 1 });
invoiceSchema.index({ tenantId: 1, monthKey: 1 });
invoiceSchema.index({ tenantId: 1, reconciliationStatus: 1 });

const invoiceLineItemSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  lineNumber: { type: Number },
  serviceItemId: { type: Schema.Types.ObjectId, ref: 'ServiceItem' },
  serviceCategoryId: { type: Schema.Types.ObjectId, ref: 'ServiceCategory', required: true },
  serviceVisitId: { type: Schema.Types.ObjectId, ref: 'ServiceVisit' },
  routeId: { type: Schema.Types.ObjectId, ref: 'Route' },
  technicianId: { type: Schema.Types.ObjectId, ref: 'Employee' },
  sourceItemCode: { type: String, required: true },
  sourceDescription: { type: String },
  quantity: { type: Schema.Types.Decimal128, required: true, default: '0' },
  rate: { type: Schema.Types.Decimal128, required: true, default: '0' },
  sourceAmount: { type: Schema.Types.Decimal128, required: true, default: '0' },
  calculatedAmount: { type: Schema.Types.Decimal128, required: true, default: '0' },
  amountVariance: { type: Schema.Types.Decimal128, required: true, default: '0' },
  validationStatus: { type: String, enum: ['ok', 'variance', 'negative'], required: true, default: 'ok' },
  class: { type: String },
  warehouse: { type: String },
  taxCode: { type: String },
  itemLocation: { type: String },
  invoiceDate: { type: Date, required: true },
  serviceDate: { type: Date },
  invoiceStatus: { type: String, required: true },
  isRevenueRecognized: { type: Boolean, required: true, default: true },
  monthKey: { type: String, required: true },
  source: { type: sourceSchema, required: true },
}, baseOptions);
invoiceLineItemSchema.index({ tenantId: 1, invoiceId: 1 });
invoiceLineItemSchema.index({ tenantId: 1, serviceCategoryId: 1, invoiceDate: 1 });
invoiceLineItemSchema.index({ tenantId: 1, customerId: 1, invoiceDate: 1 });
invoiceLineItemSchema.index({ tenantId: 1, routeId: 1, invoiceDate: 1 });
invoiceLineItemSchema.index({ tenantId: 1, monthKey: 1, serviceCategoryId: 1 });
invoiceLineItemSchema.index({ tenantId: 1, serviceVisitId: 1 });
invoiceLineItemSchema.index({ tenantId: 1, validationStatus: 1 });

module.exports = {
  ServiceVisit: mongoose.model('ServiceVisit', withSourceIndexes(serviceVisitSchema)),
  Invoice: mongoose.model('Invoice', withSourceIndexes(invoiceSchema)),
  InvoiceLineItem: mongoose.model('InvoiceLineItem', withSourceIndexes(invoiceLineItemSchema)),
};
