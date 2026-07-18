'use strict';
const { models } = require('../../models');
const { getLeg } = require('./mapboxService');
const { diffMinutes } = require('../../utils/util');
const { ServiceVisit, RouteLeg, CustomerLocation, BusinessRule, DataQualityIssue } = models;

async function recalcRouteLegsForKeys(tenant, keys, batch, now = new Date()) {
  const largeGap = await ruleNumber(tenant, 'largeGapThresholdMinutes', 180);
  for (const key of keys) {
    const [technicianId, dateKey] = key.split('|');
    await recalcOne(tenant, technicianId, dateKey, largeGap, batch, now);
  }
}

async function recalcOne(tenant, technicianId, dateKey, largeGap, batch, now) {
  const visits = await ServiceVisit.find({ tenantId: tenant._id, technicianId, dateKey })
    .sort({ arrivalAt: 1, _id: 1 }).lean();
  if (visits.length === 0) return;

  const legs = [];
  const dq = [];
  for (let i = 0; i < visits.length - 1; i++) {
    const cur = visits[i];
    const nxt = visits[i + 1];
    const leg = baseLeg(tenant, cur, nxt, now);

    if (String(cur.technicianId) !== String(nxt.technicianId)) { leg.calculationStatus = 'different_tech'; legs.push(leg); continue; }
    if (!cur.departureAt || !nxt.arrivalAt) {
      leg.calculationStatus = 'missing_times'; legs.push(leg);
      dq.push(dq1(tenant, batch, 'missing_times', 'warning', cur, `Leg ${cur.routeStarInvoiceNumber}→${nxt.routeStarInvoiceNumber} missing arrival/departure`, now));
      continue;
    }
    const [fromCoord, toCoord] = [coord(await loc(cur)), coord(await loc(nxt))];
    if (!fromCoord || !toCoord) {
      leg.calculationStatus = 'missing_coords'; legs.push(leg);
      dq.push(dq1(tenant, batch, 'missing_coordinates', 'warning', cur, `Leg missing coordinates (geocode needed)`, now));
      continue;
    }
    const observedGap = diffMinutes(nxt.arrivalAt, cur.departureAt);
    leg.observedGapMinutes = String(observedGap);
    leg.fromCoord = fromCoord; leg.toCoord = toCoord;

    if (observedGap < 0) {
      leg.calculationStatus = 'negative_gap'; legs.push(leg);
      dq.push(dq1(tenant, batch, 'next_arrival_before_prev_departure', 'warning', cur, `Next arrival before prev departure`, now));
      continue;
    }
    if (sameLocation(fromCoord, toCoord)) {
      leg.calculationStatus = 'same_location'; leg.mapboxDistanceMeters = 0; leg.mapboxDurationMinutes = 0;
      leg.nonDrivingGapMinutes = String(observedGap); legs.push(leg); continue;
    }

    try {
      const profile = 'driving-traffic';
      const m = await getLeg({ from: fromCoord, to: toCoord, profile, at: cur.departureAt, now });
      Object.assign(leg, {
        mapboxDistanceMeters: m.distanceMeters, mapboxDistanceMiles: round(m.distanceMiles, 2),
        mapboxDurationSeconds: m.durationSeconds, mapboxDurationMinutes: round(m.durationMinutes, 1),
        mapboxDurationTrafficSeconds: m.durationTrafficSeconds, profile: m.profile,
        geometry: m.geometry, mapboxRequestHash: m.requestHash, mapboxResponseAt: m.responseAt,
        nonDrivingGapMinutes: String(round(observedGap - m.durationMinutes, 1)),
      });
      if (m.durationMinutes > observedGap) {
        leg.calculationStatus = 'duration_gt_gap';
        dq.push(dq1(tenant, batch, 'mapbox_duration_gt_gap', 'warning', cur, `Drive ${round(m.durationMinutes,1)}m > gap ${round(observedGap,1)}m`, now));
      } else {
        leg.calculationStatus = 'ok';
      }
      if (observedGap > largeGap) {
        dq.push(dq1(tenant, batch, 'unusually_long_drive_gap', 'info', cur, `Observed gap ${round(observedGap,0)}m > ${largeGap}m`, now));
      }
    } catch (err) {
      leg.calculationStatus = 'mapbox_failed';
      leg.mapboxRequestHash = 'failed';
      dq.push(dq1(tenant, batch, 'mapbox_failed', 'warning', cur, `Mapbox failed: ${err.message}`, now));
    }
    legs.push(leg);
  }

  for (const leg of legs) {
    const res = await RouteLeg.findOneAndUpdate(
      { tenantId: tenant._id, fromVisitId: leg.fromVisitId, toVisitId: leg.toVisitId },
      { $set: leg, $setOnInsert: { calculatedAt: now } },
      { upsert: true, new: true }
    );
    await ServiceVisit.updateOne({ _id: leg.fromVisitId }, { $set: { outgoingRouteLegId: res._id } });
  }
  if (dq.length) await DataQualityIssue.insertMany(dq);
}

function baseLeg(tenant, cur, nxt, now) {
  return {
    tenantId: tenant._id, serviceDate: cur.serviceDate, dateKey: cur.dateKey,
    technicianId: cur.technicianId, routeId: cur.routeId,
    fromVisitId: cur._id, toVisitId: nxt._id, fromInvoiceId: cur.invoiceId, toInvoiceId: nxt.invoiceId,
    fromCustomerId: cur.customerId, toCustomerId: nxt.customerId,
    fromLocationId: cur.locationId, toLocationId: nxt.locationId,
    fromDepartureTime: cur.departureAt, toArrivalTime: nxt.arrivalAt,
    profile: 'driving', mapboxRequestHash: 'n/a', calculationStatus: 'ok', calculatedAt: now,
  };
}
const _locCache = new Map();
async function loc(visit) {
  if (!visit.locationId) return null;
  const k = String(visit.locationId);
  if (_locCache.has(k)) return _locCache.get(k);
  const l = await CustomerLocation.findById(visit.locationId, { location: 1, sourceLatitude: 1, sourceLongitude: 1 }).lean();
  _locCache.set(k, l); return l;
}
function coord(l) {
  if (!l) return null;
  if (l.location && Array.isArray(l.location.coordinates)) return l.location.coordinates;
  if (l.sourceLongitude != null && l.sourceLatitude != null) return [l.sourceLongitude, l.sourceLatitude];
  return null;
}
function sameLocation(a, b) { return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5; }
function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }
async function ruleNumber(tenant, key, fallback) {
  const r = await BusinessRule.findOne({ tenantId: tenant._id, key, $or: [{ effectiveEnd: null }, { effectiveEnd: { $gte: new Date() } }] }).sort({ effectiveStart: -1 });
  return r ? Number(r.value) : fallback;
}
function dq1(tenant, batch, issueType, severity, visit, description, now) {
  return { tenantId: tenant._id, issueType, severity, collectionName: 'routeLegs', recordId: visit._id, sourceRecordId: visit.routeStarInvoiceNumber, sourceSystem: 'mapbox', description, detectedAt: now, detectedByBatchId: batch && batch._id, resolutionStatus: 'open' };
}

module.exports = { recalcRouteLegsForKeys };
