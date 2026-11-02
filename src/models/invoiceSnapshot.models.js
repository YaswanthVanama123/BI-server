'use strict';
const mongoose = require('mongoose');
const { Schema, baseOptions } = require('./common');

const lineSchema = new Schema({
  name: { type: String },
  description: { type: String },
  quantity: { type: Number },
  rate: { type: Number },
  amount: { type: Number },
  class: { type: String },
  warehouse: { type: String },
  taxCode: { type: String },
  location: { type: String },
}, { _id: false });

const invoiceSnapshotSchema = new Schema({
  invoiceNumber: { type: String, required: true, unique: true },
  status: { type: String, enum: ['ok', 'error'], default: 'ok' },
  detailUrl: { type: String },
  subtotal: { type: Number },
  tax: { type: Number },
  total: { type: Number },
  linesTotal: { type: Number },
  lineItems: { type: [lineSchema], default: [] },
  sourceSubtotal: { type: Number },
  sourceLinesTotal: { type: Number },
  sourceLastModified: { type: Date },
  reason: { type: String },
  fetchedAt: { type: Date },
  attempts: { type: Number, default: 0 },
  lastError: { type: String },
  lastErrorAt: { type: Date },
}, baseOptions);
invoiceSnapshotSchema.index({ status: 1, fetchedAt: -1 });

module.exports = { InvoiceSnapshot: mongoose.model('InvoiceSnapshot', invoiceSnapshotSchema) };
