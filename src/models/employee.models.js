'use strict';
const mongoose = require('mongoose');
const { Schema, sourceSchema, effectiveDates, baseOptions, withSourceIndexes, enums } = require('./common');

const employeeSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeCode: { type: String, required: true, trim: true },
  adpEmployeeId: { type: String, trim: true },
  routeStarTechId: { type: String, trim: true },
  fullName: { type: String, required: true },
  department: { type: String },
  employmentType: { type: String, enum: enums.EMPLOYMENT_TYPE, required: true },
  isTechnician: { type: Boolean, required: true, default: true },
  status: { type: String, enum: ['active', 'inactive', 'terminated'], required: true, default: 'active' },
  hireDate: { type: Date },
  terminationDate: { type: Date },
  source: { type: sourceSchema },
}, baseOptions);
employeeSchema.index({ tenantId: 1, employeeCode: 1 }, { unique: true });
employeeSchema.index({ tenantId: 1, adpEmployeeId: 1 }, { sparse: true });
employeeSchema.index({ tenantId: 1, routeStarTechId: 1 }, { sparse: true });
employeeSchema.index({ tenantId: 1, isTechnician: 1, status: 1 });

const employeeSourceMappingSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  sourceSystem: { type: String, enum: ['adp', 'routestar', 'fastcash'], required: true },
  sourceEmployeeId: { type: String, trim: true },
  sourceEmployeeName: { type: String },
  nameNormalization: { type: String },
  confidence: { type: String, enum: ['exact', 'manual', 'fuzzy'], required: true, default: 'exact' },
  isActive: { type: Boolean, required: true, default: true },
}, baseOptions);
employeeSourceMappingSchema.index(
  { tenantId: 1, sourceSystem: 1, sourceEmployeeId: 1 },
  { unique: true, partialFilterExpression: { sourceEmployeeId: { $type: 'string' } } }
);
employeeSourceMappingSchema.index({ tenantId: 1, sourceSystem: 1, nameNormalization: 1 });

const employeeRateHistorySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  rateType: { type: String, enum: ['base_hourly', 'overtime', 'skill_tier', 'salary_annual'], required: true },
  skillTier: { type: String },
  rate: { type: Schema.Types.Decimal128, required: true },
  ...effectiveDates,
  source: { type: sourceSchema, required: true },
}, baseOptions);
employeeRateHistorySchema.index({ tenantId: 1, employeeId: 1, effectiveStart: -1 });

const laborCostRateSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  scope: { type: String, enum: ['employee', 'skill_tier', 'department', 'default'], required: true },
  employeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
  skillTier: { type: String },
  department: { type: String },
  baseHourly: { type: Schema.Types.Decimal128 },
  burdenMultiplier: { type: Schema.Types.Decimal128, required: true, default: '1.35' },
  burdenedHourly: { type: Schema.Types.Decimal128 },
  ...effectiveDates,
}, baseOptions);
laborCostRateSchema.index({ tenantId: 1, scope: 1, effectiveStart: -1 });

const payrollPeriodSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  payFrequency: { type: String, enum: ['weekly', 'biweekly', 'semimonthly', 'monthly'], required: true },
  checkDate: { type: Date },
  status: { type: String, enum: ['open', 'closed'], required: true, default: 'open' },
  source: { type: sourceSchema, required: true },
}, baseOptions);
payrollPeriodSchema.index({ tenantId: 1, periodStart: 1, periodEnd: 1 });
payrollPeriodSchema.index({ tenantId: 1, payFrequency: 1 });

const payrollEntrySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  payrollPeriodId: { type: Schema.Types.ObjectId, ref: 'PayrollPeriod', required: true },
  employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  department: { type: String },
  availableRates: { type: [Schema.Types.Decimal128], default: [] },
  appliedRate: { type: Schema.Types.Decimal128 },
  regularHours: { type: Schema.Types.Decimal128, required: true, default: '0' },
  overtimeHours: { type: Schema.Types.Decimal128, required: true, default: '0' },
  vacationHours: { type: Schema.Types.Decimal128, required: true, default: '0' },
  sickHours: { type: Schema.Types.Decimal128, required: true, default: '0' },
  otherUnavailableHours: { type: Schema.Types.Decimal128, required: true, default: '0' },
  salaryAmount: { type: Schema.Types.Decimal128 },
  bonusAmount: { type: Schema.Types.Decimal128 },
  commissionAmount: { type: Schema.Types.Decimal128 },
  miscReimbursement: { type: Schema.Types.Decimal128 },
  checkDate: { type: Date },
  computedLaborCost: { type: Schema.Types.Decimal128 },
  source: { type: sourceSchema, required: true },
}, baseOptions);
payrollEntrySchema.index({ tenantId: 1, employeeId: 1, payrollPeriodId: 1 }, { unique: true });
payrollEntrySchema.index({ tenantId: 1, 'source.sourceRecordId': 1 }, { unique: true });
payrollEntrySchema.index({ tenantId: 1, payrollPeriodId: 1 });

const employeeAvailabilitySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  payrollPeriodId: { type: Schema.Types.ObjectId, ref: 'PayrollPeriod', required: true },
  scheduledHours: { type: Schema.Types.Decimal128, required: true },
  vacationHours: { type: Schema.Types.Decimal128, required: true, default: '0' },
  sickHours: { type: Schema.Types.Decimal128, required: true, default: '0' },
  otherUnavailableHours: { type: Schema.Types.Decimal128, required: true, default: '0' },
  availableHours: { type: Schema.Types.Decimal128, required: true },
  computationNote: { type: String },
}, baseOptions);
employeeAvailabilitySchema.index({ tenantId: 1, employeeId: 1, payrollPeriodId: 1 }, { unique: true });

module.exports = {
  Employee: mongoose.model('Employee', withSourceIndexes(employeeSchema)),
  EmployeeSourceMapping: mongoose.model('EmployeeSourceMapping', employeeSourceMappingSchema),
  EmployeeRateHistory: mongoose.model('EmployeeRateHistory', employeeRateHistorySchema),
  LaborCostRate: mongoose.model('LaborCostRate', laborCostRateSchema),
  PayrollPeriod: mongoose.model('PayrollPeriod', withSourceIndexes(payrollPeriodSchema)),
  PayrollEntry: mongoose.model('PayrollEntry', withSourceIndexes(payrollEntrySchema)),
  EmployeeAvailability: mongoose.model('EmployeeAvailability', employeeAvailabilitySchema),
};
