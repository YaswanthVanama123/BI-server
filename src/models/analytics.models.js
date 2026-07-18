'use strict';
const mongoose = require('mongoose');
const { Schema, baseOptions } = require('./common');

const D = Schema.Types.Decimal128;
const OID = Schema.Types.ObjectId;

const categoryRevenueSchema = new Schema({
  serviceCategoryId: { type: OID, ref: 'ServiceCategory' },
  categoryCode: { type: String },
  revenue: { type: D },
  quantity: { type: D },
  stopCount: { type: Number },
}, { _id: false });

const dailyTechnicianMetricSchema = new Schema({
  tenantId: { type: OID, ref: 'Tenant', required: true },
  technicianId: { type: OID, ref: 'Employee', required: true },
  serviceDate: { type: Date, required: true },
  dateKey: { type: String, required: true },
  isoWeek: { type: String, required: true },
  monthKey: { type: String, required: true },
  department: { type: String },
  routeIds: { type: [OID], default: [] },
  stopCount: { type: Number, default: 0 },
  completedStops: { type: Number, default: 0 },
  cancelledStops: { type: Number, default: 0 },
  suspendedStops: { type: Number, default: 0 },
  missedStops: { type: Number, default: 0 },
  totalServiceMinutes: { type: D },
  totalDrivingMinutes: { type: D },
  totalNonDrivingGapMinutes: { type: D },
  availableHours: { type: D },
  loggedServiceHours: { type: D },
  utilizationPercentage: { type: D },
  benchmarkStopsPerDay: { type: Number },
  stopsVsBenchmark: { type: Number },
  revenue: { type: D },
  laborCost: { type: D },
  computedAt: { type: Date, required: true },
  sourceBatchIds: { type: [OID], default: [] },
}, baseOptions);
dailyTechnicianMetricSchema.index({ tenantId: 1, technicianId: 1, serviceDate: 1 }, { unique: true });
dailyTechnicianMetricSchema.index({ tenantId: 1, monthKey: 1 });

const monthlyRouteMetricSchema = new Schema({
  tenantId: { type: OID, ref: 'Tenant', required: true },
  routeId: { type: OID, ref: 'Route', required: true },
  monthKey: { type: String, required: true },
  totalRevenue: { type: D },
  lineItemRevenue: { type: D },
  revenueByCategory: { type: [categoryRevenueSchema], default: [] },
  totalStops: { type: Number, default: 0 },
  serviceHours: { type: D },
  drivingHours: { type: D },
  avgDriveBetweenStopsMin: { type: Number },
  revenuePerStop: { type: D },
  revenuePerTechnician: { type: D },
  laborCost: { type: D },
  supplyCost: { type: D },
  vehicleCost: { type: D },
  estContributionMargin: { type: D },
  contributionPerStop: { type: D },
  utilizationPct: { type: D },
  computedAt: { type: Date, required: true },
  sourceBatchIds: { type: [OID], default: [] },
}, baseOptions);
monthlyRouteMetricSchema.index({ tenantId: 1, routeId: 1, monthKey: 1 }, { unique: true });

const monthlyCustomerMetricSchema = new Schema({
  tenantId: { type: OID, ref: 'Tenant', required: true },
  customerId: { type: OID, ref: 'Customer', required: true },
  monthKey: { type: String, required: true },
  totalRevenue: { type: D },
  recurringRevenue: { type: D },
  oneTimeRevenue: { type: D },
  revenueByCategory: { type: [categoryRevenueSchema], default: [] },
  stopCount: { type: Number, default: 0 },
  revenuePerStop: { type: D },
  serviceHours: { type: D },
  drivingTimeMinutes: { type: D },
  laborCost: { type: D },
  frequency: { type: String },
  routeStatus: { type: String },
  customerProfitability: { type: D },
  momChangePct: { type: Number },
  yoyChangePct: { type: Number },
  computedAt: { type: Date, required: true },
  sourceBatchIds: { type: [OID], default: [] },
}, baseOptions);
monthlyCustomerMetricSchema.index({ tenantId: 1, customerId: 1, monthKey: 1 }, { unique: true });

const monthlyCategoryMetricSchema = new Schema({
  tenantId: { type: OID, ref: 'Tenant', required: true },
  serviceCategoryId: { type: OID, ref: 'ServiceCategory', required: true },
  monthKey: { type: String, required: true },
  routeId: { type: Schema.Types.Mixed, default: 'ALL' },
  technicianId: { type: Schema.Types.Mixed, default: 'ALL' },
  revenue: { type: D },
  quantity: { type: D },
  invoiceCount: { type: Number, default: 0 },
  stopCount: { type: Number, default: 0 },
  avgRevenuePerStop: { type: D },
  avgRevenuePerInvoice: { type: D },
  categoryRevenuePct: { type: Number },
  momChangePct: { type: Number },
  yoyChangePct: { type: Number },
  computedAt: { type: Date, required: true },
  sourceBatchIds: { type: [OID], default: [] },
}, baseOptions);
monthlyCategoryMetricSchema.index(
  { tenantId: 1, serviceCategoryId: 1, monthKey: 1, routeId: 1, technicianId: 1 }, { unique: true }
);

module.exports = {
  DailyTechnicianMetric: mongoose.model('DailyTechnicianMetric', dailyTechnicianMetricSchema),
  MonthlyRouteMetric: mongoose.model('MonthlyRouteMetric', monthlyRouteMetricSchema),
  MonthlyCustomerMetric: mongoose.model('MonthlyCustomerMetric', monthlyCustomerMetricSchema),
  MonthlyCategoryMetric: mongoose.model('MonthlyCategoryMetric', monthlyCategoryMetricSchema),
};
