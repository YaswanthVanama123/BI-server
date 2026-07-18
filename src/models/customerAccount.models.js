'use strict';
const mongoose = require('mongoose');
const { Schema, baseOptions } = require('./common');

const pricingLineSchema = new Schema({
  item: { type: String },
  description: { type: String },
  cost: { type: Number },
  salesPrice: { type: Number },
  defaultQty: { type: String },
  frequency: { type: String },
}, { _id: false });

const customerAccountSchema = new Schema({
  customerId: { type: String, required: true, unique: true },
  customerName: { type: String },
  company: { type: String },
  accountNumber: { type: String, default: null },
  serviceAddress1: { type: String },
  serviceAddress2: { type: String },
  serviceAddress3: { type: String },
  serviceCity: { type: String },
  serviceState: { type: String },
  serviceZip: { type: String },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  zone: { type: String },
  pricing: { type: [pricingLineSchema], default: [] },
  routes: { type: [Schema.Types.Mixed], default: [] },
  detailUrl: { type: String },
  status: { type: String, enum: ['ok', 'no_account', 'error'], default: 'ok' },
  error: { type: String },
  fetchedAt: { type: Date },
}, baseOptions);
customerAccountSchema.index({ accountNumber: 1 });

module.exports = {
  CustomerAccount: mongoose.model('CustomerAccount', customerAccountSchema),
};
