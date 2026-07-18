'use strict';
const mongoose = require('mongoose');
const { Schema, sourceSchema, effectiveDates, baseOptions, withSourceIndexes } = require('./common');

const routeSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  routeCode: { type: String, required: true, trim: true },
  sourceRouteId: { type: String, trim: true },
  routeName: { type: String },
  isActive: { type: Boolean, required: true, default: true },
  ...effectiveDates,
  source: { type: sourceSchema },
}, baseOptions);
routeSchema.index({ tenantId: 1, routeCode: 1 }, { unique: true });

const routeAssignmentHistorySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  routeId: { type: Schema.Types.ObjectId, ref: 'Route', required: true },
  technicianId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  assignmentType: { type: String, enum: ['primary', 'backup', 'observed'], required: true, default: 'primary' },
  ...effectiveDates,
  source: { type: sourceSchema },
}, baseOptions);
routeAssignmentHistorySchema.index({ tenantId: 1, routeId: 1, effectiveStart: -1 });
routeAssignmentHistorySchema.index({ tenantId: 1, technicianId: 1, effectiveStart: -1 });

module.exports = {
  Route: mongoose.model('Route', routeSchema),
  RouteAssignmentHistory: mongoose.model('RouteAssignmentHistory', routeAssignmentHistorySchema),
};
