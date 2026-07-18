# 14–16. Example Records (Raw → Curated → Analytics)

Values are illustrative but use realistic RouteStar shapes (route `NRV02`, categories, `ZZZ` churn
convention, ~10 stops/day benchmark). Money shown as Decimal128 strings.

## 14. Example raw records

### `raw_routestar_invoices` (verbatim closed-invoice row)
```json
{
  "_id": "6699aa...01",
  "tenantId": "6690f0...aa",
  "sourceSystem": "routestar",
  "sourceEntity": "closed_invoice",
  "importBatchId": "6699a0...b1",
  "sourceRecordId": "INV-100482",
  "recordHash": "9f2c1e8b7a...",
  "rowNumber": 143,
  "rawHeaders": ["Invoice #","Invoice Date","Entered By","Assigned To","Customer","Invoice Type",
    "Service Notes","Subtotal","Total","Date Completed","Last Modified","Arrival Time",
    "Departure Time","Elapsed Time","Customer Grouping","Route","Account #","Customer ID"],
  "rawPayload": {
    "Invoice #": "100482", "Invoice Date": "07/14/2026", "Entered By": "jdoe",
    "Assigned To": "Miguel Santos", "Customer": "Riverside Diner (Main St)",
    "Invoice Type": "Recurring", "Service Notes": "Restroom + drain, back unit locked",
    "Subtotal": "185.00", "Total": "196.16", "Date Completed": "07/14/2026",
    "Last Modified": "07/14/2026 15:42", "Arrival Time": "09:12 AM",
    "Departure Time": "09:58 AM", "Elapsed Time": "0:52", "Customer Grouping": "Food Service",
    "Route": "NRV02", "Account #": "RS-4471", "Customer ID": "CUST-8890"
  },
  "importedAt": "2026-07-15T06:03:11Z", "lastSeenAt": "2026-07-15T06:03:11Z",
  "parseStatus": "parsed"
}
```
> Note the source `Elapsed Time` "0:52" (52 min) — kept but **not trusted**; curated recomputes from times.

### `raw_adp_payroll`
```json
{
  "sourceSystem": "adp", "sourceEntity": "payroll_entry", "sourceRecordId": "ADP-2026W28-E1187",
  "recordHash": "aa71...", "rawPayload": {
    "Employee Name": "Santos, Miguel", "Employee ID": "1187", "Department": "Field-NRV",
    "Applied Rate": "24.50", "Regular Hours": "38.5", "Overtime Hours": "1.5",
    "Vacation Hours": "0", "Sick Hours": "0", "Salary Amount": "", "Bonus Amount": "50.00",
    "Commission Amount": "", "Misc Reimbursement": "22.40",
    "Period Start": "07/06/2026", "Period End": "07/12/2026", "Check Date": "07/17/2026"
  }
}
```

## 15. Example curated records

### `customers`
```json
{ "_id":"c_8890", "tenantId":"t_1", "routeStarCustomerId":"CUST-8890",
  "routeStarAccountNumber":"RS-4471", "quickBooksCustomerId":"QB-2210",
  "customerName":"Riverside Diner (Main St)", "companyName":"Riverside Hospitality LLC",
  "customerStatus":"active", "sourceStatusText":"Active", "customerStatusEffectiveAt":"2023-02-01T00:00:00Z",
  "customerGrouping":"Food Service", "customerCategory":"Restaurant", "defaultRouteId":"r_nrv02",
  "primaryLocationId":"loc_8890a",
  "source":{"sourceSystem":"routestar","sourceRecordId":"CUST-8890","sourceEntity":"customer",
    "importedAt":"2024-01-10T06:00:00Z","lastSyncedAt":"2026-07-15T06:03:11Z",
    "importBatchId":"b_991","recordHash":"7c1d...","syncStatus":"unchanged","dataQualityStatus":"clean"} }
```

### `customerLocations` (source coords preserved + normalized GeoJSON)
```json
{ "_id":"loc_8890a", "tenantId":"t_1", "customerId":"c_8890", "locationType":"service",
  "addressLines":["412 Main St"], "city":"Christiansburg", "state":"VA", "postalCode":"24073", "country":"US",
  "sourceLatitude":37.1299, "sourceLongitude":-80.4089,
  "location":{"type":"Point","coordinates":[-80.40887,37.12994]},
  "coordinateSource":"mapbox_geocode","geocodeAccuracy":"rooftop","mapboxPlaceId":"address.123",
  "zone":"NRV-central","addressHash":"a91f...","isActive":true,"effectiveStart":"2024-01-10T00:00:00Z",
  "source":{ "...": "..." } }
```

### `serviceVisits` (elapsed validated, route attributed)
```json
{ "_id":"v_100482", "tenantId":"t_1", "routeStarInvoiceNumber":"100482", "invoiceId":"i_100482",
  "customerId":"c_8890", "locationId":"loc_8890a", "routeId":"r_nrv02",
  "routeAttributionMethod":"visit", "routeAttributionConfidence":"high", "technicianId":"e_1187",
  "serviceDate":"2026-07-14T00:00:00Z", "dateKey":"2026-07-14", "isoWeek":"2026-W29", "monthKey":"2026-07",
  "arrivalAt":"2026-07-14T13:12:00Z", "arrivalLocal":"2026-07-14T09:12:00", "timezone":"America/New_York",
  "departureAt":"2026-07-14T13:58:00Z", "departureLocal":"2026-07-14T09:58:00",
  "sourceElapsedTimeMinutes":"52", "calculatedElapsedTimeMinutes":"46",
  "elapsedTimeVarianceMinutes":"6", "elapsedTimeValidationStatus":"variance",
  "serviceDurationMinutes":"46", "completionStatus":"completed",
  "serviceNotes":"Restroom + drain, back unit locked", "enteredBy":"jdoe",
  "outgoingRouteLegId":"leg_100482_100485", "source":{ "...":"..." } }
```

### `invoices` + `invoiceLineItems`
```json
{ "_id":"i_100482", "tenantId":"t_1", "invoiceNumber":"100482", "customerId":"c_8890",
  "routeStarAccountNumber":"RS-4471", "invoiceType":"recurring", "status":"closed",
  "invoiceDate":"2026-07-14T00:00:00Z", "dateCompleted":"2026-07-14T00:00:00Z",
  "assignedToEmployeeId":"e_1187", "routeId":"r_nrv02", "customerGrouping":"Food Service",
  "subtotal":"185.00","taxTotal":"11.16","total":"196.16",
  "lineItemsTotal":"185.00","totalVariance":"0.00","reconciliationStatus":"ok",
  "isRevenueRecognized":true, "monthKey":"2026-07", "source":{ "...":"..." } }
```
```json
[
 { "_id":"il_1","tenantId":"t_1","invoiceId":"i_100482","customerId":"c_8890","lineNumber":1,
   "serviceItemId":"si_restroom","serviceCategoryId":"cat_restroom","serviceVisitId":"v_100482",
   "routeId":"r_nrv02","technicianId":"e_1187","sourceItemCode":"RH-STD",
   "sourceDescription":"Restroom & Hygiene Service - Standard","quantity":"1","rate":"120.00",
   "sourceAmount":"120.00","calculatedAmount":"120.00","amountVariance":"0.00","validationStatus":"ok",
   "invoiceDate":"2026-07-14T00:00:00Z","serviceDate":"2026-07-14T00:00:00Z","invoiceStatus":"closed",
   "isRevenueRecognized":true,"monthKey":"2026-07","source":{"...":"..."} },
 { "_id":"il_2","tenantId":"t_1","invoiceId":"i_100482","customerId":"c_8890","lineNumber":2,
   "serviceItemId":"si_drain","serviceCategoryId":"cat_drain","serviceVisitId":"v_100482",
   "routeId":"r_nrv02","technicianId":"e_1187","sourceItemCode":"DR-CLR",
   "sourceDescription":"Drain Line Treatment","quantity":"1","rate":"65.00",
   "sourceAmount":"65.00","calculatedAmount":"65.00","amountVariance":"0.00","validationStatus":"ok",
   "invoiceDate":"2026-07-14T00:00:00Z","invoiceStatus":"closed","isRevenueRecognized":true,
   "monthKey":"2026-07","source":{"...":"..."} }
]
```

### `routeLegs` (Mapbox, next stop 100485)
```json
{ "_id":"leg_100482_100485","tenantId":"t_1","serviceDate":"2026-07-14T00:00:00Z","dateKey":"2026-07-14",
  "technicianId":"e_1187","routeId":"r_nrv02","fromVisitId":"v_100482","toVisitId":"v_100485",
  "fromInvoiceId":"i_100482","toInvoiceId":"i_100485","fromCustomerId":"c_8890","toCustomerId":"c_9021",
  "fromDepartureTime":"2026-07-14T13:58:00Z","toArrivalTime":"2026-07-14T14:31:00Z",
  "observedGapMinutes":"33","fromCoord":[-80.40887,37.12994],"toCoord":[-80.38251,37.15102],
  "mapboxDistanceMeters":6820,"mapboxDistanceMiles":4.24,"mapboxDurationSeconds":900,
  "mapboxDurationMinutes":15.0,"mapboxDurationTrafficSeconds":1020,"profile":"driving-traffic",
  "nonDrivingGapMinutes":"18.0","mapboxRequestHash":"5b2f...","mapboxResponseAt":"2026-07-15T06:05:00Z",
  "calculationStatus":"ok","calculatedAt":"2026-07-15T06:05:00Z" }
```
> `observedGap 33m − drive 15m = 18m non-driving` (paperwork/break/idle) — the key capacity insight.

### `payrollEntries` + `employeeAvailability`
```json
{ "_id":"pe_1","tenantId":"t_1","payrollPeriodId":"pp_2026w28","employeeId":"e_1187","department":"Field-NRV",
  "appliedRate":"24.50","regularHours":"38.5","overtimeHours":"1.5","vacationHours":"0","sickHours":"0",
  "otherUnavailableHours":"0","bonusAmount":"50.00","miscReimbursement":"22.40","checkDate":"2026-07-17T00:00:00Z",
  "computedLaborCost":"1041.13","source":{"...":"..."} }
```
```json
{ "_id":"ea_1","tenantId":"t_1","employeeId":"e_1187","payrollPeriodId":"pp_2026w28",
  "scheduledHours":"40","vacationHours":"0","sickHours":"0","otherUnavailableHours":"0",
  "availableHours":"40","computationNote":"hourly; scheduled from businessRules default 40/wk" }
```

## 16. Example analytics results

### `dailyTechnicianMetrics` (Miguel, 2026-07-14)
```json
{ "_id":"dtm_e1187_20260714","tenantId":"t_1","technicianId":"e_1187","serviceDate":"2026-07-14T00:00:00Z",
  "dateKey":"2026-07-14","isoWeek":"2026-W29","monthKey":"2026-07","department":"Field-NRV",
  "routeIds":["r_nrv02"],"stopCount":9,"completedStops":9,"cancelledStops":0,"suspendedStops":0,"missedStops":0,
  "totalServiceMinutes":"402","totalDrivingMinutes":"128","totalNonDrivingGapMinutes":"96",
  "availableHours":"8.0","loggedServiceHours":"6.70","utilizationPercentage":"83.75",
  "benchmarkStopsPerDay":10,"stopsVsBenchmark":-1,"revenue":"1685.00","laborCost":"196.00",
  "computedAt":"2026-07-15T06:10:00Z","sourceBatchIds":["b_991"] }
```

### `GET /revenue/by-category?startDate=2026-07-01&endDate=2026-07-31` (envelope `data`)
```json
[
 {"serviceCategoryId":"cat_restroom","categoryCode":"RESTROOM_HYGIENE","revenue":"48250.00",
  "quantity":"402","invoiceCount":388,"stopCount":402,"avgRevenuePerStop":"120.02","categoryRevenuePct":52.1,
  "momChangePct":3.4},
 {"serviceCategoryId":"cat_drain","categoryCode":"DRAIN","revenue":"18120.00","stopCount":279,
  "avgRevenuePerStop":"64.95","categoryRevenuePct":19.6,"momChangePct":-1.2},
 {"serviceCategoryId":"cat_trip","categoryCode":"TRIP_CHARGE","revenue":"3100.00","categoryRevenuePct":3.3},
 {"serviceCategoryId":"cat_unmapped","categoryCode":"UNMAPPED","revenue":"640.00","categoryRevenuePct":0.7,
  "dataQualityFlag":"unmapped_items_present"}
]
```

### `GET /routes/NRV02/profitability?startDate=2026-07-01&endDate=2026-07-31`
```json
{ "data":[{
  "routeId":"r_nrv02","routeCode":"NRV02","monthKey":"2026-07",
  "totalRevenue":"41880.00","revenuePerStop":"118.64","stops":353,
  "serviceHours":232.4,"drivingHours":74.1,"avgDriveBetweenStopsMin":14.8,
  "laborCost":"7860.00","supplyCost":"2110.00","vehicleCost":"1450.00",
  "estContributionMargin":"30460.00","contributionPerStop":"86.29",
  "revenueByCategory":[{"categoryCode":"RESTROOM_HYGIENE","revenue":"23110.00"},
                       {"categoryCode":"DRAIN","revenue":"9840.00"}],
  "utilizationPct":81.2 }],
  "meta":{"source":"materialized","freshness":{"lastBatchAt":"2026-07-17T06:00:00Z"},
          "dataQuality":{"vehicleCostBasis":"per_route (UNCONFIRMED — see businessRules)"}} }
```

### `GET /technicians/e_1187/checkins?date=2026-07-14` (first BI report)
```json
[
 {"visitId":"v_100482","customer":"Riverside Diner (Main St)","routeCode":"NRV02",
  "checkIn":"09:12","checkOut":"09:58","serviceMinutes":46,"sourceElapsedMinutes":52,"elapsedStatus":"variance",
  "driveToNextMinutes":15.0,"nonDrivingGapToNextMinutes":18.0},
 {"visitId":"v_100485","customer":"NRV Auto Care","routeCode":"NRV02",
  "checkIn":"10:31","checkOut":"11:05","serviceMinutes":34,"sourceElapsedMinutes":34,"elapsedStatus":"ok",
  "driveToNextMinutes":9.0,"nonDrivingGapToNextMinutes":12.0}
]
```

Next: [`09-security-ops-roadmap.md`](09-security-ops-roadmap.md).
