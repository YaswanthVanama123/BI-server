'use strict';
const mongoose = require('mongoose');
const {
  Schema, sourceSchema, pointSchema, effectiveDates, baseOptions, withSourceIndexes, enums,
} = require('./common');

const customerSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  routeStarCustomerId: { type: String, required: true, trim: true },
  routeStarAccountNumber: { type: String, trim: true },
  quickBooksCustomerId: { type: String, trim: true },
  customerName: { type: String, required: true },
  companyName: { type: String },
  parentCustomerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  customerStatus: { type: String, enum: enums.CUSTOMER_STATUS, required: true, default: 'unknown' },
  sourceStatusText: { type: String },
  customerStatusEffectiveAt: { type: Date, required: true },
  customerGrouping: { type: String },
  customerCategory: { type: String },
  salesRepresentative: { type: String },
  paymentTerms: { type: String },
  taxCode: { type: String },
  taxRate: { type: Schema.Types.Decimal128 },
  balance: { type: Schema.Types.Decimal128 },
  defaultRouteId: { type: Schema.Types.ObjectId, ref: 'Route' },
  primaryLocationId: { type: Schema.Types.ObjectId, ref: 'CustomerLocation' },
  source: { type: sourceSchema, required: true },
}, baseOptions);

customerSchema.index({ tenantId: 1, routeStarCustomerId: 1 }, { unique: true });
customerSchema.index({ tenantId: 1, routeStarAccountNumber: 1 },
  { unique: true, partialFilterExpression: { routeStarAccountNumber: { $type: 'string' } } });
customerSchema.index({ tenantId: 1, customerName: 1 }, { collation: { locale: 'en', strength: 2 } });
customerSchema.index({ tenantId: 1, quickBooksCustomerId: 1 }, { sparse: true });
customerSchema.index({ tenantId: 1, customerStatus: 1 });

const customerLocationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  routeStarLocationId: { type: String, trim: true },
  locationName: { type: String },
  locationType: { type: String, enum: ['service', 'billing', 'both'], required: true, default: 'service' },
  addressLines: { type: [String], required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },
  postalCode: { type: String, required: true },
  country: { type: String, required: true, default: 'US' },
  sourceLatitude: { type: Number },
  sourceLongitude: { type: Number },
  location: { type: pointSchema },
  coordinateSource: { type: String, enum: ['routestar', 'mapbox_geocode', 'manual'], required: true, default: 'routestar' },
  geocodeAccuracy: { type: String },
  mapboxPlaceId: { type: String },
  geocodedAt: { type: Date },
  zone: { type: String },
  addressHash: { type: String, required: true },
  isActive: { type: Boolean, required: true, default: true },
  ...effectiveDates,
  source: { type: sourceSchema, required: true },
}, baseOptions);

customerLocationSchema.index({ tenantId: 1, customerId: 1 });
customerLocationSchema.index({ location: '2dsphere' });
customerLocationSchema.index({ tenantId: 1, addressHash: 1 });
customerLocationSchema.index({ tenantId: 1, customerId: 1, isActive: 1, effectiveStart: -1 });

const customerContactSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  contactName: { type: String },
  role: { type: String },
  phone: { type: String },
  email: { type: String },
  isPrimary: { type: Boolean, required: true, default: false },
  source: { type: sourceSchema, required: true },
}, baseOptions);
customerContactSchema.index({ tenantId: 1, customerId: 1 });

const customerStatusHistorySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  status: { type: String, enum: enums.CUSTOMER_STATUS, required: true },
  sourceStatusText: { type: String },
  reason: { type: String },
  ...effectiveDates,
  source: { type: sourceSchema, required: true },
}, baseOptions);
customerStatusHistorySchema.index({ tenantId: 1, customerId: 1, effectiveStart: -1 });

const customerServiceScheduleSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  locationId: { type: Schema.Types.ObjectId, ref: 'CustomerLocation' },
  routeId: { type: Schema.Types.ObjectId, ref: 'Route', required: true },
  technicianId: { type: Schema.Types.ObjectId, ref: 'Employee' },
  normalizedFrequency: { type: String, enum: enums.FREQUENCY, required: true },
  sourceFrequencyText: { type: String },
  dayOfWeek: { type: String, enum: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] },
  stopNumber: { type: Number },
  originalStopNumber: { type: Number },
  nextServiceDate: { type: Date },
  isSuspended: { type: Boolean, required: true, default: false },
  suspendedAt: { type: Date },
  isMissedRoute: { type: Boolean, required: true, default: false },
  isActive: { type: Boolean, required: true, default: true },
  notes: { type: String },
  ...effectiveDates,
  source: { type: sourceSchema, required: true },
}, baseOptions);
customerServiceScheduleSchema.index({ tenantId: 1, customerId: 1, effectiveStart: -1 });
customerServiceScheduleSchema.index({ tenantId: 1, routeId: 1, isActive: 1 });

module.exports = {
  Customer: mongoose.model('Customer', withSourceIndexes(customerSchema)),
  CustomerLocation: mongoose.model('CustomerLocation', withSourceIndexes(customerLocationSchema)),
  CustomerContact: mongoose.model('CustomerContact', withSourceIndexes(customerContactSchema)),
  CustomerStatusHistory: mongoose.model('CustomerStatusHistory', customerStatusHistorySchema),
  CustomerServiceSchedule: mongoose.model('CustomerServiceSchedule', withSourceIndexes(customerServiceScheduleSchema)),
};
