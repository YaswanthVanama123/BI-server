'use strict';
const { models } = require('../../models');

function stopsPerTechnician(tenantId, { monthKey, benchmark = 10 }) {
  return [
    { $match: { tenantId, monthKey } },
    { $group: {
        _id: { tech: '$technicianId', day: '$dateKey' },
        stops: { $sum: { $cond: [{ $eq: ['$completionStatus', 'completed'] }, 1, 0] } },
        serviceMinutes: { $sum: { $toDouble: '$serviceDurationMinutes' } },
    } },
    { $group: {
        _id: '$_id.tech',
        totalStops: { $sum: '$stops' },
        workingDays: { $sum: { $cond: [{ $gt: ['$stops', 0] }, 1, 0] } },
        totalServiceMinutes: { $sum: '$serviceMinutes' },
    } },
    { $addFields: {
        avgStopsPerWorkingDay: { $cond: [{ $gt: ['$workingDays', 0] }, { $divide: ['$totalStops', '$workingDays'] }, 0] },
        stopsVsBenchmark: { $subtract: [{ $cond: [{ $gt: ['$workingDays', 0] }, { $divide: ['$totalStops', '$workingDays'] }, 0] }, benchmark] },
    } },
  ];
}

function dailyTechnicianForKey(tenantId, technicianId, dateKey) {
  return [
    { $match: { tenantId, technicianId, dateKey } },
    { $group: {
        _id: { tenantId: '$tenantId', technicianId: '$technicianId', dateKey: '$dateKey' },
        serviceDate: { $first: '$serviceDate' }, isoWeek: { $first: '$isoWeek' }, monthKey: { $first: '$monthKey' },
        routeIds: { $addToSet: '$routeId' },
        stopCount: { $sum: 1 },
        completedStops: { $sum: { $cond: [{ $eq: ['$completionStatus', 'completed'] }, 1, 0] } },
        cancelledStops: { $sum: { $cond: [{ $eq: ['$completionStatus', 'cancelled'] }, 1, 0] } },
        suspendedStops: { $sum: { $cond: [{ $eq: ['$completionStatus', 'suspended'] }, 1, 0] } },
        missedStops: { $sum: { $cond: [{ $eq: ['$completionStatus', 'missed'] }, 1, 0] } },
        totalServiceMinutes: { $sum: { $toDouble: '$serviceDurationMinutes' } },
    } },
  ];
}

function revenueByCategory(tenantId, monthKey) {
  return [
    { $match: { tenantId, monthKey, isRevenueRecognized: true } },
    { $group: {
        _id: '$serviceCategoryId',
        revenue: { $sum: { $toDecimal: '$sourceAmount' } },
        quantity: { $sum: { $toDecimal: '$quantity' } },
        invoiceIds: { $addToSet: '$invoiceId' },
        visitIds: { $addToSet: '$serviceVisitId' },
    } },
    { $addFields: {
        invoiceCount: { $size: '$invoiceIds' },
        stopCount: { $size: { $setDifference: ['$visitIds', [null]] } },
    } },
    { $addFields: {
        avgRevenuePerInvoice: { $cond: [{ $gt: ['$invoiceCount', 0] }, { $divide: ['$revenue', '$invoiceCount'] }, null] },
        avgRevenuePerStop: { $cond: [{ $gt: ['$stopCount', 0] }, { $divide: ['$revenue', '$stopCount'] }, null] },
    } },
  ];
}

function revenueByRoute(tenantId, monthKey) {
  return [
    { $match: { tenantId, monthKey, isRevenueRecognized: true } },
    { $group: {
        _id: '$routeId',
        lineItemRevenue: { $sum: { $toDecimal: '$sourceAmount' } },
        revenueByCategory: { $push: { serviceCategoryId: '$serviceCategoryId', revenue: { $toDecimal: '$sourceAmount' } } },
        visitIds: { $addToSet: '$serviceVisitId' },
    } },
    { $addFields: { stopCount: { $size: { $setDifference: ['$visitIds', [null]] } } } },
  ];
}

function revenueByCustomer(tenantId, monthKey) {
  return [
    { $match: { tenantId, monthKey, isRevenueRecognized: true } },
    { $lookup: { from: models.Invoice.collection.name, localField: 'invoiceId', foreignField: '_id', as: 'inv' } },
    { $addFields: { invoiceType: { $ifNull: [{ $arrayElemAt: ['$inv.invoiceType', 0] }, 'unknown'] } } },
    { $group: {
        _id: '$customerId',
        totalRevenue: { $sum: { $toDecimal: '$sourceAmount' } },
        recurringRevenue: { $sum: { $cond: [{ $eq: ['$invoiceType', 'recurring'] }, { $toDecimal: '$sourceAmount' }, 0] } },
        oneTimeRevenue: { $sum: { $cond: [{ $eq: ['$invoiceType', 'one_time'] }, { $toDecimal: '$sourceAmount' }, 0] } },
        revenueByCategory: { $push: { serviceCategoryId: '$serviceCategoryId', revenue: { $toDecimal: '$sourceAmount' } } },
        visitIds: { $addToSet: '$serviceVisitId' },
    } },
    { $addFields: { stopCount: { $size: { $setDifference: ['$visitIds', [null]] } } } },
    { $addFields: { revenuePerStop: { $cond: [{ $gt: ['$stopCount', 0] }, { $divide: ['$totalRevenue', '$stopCount'] }, null] } } },
  ];
}

function monthlyStopVolume(tenantId, monthKeys, dimensionField = 'routeId') {
  return [
    { $match: { tenantId, monthKey: { $in: monthKeys } } },
    { $group: {
        _id: { month: '$monthKey', dim: `$${dimensionField}` },
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$completionStatus', 'completed'] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$completionStatus', 'cancelled'] }, 1, 0] } },
        suspended: { $sum: { $cond: [{ $eq: ['$completionStatus', 'suspended'] }, 1, 0] } },
        missed: { $sum: { $cond: [{ $eq: ['$completionStatus', 'missed'] }, 1, 0] } },
    } },
    { $setWindowFields: {
        partitionBy: '$_id.dim', sortBy: { '_id.month': 1 },
        output: { prevCompleted: { $shift: { output: '$completed', by: -1, default: null } } },
    } },
    { $addFields: { momChangePct: { $cond: [{ $gt: ['$prevCompleted', 0] },
        { $multiply: [{ $divide: [{ $subtract: ['$completed', '$prevCompleted'] }, '$prevCompleted'] }, 100] }, null] } } },
  ];
}

function drivingTimeByTechDay(tenantId, dateKeys) {
  return [
    { $match: { tenantId, dateKey: { $in: dateKeys }, calculationStatus: 'ok' } },
    { $group: {
        _id: { tech: '$technicianId', day: '$dateKey' },
        legs: { $sum: 1 },
        drivingMinutes: { $sum: '$mapboxDurationMinutes' },
        drivingMiles: { $sum: '$mapboxDistanceMiles' },
        nonDrivingGapMinutes: { $sum: { $toDouble: '$nonDrivingGapMinutes' } },
        avgDriveBetweenStops: { $avg: '$mapboxDurationMinutes' },
    } },
  ];
}

module.exports = {
  stopsPerTechnician, dailyTechnicianForKey, revenueByCategory, revenueByRoute,
  revenueByCustomer, monthlyStopVolume, drivingTimeByTechDay,
};
