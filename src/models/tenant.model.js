'use strict';
const mongoose = require('mongoose');
const { Schema, baseOptions } = require('./common');

const tenantSchema = new Schema({
  tenantCode: { type: String, required: true, trim: true },
  name: { type: String, required: true },
  reportingTimezone: { type: String, required: true, default: 'America/New_York' },
  currency: { type: String, required: true, default: 'USD' },
  fiscalYearStartMonth: { type: Number, required: true, min: 1, max: 12, default: 1 },
  active: { type: Boolean, required: true, default: true },
}, baseOptions);

tenantSchema.index({ tenantCode: 1 }, { unique: true });

module.exports = mongoose.model('Tenant', tenantSchema);
