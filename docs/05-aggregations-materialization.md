# 10–11. Aggregation Pipelines & Materialization Strategy

All pipelines are tenant-scoped and date-bounded. They read source-of-truth + `routeLegs`, and either
answer live (drill-down) or feed a materialized summary. Runnable copies live in
[`../src/services/analytics/aggregationPipelines.js`](../src/services/analytics/aggregationPipelines.js).

Shared idea for **route attribution** (used everywhere revenue/stops roll to a route):

```
routeId chosen by hierarchy, recorded with method+confidence on the serviceVisit at ETL time:
  1. visit.routeId              (method 'visit',            confidence high)
  2. invoice.routeId            (method 'invoice',          confidence medium)
  3. tech effective assignment  (method 'tech_assignment',  confidence medium)  // routeAssignmentHistory as-of serviceDate
  4. customer.defaultRouteId    (method 'customer_default', confidence low)
  5. else UNASSIGNED sentinel   (method 'unassigned',       confidence low)
```

Because attribution is resolved and stored on `serviceVisits` (and denormalized to
`invoiceLineItems.routeId`) during ETL, BI pipelines just group by `routeId` — auditable via
`routeAttributionMethod`/`routeAttributionConfidence`.

**Revenue-allocation rule** (documented, not arbitrary): an invoice line is attributed to a stop by:
1. direct `invoiceLineItems.serviceVisitId` when known;
2. else split across the invoice's linked visits **proportionally by line amount** within matching
   `serviceDate`/category (`businessRules.revenueAllocationMethod='proportional_by_line'`);
3. recurring/multi-period invoices with N linked visits split equally by visit when line-level dates
   are absent;
4. credits/adjustments/trip charges follow `businessRules.excludeStatusesFromRevenue` and are tagged
   so they can be included/excluded per report.

---

## 10.1 Technician utilization

Utilization is **derived** from payroll availability (denominator) and stop-time (numerator); a cached
copy lives in `dailyTechnicianMetrics`. Live pipeline over a period:

```js
// availableHours from employeeAvailability (payroll periods intersecting range),
// loggedServiceHours from serviceVisits.serviceDurationMinutes
db.serviceVisits.aggregate([
  { $match: { tenantId, serviceDate: { $gte: start, $lte: end }, completionStatus: 'completed' } },
  { $group: {
      _id: '$technicianId',
      loggedServiceMinutes: { $sum: { $toDouble: '$serviceDurationMinutes' } },
      completedStops: { $sum: 1 }
  }},
  { $lookup: {
      from: 'employeeAvailability',
      let: { tech: '$_id' },
      pipeline: [
        { $match: { $expr: { $and: [ { $eq: ['$tenantId', tenantId] }, { $eq: ['$employeeId', '$$tech'] } ] } } },
        // period intersection handled by matching payrollPeriodId set precomputed for the range
        { $group: { _id: null, availableHours: { $sum: { $toDouble: '$availableHours' } } } }
      ],
      as: 'avail'
  }},
  { $addFields: {
      loggedServiceHours: { $divide: ['$loggedServiceMinutes', 60] },
      availableHours: { $ifNull: [ { $arrayElemAt: ['$avail.availableHours', 0] }, 0 ] }
  }},
  { $addFields: {
      utilizationPercentage: {
        $cond: [ { $gt: ['$availableHours', 0] },
                 { $multiply: [ { $divide: ['$loggedServiceHours', '$availableHours'] }, 100 ] },
                 null ]  // null, not 0, when denominator missing (surfaced as DQ)
  }}},
  { $lookup: { from: 'employees', localField: '_id', foreignField: '_id', as: 'emp' } },
  { $project: { technicianId: '$_id', _id: 0, employee: { $arrayElemAt: ['$emp.fullName', 0] },
      completedStops: 1, loggedServiceHours: 1, availableHours: 1, utilizationPercentage: 1 } }
])
```

## 10.2 Stops per technician (day / week / month, avg, benchmark)

```js
db.serviceVisits.aggregate([
  { $match: { tenantId, serviceDate: { $gte: start, $lte: end } } },
  { $group: {
      _id: { tech: '$technicianId', day: '$dateKey', week: '$isoWeek', month: '$monthKey' },
      stops: { $sum: { $cond: [ { $eq: ['$completionStatus','completed'] }, 1, 0 ] } },
      serviceMinutes: { $sum: { $toDouble: '$serviceDurationMinutes' } }
  }},
  // roll day → tech/period with averages over working days
  { $group: {
      _id: { tech: '$_id.tech', month: '$_id.month' },
      totalStops: { $sum: '$stops' },
      workingDays: { $sum: { $cond: [ { $gt: ['$stops', 0] }, 1, 0 ] } },
      totalServiceMinutes: { $sum: '$serviceMinutes' }
  }},
  { $addFields: {
      avgStopsPerWorkingDay: { $cond: [ { $gt: ['$workingDays',0] },
        { $divide: ['$totalStops','$workingDays'] }, 0 ] }
  }},
  // benchmark from businessRules (stopsPerDayBenchmark=10) is joined/injected by the API layer
  { $addFields: { stopsVsBenchmark: { $subtract: ['$avgStopsPerWorkingDay', benchmark] } } }
])
```

Also join `dailyTechnicianMetrics.totalDrivingMinutes` for the "total service minutes / total driving
minutes / utilization" trio in one row.

## 10.3 Driving time between consecutive stops (from `routeLegs`)

Route legs are precomputed (§9). Aggregate for reporting:

```js
db.routeLegs.aggregate([
  { $match: { tenantId, serviceDate: { $gte: start, $lte: end }, calculationStatus: 'ok' } },
  { $group: {
      _id: { tech: '$technicianId', day: '$dateKey' },
      legs: { $sum: 1 },
      drivingMinutes: { $sum: '$mapboxDurationMinutes' },
      drivingMiles:   { $sum: '$mapboxDistanceMiles' },
      nonDrivingGapMinutes: { $sum: { $toDouble: '$nonDrivingGapMinutes' } },
      avgDriveBetweenStops: { $avg: '$mapboxDurationMinutes' }
  }}
])
```
Anomalies (`duration_gt_gap`, `large_gap`, `mapbox_failed`) are excluded from averages and surfaced in DQ.

## 10.4 Monthly stop volume (total, by route/tech/customer/category, by status, MoM)

```js
db.serviceVisits.aggregate([
  { $match: { tenantId, monthKey: { $in: monthsInRange } } },
  { $group: {
      _id: { month: '$monthKey', route: '$routeId' },
      total: { $sum: 1 },
      completed: { $sum: { $cond: [ { $eq: ['$completionStatus','completed'] }, 1, 0 ] } },
      cancelled: { $sum: { $cond: [ { $eq: ['$completionStatus','cancelled'] }, 1, 0 ] } },
      suspended: { $sum: { $cond: [ { $eq: ['$completionStatus','suspended'] }, 1, 0 ] } },
      missed:    { $sum: { $cond: [ { $eq: ['$completionStatus','missed'] }, 1, 0 ] } }
  }},
  { $setWindowFields: {
      partitionBy: '$_id.route',
      sortBy: { '_id.month': 1 },
      output: { prevMonthCompleted: { $shift: { output: '$completed', by: -1, default: null } } }
  }},
  { $addFields: { momChange: { $cond: [ { $gt: ['$prevMonthCompleted', 0] },
      { $multiply: [ { $divide: [ { $subtract: ['$completed','$prevMonthCompleted'] }, '$prevMonthCompleted' ] }, 100 ] },
      null ] } } }
])
```
Swap the `route` group key for `technicianId`, `customerId`, or a category unwind for the other cuts.
This feeds `monthlyRouteMetrics` / `monthlyCustomerMetrics` / `monthlyCategoryMetrics`.

## 10.5 Revenue by service category (from line items, not invoice totals)

```js
db.invoiceLineItems.aggregate([
  { $match: { tenantId, invoiceDate: { $gte: start, $lte: end }, isRevenueRecognized: true } },
  { $group: {
      _id: { month: '$monthKey', category: '$serviceCategoryId' },
      revenue:  { $sum: { $toDecimal: '$sourceAmount' } },
      quantity: { $sum: { $toDecimal: '$quantity' } },
      invoiceIds: { $addToSet: '$invoiceId' },
      visitIds:   { $addToSet: '$serviceVisitId' }
  }},
  { $addFields: { invoiceCount: { $size: '$invoiceIds' },
                  stopCount: { $size: { $setDifference: ['$visitIds', [null]] } } } },
  { $addFields: {
      avgRevenuePerInvoice: { $cond: [ { $gt: ['$invoiceCount',0] }, { $divide: ['$revenue','$invoiceCount'] }, null ] },
      avgRevenuePerStop:    { $cond: [ { $gt: ['$stopCount',0] },    { $divide: ['$revenue','$stopCount'] }, null ] }
  }},
  { $lookup: { from: 'serviceCategories', localField: '_id.category', foreignField: '_id', as: 'cat' } },
  // category revenue % computed in a $group-total + $addFields pass or in the API layer
])
```
Unmapped items carry `serviceCategoryId = UNMAPPED` and appear as their own row → also surfaced in DQ.

## 10.6 Revenue grouped by route

```js
db.invoiceLineItems.aggregate([
  { $match: { tenantId, invoiceDate: { $gte: start, $lte: end }, isRevenueRecognized: true } },
  { $group: {
      _id: { route: '$routeId', month: '$monthKey' },
      lineRevenue: { $sum: { $toDecimal: '$sourceAmount' } },
      categories: { $push: { c: '$serviceCategoryId', a: { $toDecimal: '$sourceAmount' } } },
      visitIds: { $addToSet: '$serviceVisitId' }
  }},
  { $lookup: { // stops + service/driving hours + labor cost from daily metrics
      from: 'dailyTechnicianMetrics', /* joined by route via routeIds array + month */ as: 'ops',
      let: { r: '$_id.route', m: '$_id.month' },
      pipeline: [ { $match: { $expr: { $and: [ {$eq:['$tenantId',tenantId]}, {$eq:['$monthKey','$$m']},
                    { $in: ['$$r', '$routeIds'] } ] } } },
        { $group: { _id: null, stops: {$sum:'$completedStops'},
            serviceHours: {$sum: {$divide:[{$toDouble:'$totalServiceMinutes'},60]}},
            drivingHours: {$sum: {$divide:[{$toDouble:'$totalDrivingMinutes'},60]}},
            laborCost: {$sum: {$toDouble:'$laborCost'}} } } ]
  }},
  { $addFields: {
      stops: { $ifNull: [ { $arrayElemAt: ['$ops.stops',0] }, 0 ] },
      revenuePerStop: { $cond: [ { $gt: [{ $arrayElemAt:['$ops.stops',0]},0] },
          { $divide: ['$lineRevenue', { $arrayElemAt:['$ops.stops',0] } ] }, null ] },
      estContributionMargin: { $subtract: ['$lineRevenue', { $ifNull:[{$arrayElemAt:['$ops.laborCost',0]},0] }] }
  }}
])
```
Produces per route: total & line-item revenue, revenue by category, revenue per stop, revenue per tech,
total stops, service hours, driving hours, avg drive between stops (from `routeLegs`), labor cost, and
estimated contribution margin. Feeds `monthlyRouteMetrics`.

## 10.7 Revenue per stop & client-level analytics

```js
// revenue allocated to stops (direct link preferred; else proportional split handled at ETL,
// so invoiceLineItems.serviceVisitId is populated wherever resolvable)
db.invoiceLineItems.aggregate([
  { $match: { tenantId, invoiceDate: { $gte:start, $lte:end }, isRevenueRecognized: true } },
  { $group: {
      _id: '$customerId',
      totalRevenue:     { $sum: { $toDecimal: '$sourceAmount' } },
      recurringRevenue: { $sum: { $cond: [ { $eq: ['$invoiceType','recurring'] }, { $toDecimal:'$sourceAmount' }, 0 ] } },
      oneTimeRevenue:   { $sum: { $cond: [ { $eq: ['$invoiceType','one_time'] }, { $toDecimal:'$sourceAmount' }, 0 ] } },
      byCategory: { $push: { c: '$serviceCategoryId', a: { $toDecimal:'$sourceAmount' } } },
      visitIds: { $addToSet: '$serviceVisitId' }
  }},
  { $addFields: { stopCount: { $size: { $setDifference: ['$visitIds', [null]] } } } },
  { $addFields: { revenuePerStop: { $cond: [ { $gt:['$stopCount',0] }, { $divide:['$totalRevenue','$stopCount'] }, null ] } } }
])
```
Client-level analytics also joins `customerServiceSchedules` (frequency, active/suspended route status),
`dailyTechnicianMetrics`/`routeLegs` (service hours, driving time), and cost pipelines (labor/supply) →
customer profitability. Feeds `monthlyCustomerMetrics`.

## 10.8 Cost & contribution per stop

```
laborCostPerStop      = allocatedLaborCost / completedStops
supplyCostPerStop     = allocatedSupplyCost / completedStops      // from supplyCosts + costAllocationRules
vehicleCostPerStop    = allocatedVehicleCost / completedStops     // vehicleCosts (BASIS TBD — businessRule)
contributionPerStop   = revenuePerStop - laborCostPerStop - supplyCostPerStop - vehicleCostPerStop - otherPerStop
```
- **Labor:** hourly → `Σ(payrollEntries.appliedRate × workedHours)` burdened by `laborCostRates.burdenMultiplier`;
  salaried → `laborCostRates.burdenedHourly × loggedServiceHours` where the salaried hourly is
  `salary / businessRules.salariedDefaultAvailableHours`. Allocated to stops per `costAllocationRules`
  (default `per_hour` of service time, fallback `per_stop`).
- **Supply/vehicle:** allocated by `costAllocationRules.basis`. Vehicle basis is **business-confirmable**
  (per_tech | per_route | fixed_pool) and lives in `vehicleCosts`+`costAllocationRules`, never hard-coded.

---

## 11. Materialized-view / summary-collection strategy

### 11.1 When to materialize vs. compute live

- **Materialize** (stored, refreshed by ETL) the four monthly summaries + `dailyTechnicianMetrics`
  because they back dashboards (many concurrent reads, stable grain, expensive multi-collection joins).
- **Compute live** narrow drill-downs (single customer/route/tech over a custom range) — cheap with the
  compound indexes; they read source-of-truth so they're always current.
- **Never store** a number that exists nowhere else: every summary is reproducible by re-running §10.

### 11.2 Refresh mechanics (incremental, not full rebuild)

- ETL step 10 collects the **impacted keys** touched by a batch: `{technicianId,dateKey}`,
  `{routeId,monthKey}`, `{customerId,monthKey}`, `{categoryId,monthKey}`.
- For each impacted key, run the matching §10 pipeline **scoped to that key** with a terminal
  `$merge` into the summary collection (upsert on the grain's unique index):

```js
{ $merge: { into: 'monthlyRouteMetrics',
            on: ['tenantId','routeId','monthKey'],
            whenMatched: 'replace', whenNotMatched: 'insert' } }
```
- `computedAt` + `sourceBatchIds` stamped so staleness is visible; a nightly full recompute of the
  trailing N months (`$merge` over the whole range) self-heals any drift from partial refreshes.
- **Trigger options:** (a) inline at end of each import batch (default, daily); (b) scheduled cron
  (`../src/services/analytics/*`); (c) later, change-stream-driven for near-real-time — the `$merge` targets and
  grain keys are identical, so moving to streaming needs no schema change.

### 11.3 `stopsPerTechnicianDaily`

Not a new source collection (source data already exists). Implement as either an on-demand read of
`dailyTechnicianMetrics` or a materialized `$merge` — both derive from `serviceVisits`. Documented as
derived so it's never treated as authoritative.

Next: [`06-data-quality.md`](06-data-quality.md).
