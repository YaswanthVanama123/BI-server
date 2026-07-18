# 1–3. Architecture Overview, Source-to-Target Mapping, Collection List

## 1. Architecture overview

### 1.1 Goals

Build an operational + financial BI platform that answers, per tenant (franchise/company):

1. **Technician time & capacity** — check-in/out per stop, service time vs. drive time, utilization.
2. **Stops per technician** per day/week/month vs. the ~10 stops/tech/day benchmark.
3. **Driving time between consecutive stops** (Mapbox), and non-driving gap analysis.
4. **Stop volume** monthly, by route/tech/customer/category (validates the FastCash 400–500/mo figure).
5. **Revenue** per stop, per line item, by service category, by route, by customer, by technician.
6. **Cost & contribution** — labor (ADP), supply (EnviroMaster), vehicle (TBD), per stop/route/customer.
7. **Customer status/pricing/schedule history** — churn-adjusted, historically accurate.

### 1.2 Physical/logical architecture

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ SOURCES                                                                        │
 │  RouteStar (CSV export / API / controlled extraction)                          │
 │   • Closed Invoices + stop times   • Invoice detail (line items)               │
 │   • Customer details (Account #)   • Pricing tab   • Customer routes           │
 │  ADP / payroll export     FastCash (recon)     EnviroMaster Store (supply)     │
 │  Mapbox (Directions / Matrix / Geocoding)                                      │
 └───────────────┬────────────────────────────────────────────────────────────────┘
                 │  (1) land verbatim + source metadata + recordHash
                 ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ RAW / SOURCE LAYER  (immutable, append/upsert by sourceRecordId+recordHash)    │
 │  raw_routestar_invoices   raw_routestar_invoice_lines   raw_routestar_customers│
 │  raw_routestar_pricing    raw_routestar_customer_routes raw_adp_payroll        │
 │  raw_fastcash_weekly      raw_enviromaster_supply                              │
 └───────────────┬────────────────────────────────────────────────────────────────┘
                 │  (2) standardize → resolve mappings → idempotent upsert
                 ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ CURATED — SOURCE OF TRUTH  (cleaned, linked, effective-dated history)          │
 │  tenants customers customerLocations customerContacts customerStatusHistory    │
 │  customerServiceSchedules customerPricingAgreements customerPricingItems       │
 │  serviceItems serviceCategories itemCategoryMappings frequencyDefinitions      │
 │  employees employeeSourceMappings employeeRateHistory payrollPeriods           │
 │  payrollEntries employeeAvailability routes routeAssignmentHistory             │
 │  serviceVisits invoices invoiceLineItems  laborCostRates supplyCosts           │
 │  serviceItemCostHistory vehicleCosts costAllocationRules businessRules          │
 └───────┬───────────────────────────────────┬──────────────────────────────────┘
         │ (3) compute (Mapbox + rules)       │ (4) aggregate / materialize
         ▼                                    ▼
 ┌───────────────────────────┐   ┌───────────────────────────────────────────────┐
 │ DERIVED — COMPUTED         │   │ DERIVED — MATERIALIZED SUMMARIES (BI perf)     │
 │  routeLegs                 │   │  dailyTechnicianMetrics  monthlyRouteMetrics   │
 │  mapboxRouteCache          │   │  monthlyCustomerMetrics  monthlyCategoryMetrics│
 └───────────────────────────┘   └───────────────────────────────────────────────┘
                 │
                 ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ GOVERNANCE / OPERATIONS                                                        │
 │  importBatches  sourceSyncStates  dataQualityIssues  auditLog                  │
 └──────────────────────────────────────────────────────────────────────────────┘
                 │
                 ▼   BI API (filters: date range, route, tech, dept, customer, category, status…)
              Frontend
```

### 1.3 Data-treatment classification (required distinction)

| Treatment | Meaning | Examples |
|---|---|---|
| **Permanently stored (source of truth)** | Original business facts; never derived | invoices, invoiceLineItems, serviceVisits, payrollEntries, customers, customerLocations, customerPricingItems |
| **Derived at query time** | Cheap to compute on demand; not stored | ad-hoc revenue filters, single-customer P&L drill-down, `serviceDurationMinutes` in a live query |
| **Computed & stored** | Expensive/external; stored to avoid recompute & API cost | routeLegs (Mapbox), mapboxRouteCache, elapsed-time validation fields |
| **Materialized for BI performance** | Pre-aggregated rollups refreshed by ETL | dailyTechnicianMetrics, monthlyRouteMetrics, monthlyCustomerMetrics, monthlyCategoryMetrics |
| **Must retain history** | Business value changes over time | pricing, frequency, route/tech assignment, customer status, wage rate, service address, line-item rate, customer category |
| **Requires business confirmation** | Rule/assumption not yet defined | vehicle-cost allocation, burden %, revenue-allocation for multi-visit invoices, supply-cost per job source |

### 1.4 Source-of-truth vs. derived — explicit list

- **Source-of-truth (authoritative):** `tenants`, `customers`, `customerLocations`, `customerContacts`,
  `customerStatusHistory`, `customerServiceSchedules`, `customerPricingAgreements`,
  `customerPricingItems`, `serviceItems`, `serviceCategories`, `itemCategoryMappings`,
  `frequencyDefinitions`, `employees`, `employeeSourceMappings`, `employeeRateHistory`,
  `payrollPeriods`, `payrollEntries`, `employeeAvailability`, `routes`, `routeAssignmentHistory`,
  `serviceVisits`, `invoices`, `invoiceLineItems`, `laborCostRates`, `supplyCosts`,
  `serviceItemCostHistory`, `vehicleCosts`, `costAllocationRules`, `businessRules`.
- **Raw/source layer (traceability, reprocessable):** all `raw_*`.
- **Derived — computed & stored:** `routeLegs`, `mapboxRouteCache`.
- **Derived — materialized summaries:** `dailyTechnicianMetrics`, `monthlyRouteMetrics`,
  `monthlyCustomerMetrics`, `monthlyCategoryMetrics` (+ optional `stopsPerTechnicianDaily` cache).
- **Governance:** `importBatches`, `sourceSyncStates`, `dataQualityIssues`, `auditLog`.

> **Rule:** derived and materialized collections can always be dropped and rebuilt from the
> source-of-truth + raw layers. They never hold data that exists nowhere else.

---

## 2. Source-to-target data mapping

RouteStar screen → curated field. Types & validation in `02-schemas.md`. `source.*` metadata is
implicit on every target row.

### 2.1 RouteStar Closed Invoices + stop-time screen → `invoices` + `serviceVisits`

| RouteStar field | Target collection.field | Notes |
|---|---|---|
| Invoice # | `invoices.invoiceNumber` | unique per tenant |
| Invoice date | `invoices.invoiceDate` | UTC + tz |
| Entered by | `invoices.enteredBy` | free text / resolved employee |
| Assigned to | `invoices.assignedToEmployeeId` → also `serviceVisits.technicianId` | resolve via `employeeSourceMappings` |
| Customer | `invoices.customerId` (via routeStarCustomerId) | **never** matched by name |
| Invoice type | `invoices.invoiceType` | recurring/one-time/credit/adjustment |
| Service notes | `serviceVisits.serviceNotes` | |
| Subtotal | `invoices.subtotal` (Decimal128) | reconciled vs. line items |
| Total | `invoices.total` (Decimal128) | reconciled |
| Date completed | `serviceVisits.serviceDate` / `invoices.dateCompleted` | drives period bucketing |
| Last modified | `invoices.source.sourceModifiedAt` | incremental watermark |
| Arrival time | `serviceVisits.arrivalAt` (UTC) + `arrivalLocal` | check-in |
| Departure time | `serviceVisits.departureAt` (UTC) + `departureLocal` | check-out |
| Elapsed time | `serviceVisits.sourceElapsedTimeMinutes` | **validated, not trusted** |
| Customer grouping | `invoices.customerGrouping` / `customers.customerGrouping` | |
| Route | `serviceVisits.routeId` (via routes) | attribution hierarchy §route |
| Technician/employee | `serviceVisits.technicianId` | |
| Customer identifier | `customers.routeStarCustomerId` | |
| RouteStar account # | `customers.routeStarAccountNumber` | business key |

Computed on `serviceVisits`: `calculatedElapsedTimeMinutes = departureAt − arrivalAt`,
`elapsedTimeVarianceMinutes`, `elapsedTimeValidationStatus`.

### 2.2 RouteStar Invoice Detail → `invoiceLineItems`

| RouteStar field | Target field | Notes |
|---|---|---|
| Item | `serviceItemId` (canonical) + `sourceItemCode` | canonical via catalogue |
| Description | `sourceDescription` (+ canonical `serviceItems.description`) | keep source for audit |
| Quantity | `quantity` (Decimal128) | |
| Rate | `rate` (Decimal128) | history via line snapshot |
| Amount | `sourceAmount` (Decimal128) | validated vs. qty×rate |
| Class | `class` | |
| Warehouse | `warehouse` | |
| Tax code | `taxCode` | |
| Item location | `itemLocation` | |
| Invoice number | `invoiceId` (resolved) + `invoiceNumber` | |
| Invoice date | denormalized `invoiceDate` | for line-level date filters |
| Customer | `customerId` | |
| RouteStar account # | `routeStarAccountNumber` (denorm) | |
| Service date | `serviceDate` | |
| Invoice status | `invoiceStatus` (denorm) | exclude void/credit from revenue per rules |
| Subtotal/Tax/Total | on parent `invoices` | |

Computed: `calculatedAmount = quantity × rate`, `amountVariance`, `validationStatus`,
`serviceCategoryId` (via `itemCategoryMappings`).

### 2.3 RouteStar Customer Details → `customers` + `customerLocations` + `customerContacts`

| RouteStar field | Target | Notes |
|---|---|---|
| Account # | `customers.routeStarAccountNumber` | preserve exact source value |
| Customer/job name | `customers.customerName` / `customerLocations.locationName` | display only |
| Company | `customers.companyName` | |
| Service address 1/2/3 | `customerLocations.addressLines[]` | |
| City/State/ZIP | `customerLocations.city/state/postalCode` | |
| Latitude/Longitude | `customerLocations.sourceLatitude/sourceLongitude` **and** `location` (GeoJSON, normalized) | never overwrite source |
| Zone | `customerLocations.zone` | |
| Billing address | `customerLocations` (type=billing) | |
| Phone/email | `customerContacts` | PII — see §17 |
| Parent customer | `customers.parentCustomerId` | self-ref |
| RouteStar customer ID | `customers.routeStarCustomerId` | primary join key |

### 2.4 RouteStar Pricing tab → `customerPricingAgreements` + `customerPricingItems`

| RouteStar field | Target | Notes |
|---|---|---|
| Item | `customerPricingItems.serviceItemId` + `sourceItemCode` | |
| Description | `sourceDescription` | canonical on `serviceItems` |
| Cost | `cost` (Decimal128) | |
| Sales price | `salesPrice` (Decimal128) | |
| Default quantity | `defaultQuantity` (Decimal128) | |
| Frequency | `sourceFrequencyText` + `normalizedFrequency` | normalize via `frequencyDefinitions` |

### 2.5 RouteStar Customer Routes → `customerServiceSchedules` + `routeAssignmentHistory`

| RouteStar field | Target | Notes |
|---|---|---|
| Frequency | `normalizedFrequency` (+source) | |
| Route | `routeId` | |
| Service date / Day | `dayOfWeek`, `nextServiceDate` | |
| Assigned technician | `technicianId` | |
| Assigned date | `effectiveStart` | |
| Stop number / Original stop | `stopNumber`, `originalStopNumber` | |
| Suspended | `isSuspended`, `suspendedAt` | |
| Notes | `notes` | |
| Missed route | `isMissedRoute` | |
| Active | `isActive` + `customerStatusHistory` | |

### 2.6 ADP / payroll → `employees` + `payrollPeriods` + `payrollEntries` + `employeeRateHistory`

| Payroll field | Target | Notes |
|---|---|---|
| Employee name | `employees.fullName` | resolve mapping |
| Employee ID | `employees.adpEmployeeId` / `employeeSourceMappings` | |
| Department | `payrollEntries.department` / `employees.department` | |
| Available rates | `payrollEntries.availableRates[]` | |
| Applied rate | `payrollEntries.appliedRate` (Decimal128) | |
| Regular hours | `payrollEntries.regularHours` | |
| Salary amount | `payrollEntries.salaryAmount` (Decimal128) | |
| Bonus / Commission / Misc reimb. | `payrollEntries.bonusAmount/commissionAmount/miscReimbursement` | |
| Overtime hours | `payrollEntries.overtimeHours` | |
| Vacation / Sick / Absence hours | `payrollEntries.vacationHours/sickHours/otherUnavailableHours` | |
| Period start/end | `payrollPeriods.periodStart/periodEnd` | |
| Check date | `payrollEntries.checkDate` | |

### 2.7 Mapbox → `routeLegs` + `mapboxRouteCache` + `customerLocations.location`

| Mapbox output | Target | Notes |
|---|---|---|
| distance (m) | `routeLegs.mapboxDistanceMeters` (+ miles) | |
| duration (s) | `routeLegs.mapboxDurationSeconds` (+ min) | |
| traffic duration | `routeLegs.mapboxDurationTrafficSeconds` | when profile supports |
| geometry | `routeLegs.geometry` (GeoJSON LineString, optional) | |
| profile | `routeLegs.profile` / cache key | |
| response ts | `routeLegs.mapboxResponseAt` | |
| geocode result | `customerLocations.location` + `geocodeAccuracy`/`mapboxPlaceId` | never overwrites source coords |

### 2.8 Reconciliation-only sources

| Source | Target | Use |
|---|---|---|
| FastCash weekly revenue/deal count by route | `raw_fastcash_weekly` (+ `dataQualityIssues` on mismatch) | validate RouteStar stop volume & revenue |
| QuickBooks client ID | `customers.quickBooksCustomerId` | client-level P&L join (corporate-fee recon out of scope) |
| EnviroMaster Store | `supplyCosts` / `serviceItemCostHistory` | supply cost per job/item |

---

## 3. Complete collection list

### Raw / source layer
`raw_routestar_invoices`, `raw_routestar_invoice_lines`, `raw_routestar_customers`,
`raw_routestar_pricing`, `raw_routestar_customer_routes`, `raw_adp_payroll`,
`raw_fastcash_weekly`, `raw_enviromaster_supply`.

### Curated — source of truth
1. `tenants`
2. `customers`
3. `customerLocations`
4. `customerContacts`
5. `customerStatusHistory`
6. `customerServiceSchedules`
7. `customerPricingAgreements`
8. `customerPricingItems`
9. `serviceItems`
10. `serviceCategories`
11. `itemCategoryMappings`
12. `frequencyDefinitions`
13. `employees`
14. `employeeSourceMappings`
15. `employeeRateHistory`
16. `payrollPeriods`
17. `payrollEntries`
18. `employeeAvailability`
19. `routes`
20. `routeAssignmentHistory`
21. `serviceVisits`
22. `invoices`
23. `invoiceLineItems`
24. `laborCostRates`
25. `supplyCosts`
26. `serviceItemCostHistory`
27. `vehicleCosts`
28. `costAllocationRules`
29. `businessRules`

### Derived — computed & stored
30. `routeLegs`
31. `mapboxRouteCache`

### Derived — materialized summaries
32. `dailyTechnicianMetrics`
33. `monthlyRouteMetrics`
34. `monthlyCustomerMetrics`
35. `monthlyCategoryMetrics`
36. `stopsPerTechnicianDaily` *(optional cache; can be a view over dailyTechnicianMetrics)*

### Governance / operations
37. `importBatches`
38. `sourceSyncStates`
39. `dataQualityIssues`
40. `auditLog`

Next: [`02-schemas.md`](02-schemas.md) for the detailed schema of every collection.
