'use strict';
const mongoose = require('mongoose');
const { Schema, sourceSchema, effectiveDates, baseOptions, withSourceIndexes, enums } = require('./common');

const serviceCategorySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  categoryCode: { type: String, required: true, trim: true },
  name: { type: String, required: true },
  isRevenueCategory: { type: Boolean, required: true, default: true },
  isUnmapped: { type: Boolean, required: true, default: false },
  sortOrder: { type: Number },
}, baseOptions);
serviceCategorySchema.index({ tenantId: 1, categoryCode: 1 }, { unique: true });

const serviceItemSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  itemCode: { type: String, required: true, trim: true },
  description: { type: String, required: true },
  serviceCategoryId: { type: Schema.Types.ObjectId, ref: 'ServiceCategory', required: true },
  unitOfMeasure: { type: String },
  isActive: { type: Boolean, required: true, default: true },
  sourceItemIds: { type: [String], default: [] },
  source: { type: sourceSchema },
}, baseOptions);
serviceItemSchema.index({ tenantId: 1, itemCode: 1 }, { unique: true });
serviceItemSchema.index({ tenantId: 1, sourceItemIds: 1 });

const itemCategoryMappingSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  matchType: { type: String, enum: ['exact_code', 'code_prefix', 'description_regex'], required: true },
  matchValue: { type: String, required: true },
  serviceItemId: { type: Schema.Types.ObjectId, ref: 'ServiceItem' },
  serviceCategoryId: { type: Schema.Types.ObjectId, ref: 'ServiceCategory', required: true },
  priority: { type: Number, required: true, default: 100 },
  isActive: { type: Boolean, required: true, default: true },
  reviewStatus: { type: String, enum: ['approved', 'pending_review', 'rejected'], required: true, default: 'pending_review' },
  createdBy: { type: String },
  updatedBy: { type: String },
}, baseOptions);
itemCategoryMappingSchema.index({ tenantId: 1, matchType: 1, matchValue: 1 }, { unique: true });
itemCategoryMappingSchema.index({ tenantId: 1, reviewStatus: 1 });

const frequencyDefinitionSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  normalizedFrequency: { type: String, enum: enums.FREQUENCY, required: true },
  visitsPerYear: { type: Schema.Types.Decimal128, required: true },
  sourceTextPatterns: { type: [String], required: true },
  isRecurring: { type: Boolean, required: true, default: true },
}, baseOptions);
frequencyDefinitionSchema.index({ tenantId: 1, normalizedFrequency: 1 }, { unique: true });

const customerPricingAgreementSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  routeStarAccountNumber: { type: String },
  agreementSourceId: { type: String },
  currency: { type: String, required: true, default: 'USD' },
  isActive: { type: Boolean, required: true, default: true },
  ...effectiveDates,
  source: { type: sourceSchema, required: true },
}, baseOptions);
customerPricingAgreementSchema.index({ tenantId: 1, customerId: 1, isActive: 1, effectiveStart: -1 });

const customerPricingItemSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  agreementId: { type: Schema.Types.ObjectId, ref: 'CustomerPricingAgreement', required: true },
  serviceItemId: { type: Schema.Types.ObjectId, ref: 'ServiceItem', required: true },
  serviceCategoryId: { type: Schema.Types.ObjectId, ref: 'ServiceCategory', required: true },
  sourceItemCode: { type: String, required: true },
  sourceDescription: { type: String },
  pricingRowSourceId: { type: String },
  cost: { type: Schema.Types.Decimal128 },
  salesPrice: { type: Schema.Types.Decimal128, required: true },
  defaultQuantity: { type: Schema.Types.Decimal128, required: true },
  unitOfMeasure: { type: String },
  sourceFrequencyText: { type: String },
  normalizedFrequency: { type: String, enum: enums.FREQUENCY, required: true },
  taxApplicable: { type: Boolean },
  currency: { type: String, required: true, default: 'USD' },
  isActive: { type: Boolean, required: true, default: true },
  ...effectiveDates,
  source: { type: sourceSchema, required: true },
}, baseOptions);
customerPricingItemSchema.index({ tenantId: 1, customerId: 1, isActive: 1, effectiveStart: -1 });
customerPricingItemSchema.index({ tenantId: 1, serviceItemId: 1, effectiveStart: -1 });
customerPricingItemSchema.index(
  { tenantId: 1, 'source.sourceSystem': 1, 'source.sourceRecordId': 1, effectiveStart: 1 },
  { unique: true, name: 'uniq_pricing_history' }
);
customerPricingItemSchema.index({ tenantId: 1, 'source.sourceModifiedAt': 1 });

module.exports = {
  ServiceCategory: mongoose.model('ServiceCategory', serviceCategorySchema),
  ServiceItem: mongoose.model('ServiceItem', serviceItemSchema),
  ItemCategoryMapping: mongoose.model('ItemCategoryMapping', itemCategoryMappingSchema),
  FrequencyDefinition: mongoose.model('FrequencyDefinition', frequencyDefinitionSchema),
  CustomerPricingAgreement: mongoose.model('CustomerPricingAgreement', withSourceIndexes(customerPricingAgreementSchema)),
  CustomerPricingItem: mongoose.model('CustomerPricingItem', customerPricingItemSchema),
};
