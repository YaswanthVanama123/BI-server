'use strict';
const { models } = require('../../models');
const { dqIssue } = require('../importBatchRunner');
const { clean, norm, dqStatus, sourceStage } = require('./_shared');
const { toMoney, moneyToNum } = require('../../utils/util');

const {
  Employee, EmployeeSourceMapping, PayrollPeriod, PayrollEntry, EmployeeAvailability, BusinessRule,
} = models;

const ALIASES = {
  employeeName: ['employee name', 'employee', 'name', 'worker name', 'associate name'],
  employeeId: ['employee id', 'emp id', 'file number', 'associate id', 'employee number', 'id'],
  department: ['department', 'dept', 'home department'],
  appliedRate: ['applied rate', 'rate', 'pay rate', 'hourly rate', 'regular rate'],
  regularHours: ['regular hours', 'reg hours', 'regular hrs', 'reg', 'hours'],
  overtimeHours: ['overtime hours', 'ot hours', 'overtime', 'ot'],
  vacationHours: ['vacation hours', 'vacation', 'vac hours', 'pto hours', 'pto'],
  sickHours: ['sick hours', 'sick', 'sick absence hours', 'absence hours', 'absence'],
  otherHours: ['other hours', 'other unavailable hours', 'holiday hours', 'holiday'],
  salaryAmount: ['salary amount', 'salary'],
  bonusAmount: ['bonus amount', 'bonus'],
  commissionAmount: ['commission amount', 'commission'],
  miscReimbursement: ['miscellaneous reimbursement', 'misc reimbursement', 'reimbursement', 'misc'],
  periodStart: ['payroll period start', 'period start', 'pay period start', 'period begin', 'start date', 'pay period begin'],
  periodEnd: ['payroll period end', 'period end', 'pay period end', 'end date'],
  checkDate: ['check date', 'pay date', 'payment date', 'check dt'],
};
const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ALIAS_INDEX = (() => {
  const idx = new Map();
  for (const [field, list] of Object.entries(ALIASES)) for (const a of list) idx.set(normHeader(a), field);
  return idx;
})();

function mapRow(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const field = ALIAS_INDEX.get(normHeader(k));
    if (field && out[field] === undefined) out[field] = v;
  }
  return out;
}

function numOf(v) { if (v == null || v === '') return 0; const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isNaN(n) ? 0 : n; }
function parseDate(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(`${s.slice(0, 10)}T00:00:00Z`); return Number.isNaN(d.getTime()) ? undefined : d; }
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; const d = new Date(Date.UTC(y, +m[1] - 1, +m[2])); return Number.isNaN(d.getTime()) ? undefined : d; }
  const d = new Date(s); return Number.isNaN(d.getTime()) ? undefined : d;
}
function dayCount(a, b) { return Math.round((b - a) / 86400000) + 1; }
function payFrequency(days) {
  if (days <= 8) return 'weekly';
  if (days <= 15) return 'biweekly';
  if (days <= 17) return 'semimonthly';
  return 'monthly';
}
function escapeRe(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function swapComma(name) { const p = String(name || '').split(','); return p.length === 2 ? `${p[1].trim()} ${p[0].trim()}` : null; }

async function ruleNumber(tenantId, key, fallback) {
  const r = await BusinessRule.findOne({ tenantId, key }).sort({ effectiveStart: -1 }).lean();
  return r ? Number(r.value) : fallback;
}

async function resolveEmployee(tenant, m, now) {
  const name = clean(m.employeeName);
  const empId = clean(m.employeeId);
  const nname = norm(name);
  const alt = swapComma(name);
  const nalt = alt ? norm(alt) : null;
  let emp = null;
  if (empId) emp = await Employee.findOne({ tenantId: tenant._id, adpEmployeeId: empId }, { _id: 1, department: 1 }).lean();
  if (!emp && nname) emp = await Employee.findOne({ tenantId: tenant._id, employeeCode: `RS:${nname}` }, { _id: 1 }).lean();
  if (!emp && nalt) emp = await Employee.findOne({ tenantId: tenant._id, employeeCode: `RS:${nalt}` }, { _id: 1 }).lean();
  if (!emp && name) emp = await Employee.findOne({ tenantId: tenant._id, fullName: new RegExp(`^${escapeRe(name)}$`, 'i') }, { _id: 1 }).lean();
  if (!emp && alt) emp = await Employee.findOne({ tenantId: tenant._id, fullName: new RegExp(`^${escapeRe(alt)}$`, 'i') }, { _id: 1 }).lean();
  if (!emp) {
    const code = empId ? `ADP:${empId}` : `ADP:${nname || Date.now()}`;
    await Employee.updateOne(
      { tenantId: tenant._id, employeeCode: code },
      { $set: { tenantId: tenant._id, employeeCode: code, fullName: name || code, isTechnician: true, employmentType: m.employmentType, status: 'active' } },
      { upsert: true },
    );
    emp = await Employee.findOne({ tenantId: tenant._id, employeeCode: code }, { _id: 1 }).lean();
  }
  await Employee.updateOne({ _id: emp._id }, { $set: { employmentType: m.employmentType, ...(empId ? { adpEmployeeId: empId } : {}), ...(m.department ? { department: m.department } : {}) } });
  if (empId || nname) {
    await EmployeeSourceMapping.updateOne(
      { tenantId: tenant._id, sourceSystem: 'adp', sourceEmployeeId: empId || nname },
      { $set: { tenantId: tenant._id, employeeId: emp._id, sourceSystem: 'adp', sourceEmployeeId: empId || nname, sourceEmployeeName: name, nameNormalization: nname, confidence: empId ? 'exact' : 'fuzzy', isActive: true } },
      { upsert: true },
    );
  }
  return emp._id;
}

module.exports = {
  name: 'adp_payroll',
  sourceSystem: 'adp',
  sourceEntity: 'payroll_entry',
  rawModel: models.RawAdpPayroll,

  getSourceRecordId(row) {
    const m = mapRow(row);
    const id = clean(m.employeeId) || norm(m.employeeName) || 'unknown';
    const ps = parseDate(m.periodStart); const pe = parseDate(m.periodEnd);
    return `${id}:${ps ? ps.toISOString().slice(0, 10) : '?'}:${pe ? pe.toISOString().slice(0, 10) : '?'}`;
  },

  async processRecord(row, ctx) {
    const { tenant, batch, now, sourceRecordId, recordHash } = ctx;
    const dq = [];
    const m = mapRow(row);
    m.employmentType = numOf(m.salaryAmount) > 0 && numOf(m.regularHours) === 0 ? 'salaried' : 'hourly';

    const periodStart = parseDate(m.periodStart);
    const periodEnd = parseDate(m.periodEnd);
    if (!periodStart || !periodEnd) {
      dq.push(dqIssue(tenant, batch, 'payroll_period_missing', 'error', 'payrollEntries', null, sourceRecordId, 'adp', `Payroll row missing period start/end for ${clean(m.employeeName) || '?'}`, now));
      return { syncStatus: 'rejected', curatedTouches: {}, dq };
    }
    const checkDate = parseDate(m.checkDate);

    const employeeId = await resolveEmployee(tenant, m, now);

    await PayrollPeriod.updateOne(
      { tenantId: tenant._id, periodStart, periodEnd },
      [{ $set: {
        tenantId: tenant._id, periodStart, periodEnd,
        payFrequency: payFrequency(dayCount(periodStart, periodEnd)),
        checkDate, status: 'closed',
        source: sourceStage(`PERIOD:${periodStart.toISOString().slice(0, 10)}:${periodEnd.toISOString().slice(0, 10)}`, 'payroll_period', 'period', batch._id, now, 'clean'),
      } }],
      { upsert: true },
    );
    const period = await PayrollPeriod.findOne({ tenantId: tenant._id, periodStart, periodEnd }, { _id: 1 }).lean();

    const rate = numOf(m.appliedRate);
    const regular = numOf(m.regularHours);
    const overtime = numOf(m.overtimeHours);
    const vacation = numOf(m.vacationHours);
    const sick = numOf(m.sickHours);
    const other = numOf(m.otherHours);
    const salary = numOf(m.salaryAmount);
    const laborCost = rate * regular + rate * 1.5 * overtime + salary + numOf(m.bonusAmount) + numOf(m.commissionAmount);

    await PayrollEntry.updateOne(
      { tenantId: tenant._id, employeeId, payrollPeriodId: period._id },
      [{ $set: {
        tenantId: tenant._id, employeeId, payrollPeriodId: period._id, department: clean(m.department),
        appliedRate: toMoney(rate), regularHours: toMoney(regular), overtimeHours: toMoney(overtime),
        vacationHours: toMoney(vacation), sickHours: toMoney(sick), otherUnavailableHours: toMoney(other),
        salaryAmount: toMoney(salary), bonusAmount: toMoney(m.bonusAmount), commissionAmount: toMoney(m.commissionAmount),
        miscReimbursement: toMoney(m.miscReimbursement), checkDate, computedLaborCost: toMoney(laborCost),
        source: sourceStage(sourceRecordId, 'payroll_entry', recordHash, batch._id, now, dqStatus(dq)),
      } }],
      { upsert: true },
    );

    const days = dayCount(periodStart, periodEnd);
    let scheduled = regular + vacation + sick + other;
    if (scheduled === 0 && m.employmentType === 'salaried') {
      const monthly = await ruleNumber(tenant._id, 'salariedDefaultAvailableHours', 173);
      scheduled = Math.round((monthly * days) / 30.44);
    }
    const available = Math.max(0, scheduled - vacation - sick - other);
    await EmployeeAvailability.updateOne(
      { tenantId: tenant._id, employeeId, payrollPeriodId: period._id },
      { $set: {
        tenantId: tenant._id, employeeId, payrollPeriodId: period._id,
        scheduledHours: toMoney(scheduled), vacationHours: toMoney(vacation), sickHours: toMoney(sick),
        otherUnavailableHours: toMoney(other), availableHours: toMoney(available),
        computationNote: `${m.employmentType}; ${days}-day period`,
      } },
      { upsert: true },
    );

    return {
      syncStatus: 'updated',
      controlAmount: laborCost, loadedAmount: laborCost, watermark: checkDate,
      curatedTouches: {}, dq,
    };
  },

  async recalcAffected() {  },
};
