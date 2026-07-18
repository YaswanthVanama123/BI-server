'use strict';
const mongoose = require('mongoose');
const { Schema, pointSchema, lineStringSchema, baseOptions, enums } = require('./common');

const routeLegSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  serviceDate: { type: Date, required: true },
  dateKey: { type: String, required: true },
  technicianId: { type: Schema.Types.ObjectId, ref: 'Employee' },
  routeId: { type: Schema.Types.ObjectId, ref: 'Route' },
  fromVisitId: { type: Schema.Types.ObjectId, ref: 'ServiceVisit', required: true },
  toVisitId: { type: Schema.Types.ObjectId, ref: 'ServiceVisit', required: true },
  fromInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
  toInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
  fromCustomerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  toCustomerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  fromLocationId: { type: Schema.Types.ObjectId, ref: 'CustomerLocation' },
  toLocationId: { type: Schema.Types.ObjectId, ref: 'CustomerLocation' },
  fromDepartureTime: { type: Date },
  toArrivalTime: { type: Date },
  observedGapMinutes: { type: Schema.Types.Decimal128 },
  fromCoord: { type: [Number] },
  toCoord: { type: [Number] },
  mapboxDistanceMeters: { type: Number },
  mapboxDistanceMiles: { type: Number },
  mapboxDurationSeconds: { type: Number },
  mapboxDurationMinutes: { type: Number },
  mapboxDurationTrafficSeconds: { type: Number },
  profile: { type: String, enum: ['driving', 'driving-traffic'], required: true, default: 'driving' },
  geometry: { type: lineStringSchema },
  nonDrivingGapMinutes: { type: Schema.Types.Decimal128 },
  mapboxRequestHash: { type: String, required: true },
  mapboxResponseAt: { type: Date },
  calculationStatus: { type: String, enum: enums.LEG_STATUS, required: true, default: 'ok' },
  calculatedAt: { type: Date, required: true },
}, baseOptions);
routeLegSchema.index({ tenantId: 1, technicianId: 1, serviceDate: 1 });
routeLegSchema.index({ tenantId: 1, fromVisitId: 1, toVisitId: 1 }, { unique: true });
routeLegSchema.index({ tenantId: 1, routeId: 1, serviceDate: 1 });
routeLegSchema.index({ tenantId: 1, calculationStatus: 1 });

const mapboxRouteCacheSchema = new Schema({
  originHash: { type: String, required: true },
  destinationHash: { type: String, required: true },
  originCoord: { type: [Number], required: true },
  destinationCoord: { type: [Number], required: true },
  profile: { type: String, required: true },
  timeBucket: { type: String, required: true, default: 'any' },
  distanceMeters: { type: Number, required: true },
  durationSeconds: { type: Number, required: true },
  durationTrafficSeconds: { type: Number },
  geometry: { type: lineStringSchema },
  mapboxResponseAt: { type: Date, required: true },
  hitCount: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date },
}, baseOptions);
mapboxRouteCacheSchema.index(
  { originHash: 1, destinationHash: 1, profile: 1, timeBucket: 1 }, { unique: true }
);
mapboxRouteCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const routeDriveLegSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  dateKey: { type: String, required: true },
  routeCode: { type: String, required: true },
  fromInvoiceNumber: { type: String, required: true },
  toInvoiceNumber: { type: String, required: true },
  fromCustomer: { type: String },
  toCustomer: { type: String },
  fromCustomerId: { type: String },
  toCustomerId: { type: String },
  fromDeparture: { type: String },
  toArrival: { type: String },
  fromCoord: { type: [Number] },
  toCoord: { type: [Number] },
  observedGapMinutes: { type: Number },
  drivingMinutes: { type: Number },
  distanceMiles: { type: Number },
  extraTimeMinutes: { type: Number },
  status: { type: String, enum: ['ok', 'missing_coords', 'missing_times', 'negative_gap', 'same_location', 'mapbox_failed'], required: true, default: 'ok' },
  mapboxRequestHash: { type: String },
  computedAt: { type: Date, required: true },
}, baseOptions);
routeDriveLegSchema.index({ tenantId: 1, dateKey: 1, routeCode: 1, fromInvoiceNumber: 1, toInvoiceNumber: 1 }, { unique: true });
routeDriveLegSchema.index({ tenantId: 1, routeCode: 1, dateKey: 1 });
routeDriveLegSchema.index({ tenantId: 1, status: 1 });

const companyDistanceSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  fromCustomerId: { type: String, required: true },
  toCustomerId: { type: String, required: true },
  fromCompany: { type: String },
  toCompany: { type: String },
  fromCoord: { type: [Number] },
  toCoord: { type: [Number] },
  fromAddress: { type: String },
  toAddress: { type: String },
  source: { type: String, enum: ['invoices', 'mapdistance'], default: 'invoices' },
  distanceMiles: { type: Number, default: null },
  drivingMinutes: { type: Number, default: null },
  status: { type: String, enum: ['pending', 'ok', 'missing_coords', 'same_location', 'mapbox_failed'], required: true, default: 'pending' },
  mapboxRequestHash: { type: String },
  syncedAt: { type: Date },
}, baseOptions);
companyDistanceSchema.index({ tenantId: 1, fromCustomerId: 1, toCustomerId: 1 }, { unique: true });
companyDistanceSchema.index({ tenantId: 1, status: 1 });

module.exports = {
  RouteLeg: mongoose.model('RouteLeg', routeLegSchema),
  MapboxRouteCache: mongoose.model('MapboxRouteCache', mapboxRouteCacheSchema),
  RouteDriveLeg: mongoose.model('RouteDriveLeg', routeDriveLegSchema),
  CompanyDistance: mongoose.model('CompanyDistance', companyDistanceSchema),
};
