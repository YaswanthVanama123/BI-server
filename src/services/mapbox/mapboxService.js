'use strict';
const { models } = require('../../models');
const { coordHash } = require('../../utils/util');
const env = require('../../config/env');

const { MapboxRouteCache } = models;

const METERS_PER_MILE = 1609.344;
const TRAFFIC_TTL_MS = 30 * 24 * 3600 * 1000;
const GEOCODING_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

function timeBucket(dateUtc, profile) {
  if (profile !== 'driving-traffic' || !dateUtc) return 'any';
  const day = dateUtc.getUTCDay();
  if (day === 0 || day === 6) return 'weekend';
  const h = dateUtc.getUTCHours();
  if (h < 11) return 'weekday-am';
  if (h < 15) return 'weekday-mid';
  return 'weekday-pm';
}

async function getLeg({ from, to, profile = 'driving', at, token = env.mapbox.token, now = new Date() }) {
  const oHash = coordHash(from[0], from[1]);
  const dHash = coordHash(to[0], to[1]);
  const bucket = timeBucket(at, profile);
  const key = { originHash: oHash, destinationHash: dHash, profile, timeBucket: bucket };

  const cached = await MapboxRouteCache.findOne(key);
  if (cached && (!cached.expiresAt || cached.expiresAt > now)) {
    await MapboxRouteCache.updateOne(key, { $inc: { hitCount: 1 } });
    return toLeg(cached, key, true);
  }

  const resp = await _fetchDirections(from, to, profile, token);
  const doc = {
    ...key, originCoord: from, destinationCoord: to,
    distanceMeters: resp.distance, durationSeconds: resp.duration,
    durationTrafficSeconds: profile === 'driving-traffic' ? resp.duration : undefined,
    geometry: resp.geometry, mapboxResponseAt: now, hitCount: 0,
    expiresAt: profile === 'driving-traffic' ? new Date(now.getTime() + TRAFFIC_TTL_MS) : undefined,
  };
  await MapboxRouteCache.updateOne(key, { $setOnInsert: doc }, { upsert: true });
  return toLeg(doc, key, false);
}

function toLeg(doc, key, fromCache) {
  return {
    distanceMeters: doc.distanceMeters,
    distanceMiles: doc.distanceMeters / METERS_PER_MILE,
    durationSeconds: doc.durationSeconds,
    durationMinutes: doc.durationSeconds / 60,
    durationTrafficSeconds: doc.durationTrafficSeconds,
    geometry: doc.geometry,
    profile: key.profile,
    requestHash: `${key.originHash}:${key.destinationHash}:${key.profile}:${key.timeBucket}`,
    responseAt: doc.mapboxResponseAt,
    fromCache,
  };
}

async function _fetchDirections(from, to, profile, token) {
  const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}`
    + `?overview=false&annotations=distance,duration&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox directions ${res.status}`);
  const json = await res.json();
  const r = (json.routes || [])[0];
  if (!r) throw new Error('Mapbox: no route');
  return { distance: r.distance, duration: r.duration, geometry: r.geometry };
}

async function _fetchMatrix(coordsList, profile, token) {
  const coords = coordsList.map((c) => `${c[0]},${c[1]}`).join(';');
  const url = `https://api.mapbox.com/directions-matrix/v1/mapbox/${profile}/${coords}`
    + `?annotations=distance,duration&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox matrix ${res.status}`);
  return res.json();
}

async function geocode(address, token = env.mapbox.token) {
  const q = String(address || '').trim();
  if (!q || !token) return null;
  const url = `${GEOCODING_URL}/${encodeURIComponent(q)}.json?limit=1&country=us&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const f = (json.features || [])[0];
  return f && Array.isArray(f.center) ? [f.center[0], f.center[1]] : null;
}

module.exports = { getLeg, geocode, timeBucket, _fetchDirections, _fetchMatrix, METERS_PER_MILE };
