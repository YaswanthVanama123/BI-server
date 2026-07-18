'use strict';
const mongoose = require('mongoose');
const { Schema, baseOptions } = require('./common');

const lineSchema = new Schema({
  item: { type: String },
  description: { type: String },
  rate: { type: Number },
  amount: { type: Number },
  frequency: { type: String, default: null },
}, { _id: false });

const invoiceFrequencySchema = new Schema({
  invoiceNumber: { type: String, required: true, unique: true },
  customerId: { type: String },
  customer: { type: String },
  lines: { type: [lineSchema], default: [] },
  matchedAt: { type: Date },
}, baseOptions);

module.exports = { InvoiceFrequency: mongoose.model('InvoiceFrequency', invoiceFrequencySchema) };
