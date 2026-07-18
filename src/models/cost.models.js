'use strict';
const mongoose = require('mongoose');
const { Schema, sourceSchema, effectiveDates, baseOptions } = require('./common');

const supplyCostSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  serviceItemId: { type: Schema.Types.ObjectId, ref: 'ServiceItem' },
  serviceVisitId: { type: Schema.Types.ObjectId, ref: 'ServiceVisit' },
  routeId: { type: Schema.Types.ObjectId, ref: 'Route' },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  costType: { type: String, enum: ['per_job', 'per_item', 'allocation'], required: true },
  amount: { type: Schema.Types.Decimal128, required: true },
  ...effectiveDates,
  source: { type: sourceSchema, required: true },
}, baseOptions);
supplyCostSchema.index({ tenantId: 1, serviceItemId: 1, effectiveStart: -1 });
supplyCostSchema.index({ tenantId: 1, routeId: 1 });

const serviceItemCostHistorySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  serviceItemId: { type: Schema.Types.ObjectId, ref: 'ServiceItem', required: true },
  unitCost: { type: Schema.Types.Decimal128, required: true },
  ...effectiveDates,
  source: { type: sourceSchema, required: true },
}, baseOptions);
serviceItemCostHistorySchema.index({ tenantId: 1, serviceItemId: 1, effectiveStart: -1 });

const vehicleCostSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  allocationBasis: { type: String, enum: ['per_tech', 'per_route', 'fixed_pool'], required: true },
  routeId: { type: Schema.Types.ObjectId, ref: 'Route' },
  employeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
  periodMonthKey: { type: String, required: true },
  amount: { type: Schema.Types.Decimal128, required: true },
  source: { type: sourceSchema },
}, baseOptions);
vehicleCostSchema.index({ tenantId: 1, periodMonthKey: 1, allocationBasis: 1 });

const costAllocationRuleSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  ruleType: { type: String, enum: ['labor', 'supply', 'vehicle', 'other'], required: true },
  basis: { type: String, enum: ['per_stop', 'per_hour', 'per_mile', 'revenue_share', 'equal_split'], required: true },
  params: { type: Schema.Types.Mixed },
  active: { type: Boolean, required: true, default: true },
  ...effectiveDates,
}, baseOptions);
costAllocationRuleSchema.index({ tenantId: 1, ruleType: 1, active: 1, effectiveStart: -1 });

const businessRuleSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  key: { type: String, required: true },
  value: { type: Schema.Types.Mixed, required: true },
  valueType: { type: String, enum: ['number', 'string', 'boolean', 'json'], required: true },
  updatedBy: { type: String },
  ...effectiveDates,
}, baseOptions);
businessRuleSchema.index({ tenantId: 1, key: 1, effectiveStart: -1 });

module.exports = {
  SupplyCost: mongoose.model('SupplyCost', supplyCostSchema),
  ServiceItemCostHistory: mongoose.model('ServiceItemCostHistory', serviceItemCostHistorySchema),
  VehicleCost: mongoose.model('VehicleCost', vehicleCostSchema),
  CostAllocationRule: mongoose.model('CostAllocationRule', costAllocationRuleSchema),
  BusinessRule: mongoose.model('BusinessRule', businessRuleSchema),
};
