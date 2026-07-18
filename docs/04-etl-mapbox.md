# 8–9. ETL / Synchronization Workflow & Mapbox Integration

## 8. ETL and synchronization workflow

### 8.1 Sources & acquisition modes

| Source | Preferred mode | Fallback |
|---|---|---|
| RouteStar closed invoices, invoice detail, customers, pricing, customer routes | CSV export (daily) | RouteStar API when available → controlled browser extraction only if neither exists |
| ADP / payroll | CSV export per pay period | API if available |
| FastCash weekly | CSV export | — (recon only) |
| EnviroMaster Store (supply) | CSV / inventory export | — |
| Mapbox | Directions / Matrix / Geocoding API | cache only when rate-limited |

**Controlled extraction** (browser automation) is a last resort, sandboxed, rate-limited, and it lands
into the same `raw_*` layer with `source.sourceUrl` set — downstream stages are identical.

### 8.2 Canonical import pipeline (per source file / API pull)

Implemented in [`../src/etl/importBatchRunner.js`](../src/etl/importBatchRunner.js) + per-source importers.

```
 1. openBatch(tenant, sourceSystem, sourceEntity, fileMeta)
      → importBatches doc {status:'running', watermarkBefore}
 2. land raw
      → for each row: normalize whitespace, compute recordHash = sha256(canonical(row))
      → upsert raw_* by (tenant, system, entity, sourceRecordId, recordHash)
      → if hash unchanged and row already present → mark 'unchanged', skip curated work
 3. validate structure
      → assert required headers/fields present; reject file on header drift (DQ 'schema_drift')
 4. standardize
      → dates→UTC (+ retain wall clock + tz); money→Decimal128; route codes→uppercased/trimmed;
        employee & customer ids→trimmed; frequency text→normalized via frequencyDefinitions
 5. resolve mappings
      → customer: routeStarCustomerId → customers._id  (create shell customer if new)
      → employee: (adpId | routeStarTechId | normalized name) → employees._id via employeeSourceMappings
      → item: sourceItemCode/description → serviceItems + serviceCategories via itemCategoryMappings
      → route: attribution hierarchy (see §route below)
      → UNRESOLVED → still upsert, flag DQ ('missing_customer_ref'|'missing_employee_mapping'|…)
 6. upsert source-of-truth (idempotent)
      → bulkWrite updateOne({filter:naturalKey}, {$set,$setOnInsert}, {upsert:true})
      → history collections: if a tracked field changed vs. current row, close prior
        (set effectiveEnd) and insert new effective-dated row; else no-op
 7. classify each record: inserted | updated | unchanged | rejected (from bulkWrite result + hash)
 8. generate data-quality issues (§12) for this batch's touched records
 9. recalculate affected route legs
      → collect distinct (tenant, technicianId, serviceDate) touched by changed visits
      → enqueue routeLeg recompute for only those keys
10. refresh only impacted analytics summaries
      → collect distinct (technicianId,dateKey), (routeId,monthKey), (customerId,monthKey),
        (categoryId,monthKey) touched → re-run the matching aggregation for just those keys
11. reconciliation
      → compare source row count & control totals (Σ amount) vs. loaded; write to batch.reconciliation;
        compare vs. FastCash weekly where applicable → DQ on mismatch
12. closeBatch → status 'completed' | 'partial' | 'failed'; advance sourceSyncStates.watermark
```

### 8.3 Idempotency & change detection

- **Natural keys** (never ObjectId) drive upserts: invoice #, `(customerId,payrollPeriodId)`,
  `(fromVisitId,toVisitId)`, `(sourceSystem,sourceRecordId)`.
- **recordHash**: sha256 over the canonicalized source payload (sorted keys, trimmed, normalized nulls).
  Unchanged hash ⇒ skip curated recompute (`syncStatus:'unchanged'`). Cheap, and it is the primary
  change signal when a source lacks a trustworthy "last modified".
- **Upsert shape:** `$setOnInsert` for immutable/creation fields (`_id` semantics, `source.importedAt`),
  `$set` for mutable fields, always bumping `source.lastSyncedAt`, `source.recordHash`, `source.syncStatus`.

### 8.4 Incremental synchronization strategy

Priority of the incremental signal:
1. **Source modified timestamp** (`Last modified` on invoices) when trustworthy → pull rows where
   `sourceModifiedAt > sourceSyncStates.lastWatermark`.
2. **recordHash diff** when modified timestamps are missing/untrustworthy (pricing, routes) → full
   snapshot compare, only changed hashes flow to curated.
3. **Unique source identifiers** for dedupe within a batch.
4. **Last successful sync watermark** per (tenant, source, entity) in `sourceSyncStates`.
5. **Retry handling:** transient failures retried with backoff; batch marked `partial`; failed rows go
   to a dead-letter (`raw_*.parseStatus='parse_error'` + `dataQualityIssues` 'rejected_record').
6. **Watermark safety:** advance watermark only after a `completed` batch; use a small look-back overlap
   (e.g. `watermark − 2 days`) to catch late-edited source rows, relying on idempotency to dedupe.

Daily cadence now (already daily per business input). The same runner supports near-real-time later by
shrinking the schedule to minutes and switching acquisition to API/CDC — no schema change required.

### 8.5 Deletes & voids

Sources rarely hard-delete. Handle disappearance/void by: (a) status transition (`invoices.status=void`,
`isRevenueRecognized=false`), (b) `source.syncStatus='superseded'` when a snapshot no longer contains a
previously-seen key beyond the look-back window (flag DQ, never physically delete history).

---

## 9. Mapbox integration design

Goal: driving distance/time between consecutive stops, geocoding of missing/invalid coordinates, and
radius/density inputs — using **coordinate pairs, never customer names**, with aggressive caching to
control cost. Implemented in [`../src/services/mapbox/mapboxService.js`](../src/services/mapbox/mapboxService.js) and
[`../src/services/mapbox/routeLegCalculator.js`](../src/services/mapbox/routeLegCalculator.js).

### 9.1 APIs used

- **Directions API** (`/directions/v5/{profile}`) — per-leg distance/duration + optional geometry;
  `profile = driving-traffic` for traffic-aware duration where supported, else `driving`.
- **Matrix API** (`/directions-matrix/v1`) — batch many-to-many when computing a whole day's legs; cheaper
  per pair. Used to fetch the "chain" of a technician's ordered stops in one call (up to 25 coords).
- **Geocoding API** (`/geocoding/v5/mapbox.places`) — fill missing coords / validate source coords.
  Result stored on `customerLocations.location` (normalized) — **source coords never overwritten**.

### 9.2 Route-leg build algorithm (per tenant × technician × serviceDate)

```
legs = []
visits = serviceVisits where tenant, technicianId, serviceDate
visits.sort(by arrivalAt asc, tie-break stopNumber)
for i in 0..visits.length-2:
    cur = visits[i]; nxt = visits[i+1]
    leg = newLeg(cur, nxt)
    # ---- guard conditions set calculationStatus and skip Mapbox ----
    if cur.technicianId != nxt.technicianId      -> 'different_tech'   (skip)
    elif !cur.departureAt || !nxt.arrivalAt      -> 'missing_times'    (skip mapbox, keep leg)
    elif !coords(cur) || !coords(nxt)            -> 'missing_coords'   (enqueue geocode; skip)
    elif sameLocation(cur, nxt)                  -> 'same_location'    (distance≈0; skip mapbox)
    elif nxt.arrivalAt < cur.departureAt         -> 'overlap'|'negative_gap' (flag DQ; skip)
    elif crossesMidnight(cur, nxt)               -> 'crosses_midnight' (flag DQ; still compute)
    else:
        observedGapMinutes = (nxt.arrivalAt - cur.departureAt)/60000
        (dist, dur, durTraffic, geom) = mapbox(cur.coord, nxt.coord, profile, timeBucket(cur.departureAt))
        leg.mapbox* = ...
        leg.nonDrivingGapMinutes = observedGapMinutes - dur/60
        if dur/60 > observedGapMinutes -> status 'duration_gt_gap' (DQ: mapbox>gap)
        if observedGapMinutes > businessRules.largeGapThresholdMinutes -> DQ 'large_gap'
        status = 'ok'
    legs.push(leg)
# first & last stop of day flagged for reporting (no inbound/outbound leg)
markFirst(visits[0]); markLast(visits[last])
upsert legs by (tenant, fromVisitId, toVisitId)  # idempotent
set serviceVisits.outgoingRouteLegId
```

### 9.3 Caching (cost control)

- Cache key: `(originHash, destinationHash, profile, timeBucket)` where `*Hash` = sha256 of coords rounded
  to ~5 decimals (≈1 m), and `timeBucket ∈ {weekday-am, weekday-pm, weekday-mid, weekend, any}`.
  Non-traffic `driving` uses `timeBucket='any'` (time-independent) → maximal reuse.
- `mapboxRouteCache.hitCount` incremented on reuse; traffic-aware entries carry `expiresAt` (TTL, e.g. 30d)
  so stale traffic estimates refresh; plain `driving` entries are effectively permanent.
- `routeLegs.mapboxRequestHash` records which cache entry served the leg (auditability + reprocessing).
- **Order matters:** legs are directional; do not canonicalize origin/destination order (A→B ≠ B→A for
  traffic and one-way networks).

### 9.4 Failure & edge handling (maps to required conditions)

| Condition | Handling |
|---|---|
| overlapping stops | `overlap`; negative observed gap → also DQ `next_arrival_before_prev_departure` |
| missing arrival/departure | `missing_times`; leg kept, Mapbox skipped, DQ raised |
| missing coordinates | `missing_coords`; enqueue geocode; retry leg after geocode |
| same-location stops | `same_location`; distance≈0, duration≈0, no API call |
| different technicians | `different_tech`; no leg computed (not a real drive) |
| crossing midnight | `crosses_midnight`; still compute using full UTC timestamps; flag for review |
| negative gap | `negative_gap`; DQ, Mapbox skipped |
| Mapbox API failure | `mapbox_failed`; ret/backoff; leg persisted without mapbox fields; recompute later |
| unusually large gap | compute normally + DQ `large_gap` (> businessRules threshold) |
| first/last stop of day | flagged; no inbound/outbound leg — excluded from drive-time averages |
| duration > observed gap | `duration_gt_gap`; DQ `mapbox_duration_gt_gap` (data or traffic anomaly) |

### 9.5 Geocoding rules

- Only geocode when source coords are missing or fail a sanity check (`|lat|>90`, `|lng|>180`, `(0,0)`,
  or coords outside the tenant's expected bounding box → DQ `invalid_coordinates`).
- Store `coordinateSource`, `geocodeAccuracy`, `mapboxPlaceId`, `geocodedAt`. `location` (GeoJSON) is the
  normalized coordinate used for all compute; `sourceLatitude/Longitude` are preserved untouched.
- Re-geocode only when `addressHash` changes (address edited at source), never on every import.

Next: [`05-aggregations-materialization.md`](05-aggregations-materialization.md).
