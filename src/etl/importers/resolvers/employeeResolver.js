'use strict';
const { models } = require('../../../models');
const { Employee, EmployeeSourceMapping } = models;

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

async function resolveEmployeeById(tenant, sourceSystem, sourceEmployeeId) {
  if (!sourceEmployeeId) return null;
  const map = await EmployeeSourceMapping.findOne({
    tenantId: tenant._id, sourceSystem, sourceEmployeeId: String(sourceEmployeeId).trim(), isActive: true,
  });
  return map ? Employee.findById(map.employeeId) : null;
}

async function resolveEmployeeByTechName(tenant, techName) {
  const norm = normalizeName(techName);
  if (!norm) return null;
  const map = await EmployeeSourceMapping.findOne({
    tenantId: tenant._id, sourceSystem: 'routestar', nameNormalization: norm, isActive: true,
  });
  if (map) return Employee.findById(map.employeeId);
  return Employee.findOne({ tenantId: tenant._id, fullName: new RegExp(`^${escapeRe(techName)}$`, 'i') });
}

function escapeRe(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { normalizeName, resolveEmployeeById, resolveEmployeeByTechName };
