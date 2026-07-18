'use strict';
const { models } = require('../../../models');
const { Route, RouteAssignmentHistory } = models;

async function routeIdByCode(tenant, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const r = await Route.findOne({ tenantId: tenant._id, routeCode: c });
  return r ? r._id : null;
}

async function attributeRoute(tenant, { visitRouteCode, invoiceRouteCode, technician, customer, serviceDate }) {
  let id = await routeIdByCode(tenant, visitRouteCode);
  if (id) return { routeId: id, method: 'visit', confidence: 'high' };

  id = await routeIdByCode(tenant, invoiceRouteCode);
  if (id) return { routeId: id, method: 'invoice', confidence: 'medium' };

  if (technician) {
    const asg = await RouteAssignmentHistory.findOne({
      tenantId: tenant._id, technicianId: technician._id,
      effectiveStart: { $lte: serviceDate },
      $or: [{ effectiveEnd: null }, { effectiveEnd: { $gte: serviceDate } }],
    }).sort({ effectiveStart: -1 });
    if (asg) return { routeId: asg.routeId, method: 'tech_assignment', confidence: 'medium' };
  }

  if (customer && customer.defaultRouteId) {
    return { routeId: customer.defaultRouteId, method: 'customer_default', confidence: 'low' };
  }

  return { routeId: undefined, method: 'unassigned', confidence: 'low' };
}

module.exports = { attributeRoute, routeIdByCode };
