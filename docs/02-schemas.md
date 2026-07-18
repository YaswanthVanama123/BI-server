# 4. Detailed MongoDB Schema for Every Collection

Notation: **R** = required, **O** = optional. Money = `Decimal128`. Dates = `Date` (UTC).
Every source-fed collection embeds the shared `source` sub-document below.

## 4.0 Shared conventions

### `source` sub-document (embedded on every imported record)

| Field | Type | R/O | Rule |
|---|---|---|---|
| `source.sourceSystem` | String enum | R | `routestar` \| `adp` \| `fastcash` \| `enviromaster` \| `quickbooks` \| `mapbox` \| `manual` |
| `source.sourceRecordId` | String | R | stable source PK (e.g. RouteStar invoice #, customer ID). Trimmed, case-preserved. |
| `source.sourceEntity` | String | R | e.g. `closed_invoice`, `invoice_line`, `pricing_row`, `payroll_entry` |
| `source.sourceUrl` | String | O | endpoint or screen URL when available |
| `source.sourceCreatedAt` | Date | O | source-reported create ts (UTC) |
| `source.sourceModifiedAt` | Date | O | source "last modified" — incremental watermark |
| `source.importedAt` | Date | R | first landed |
| `source.lastSyncedAt` | Date | R | last time re-observed from source |
| `source.importBatchId` | ObjectId → `importBatches` | R | provenance |
| `source.recordHash` | String (sha256 hex) | R | hash of normalized source payload; change detection |
| `source.syncStatus` | String enum | R | `inserted` \| `updated` \| `unchanged` \| `rejected` \| `superseded` |
| `source.dataQualityStatus` | String enum | R | `clean` \| `warning` \| `error` \| `quarantined` |
| `source.rawRef` | ObjectId → `raw_*` | O | pointer back to raw layer document |

**Standard indexes wherever `source` exists:**
`{ tenantId:1, 'source.sourceSystem':1, 'source.sourceRecordId':1 }` **unique**, and
`{ tenantId:1, 'source.sourceModifiedAt':1 }`.

### Money & time helpers
- Money fields are `Decimal128`; write via `Decimal128.fromString(value)`. Never `Number`.
- Every timestamp field `xAt` (UTC `Date`) is paired, where the wall clock matters, with `xLocal`
  (String `"YYYY-MM-DDTHH:mm:ss"`) and a document-level `timezone` (IANA, e.g. `America/New_York`).
- Period keys are stored as strings for cheap grouping/filtering: `dateKey`=`"YYYY-MM-DD"`,
  `isoWeek`=`"GGGG-'W'WW"`, `monthKey`=`"YYYY-MM"`.

---

## 4.1 `tenants` (source of truth, config)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id` | ObjectId | R | |
| `tenantCode` | String | R | unique, e.g. `EM-NRV` |
| `name` | String | R | |
| `reportingTimezone` | String (IANA) | R | default `America/New_York` |
| `currency` | String | R | ISO 4217, default `USD` |
| `fiscalYearStartMonth` | Int 1–12 | R | |
| `active` | Boolean | R | |
| `createdAt`/`updatedAt` | Date | R | timestamps |

Index: `{ tenantCode:1 }` unique.

## 4.2 `customers` (source of truth; changing attrs mirrored to history)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id` | ObjectId | R | internal PK — never replaced by account #/source id |
| `tenantId` | ObjectId → tenants | R | |
| `routeStarCustomerId` | String | R | **primary join key**; unique per tenant |
| `routeStarAccountNumber` | String | O* | RouteStar Account #; exact source value; unique per tenant when present |
| `quickBooksCustomerId` | String | O | reconciliation join |
| `customerName` | String | R | display only — never a join key |
| `companyName` | String | O | |
| `parentCustomerId` | ObjectId → customers | O | self-reference for parent/child accounts |
| `customerStatus` | String enum | R | `active`\|`suspended`\|`stopped`\|`cancelled`\|`churned`\|`inactive`\|`unknown` |
| `sourceStatusText` | String | O | raw status text incl. `ZZZ` naming convention |
| `customerStatusEffectiveAt` | Date | R | when current status began |
| `customerGrouping` | String | O | RouteStar customer grouping |
| `customerCategory` | String | O | **history-tracked** (see statusHistory pattern) |
| `salesRepresentative` | String | O | |
| `paymentTerms` | String | O | |
| `taxCode` | String | O | |
| `taxRate` | Decimal128 | O | |
| `balance` | Decimal128 | O | snapshot; authoritative balance is in accounting |
| `defaultRouteId` | ObjectId → routes | O | last resort in route attribution |
| `primaryLocationId` | ObjectId → customerLocations | O | |
| `source` | sub-doc | R | |
| `createdAt`/`updatedAt` | Date | R | |

\* `routeStarAccountNumber` optional only because some legacy accounts lack it; when present it is unique.

## 4.3 `customerLocations` (source of truth; addresses are history-tracked — see 4.14 note)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id` | ObjectId | R | |
| `tenantId` | ObjectId | R | |
| `customerId` | ObjectId → customers | R | |
| `routeStarLocationId` | String | O | source location id when present |
| `locationName` | String | O | customer/job name |
| `locationType` | String enum | R | `service`\|`billing`\|`both` |
| `addressLines` | [String] | R | 1–3 lines |
| `city` | String | R | |
| `state` | String | R | |
| `postalCode` | String | R | |
| `country` | String | R | default `US` |
| `sourceLatitude` | Double | O | **original RouteStar coord — never overwritten** |
| `sourceLongitude` | Double | O | " |
| `location` | GeoJSON Point | O | **normalized/validated** `{type:'Point', coordinates:[lng,lat]}` |
| `coordinateSource` | String enum | R | `routestar`\|`mapbox_geocode`\|`manual` |
| `geocodeAccuracy` | String | O | mapbox accuracy (`rooftop`,`street`,…) |
| `mapboxPlaceId` | String | O | |
| `geocodedAt` | Date | O | |
| `zone` | String | O | |
| `addressHash` | String | R | sha256 of normalized address; dedupe & change detection |
| `isActive` | Boolean | R | |
| `effectiveStart` | Date | R | address effective dating |
| `effectiveEnd` | Date | O | null = current |
| `source` | sub-doc | R | |

## 4.4 `customerContacts` (source of truth, PII)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`customerId` | | R | |
| `contactName` | String | O | |
| `role` | String | O | |
| `phone` | String (encrypted) | O | PII — field-level encryption, see §17 |
| `email` | String (encrypted) | O | PII |
| `isPrimary` | Boolean | R | |
| `source` | sub-doc | R | |

## 4.5 `customerStatusHistory` (source of truth — **retains history**)

Append-only. One row per status transition.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`customerId` | | R | |
| `status` | String enum | R | same enum as customers.customerStatus |
| `sourceStatusText` | String | O | |
| `effectiveStart` | Date | R | |
| `effectiveEnd` | Date | O | null = current |
| `reason` | String | O | |
| `source` | sub-doc | R | |

## 4.6 `customerServiceSchedules` (source of truth — **retains history**)

Effective-dated schedule; do not overwrite when route/tech/frequency changes.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`customerId` | | R | |
| `locationId` | ObjectId → customerLocations | O | |
| `routeId` | ObjectId → routes | R | |
| `technicianId` | ObjectId → employees | O | assigned tech |
| `normalizedFrequency` | String enum → frequencyDefinitions | R | |
| `sourceFrequencyText` | String | O | |
| `dayOfWeek` | String enum | O | `MON`..`SUN` |
| `stopNumber` | Int | O | |
| `originalStopNumber` | Int | O | |
| `nextServiceDate` | Date | O | |
| `isSuspended` | Boolean | R | |
| `suspendedAt` | Date | O | |
| `isMissedRoute` | Boolean | R | |
| `isActive` | Boolean | R | |
| `notes` | String | O | |
| `effectiveStart`/`effectiveEnd` | Date | R/O | |
| `source` | sub-doc | R | |

## 4.7 `customerPricingAgreements` (source of truth — **retains history**)

Header for a customer's pricing set at a point in time.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`customerId` | | R | |
| `routeStarAccountNumber` | String | O | denormalized business key |
| `agreementSourceId` | String | O | source id when present |
| `currency` | String | R | |
| `effectiveStart`/`effectiveEnd` | Date | R/O | |
| `isActive` | Boolean | R | |
| `source` | sub-doc | R | |

## 4.8 `customerPricingItems` (source of truth — **retains history**)

One row per pricing row per effective period. **Never overwrite prices — supersede.**

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`customerId` | | R | |
| `agreementId` | ObjectId → customerPricingAgreements | R | |
| `serviceItemId` | ObjectId → serviceItems | R | canonical item |
| `serviceCategoryId` | ObjectId → serviceCategories | R | resolved (may be Unmapped) |
| `sourceItemCode` | String | R | |
| `sourceDescription` | String | O | kept for audit |
| `pricingRowSourceId` | String | O | |
| `cost` | Decimal128 | O | |
| `salesPrice` | Decimal128 | R | |
| `defaultQuantity` | Decimal128 | R | |
| `unitOfMeasure` | String | O | |
| `sourceFrequencyText` | String | O | |
| `normalizedFrequency` | String enum | R | |
| `taxApplicable` | Boolean | O | |
| `currency` | String | R | |
| `effectiveStart`/`effectiveEnd` | Date | R/O | |
| `isActive` | Boolean | R | |
| `source` | sub-doc | R | |

## 4.9 `serviceItems` (source of truth — canonical catalogue)

Canonical, de-duplicated item catalogue. Source descriptions retained on the transactional rows.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `itemCode` | String | R | canonical code; unique per tenant |
| `description` | String | R | canonical description |
| `serviceCategoryId` | ObjectId → serviceCategories | R | default category |
| `unitOfMeasure` | String | O | |
| `isActive` | Boolean | R | |
| `sourceItemIds` | [String] | O | all raw source codes/ids that map here |
| `source` | sub-doc | O | |

## 4.10 `serviceCategories` (source of truth — config)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `categoryCode` | String | R | unique per tenant, e.g. `RESTROOM_HYGIENE`,`DRAIN`,`SCRUB`,`TRIP_CHARGE`,`WINDOW`,`SANI`,`OTHER`,`UNMAPPED` |
| `name` | String | R | display |
| `isRevenueCategory` | Boolean | R | trip charge etc. flags |
| `isUnmapped` | Boolean | R | true only for the `UNMAPPED` sentinel |
| `sortOrder` | Int | O | |

## 4.11 `itemCategoryMappings` (source of truth — config, editable without code change)

Maps raw RouteStar item codes/descriptions → canonical category. New/unknown items land in `UNMAPPED`
and are surfaced in data-quality.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `matchType` | String enum | R | `exact_code`\|`code_prefix`\|`description_regex` |
| `matchValue` | String | R | e.g. item code or regex |
| `serviceItemId` | ObjectId → serviceItems | O | |
| `serviceCategoryId` | ObjectId → serviceCategories | R | |
| `priority` | Int | R | lower wins on conflict |
| `isActive` | Boolean | R | |
| `reviewStatus` | String enum | R | `approved`\|`pending_review`\|`rejected` |
| `createdBy`/`updatedBy` | String | O | |

## 4.12 `frequencyDefinitions` (source of truth — config)

Normalizes RouteStar frequency text and holds the annualization factor used in recurring-revenue math.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `normalizedFrequency` | String enum | R | `weekly`\|`biweekly`\|`monthly`\|`twice_monthly`\|`quarterly`\|`semiannual`\|`annual`\|`one_time`\|`custom`\|`unknown` |
| `visitsPerYear` | Decimal128 | R | e.g. weekly=52, biweekly=26, twice_monthly=24, monthly=12 |
| `sourceTextPatterns` | [String] | R | regexes/synonyms matched from source |
| `isRecurring` | Boolean | R | |

## 4.13 `employees` (source of truth)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `employeeCode` | String | R | internal stable code; unique per tenant |
| `adpEmployeeId` | String | O | |
| `routeStarTechId` | String | O | RouteStar technician id |
| `fullName` | String | R | |
| `department` | String | O | |
| `employmentType` | String enum | R | `hourly`\|`salaried` |
| `isTechnician` | Boolean | R | |
| `status` | String enum | R | `active`\|`inactive`\|`terminated` |
| `hireDate`/`terminationDate` | Date | O | |
| `source` | sub-doc | O | |

## 4.14 `employeeSourceMappings` (source of truth — resolves ADP↔RouteStar↔name)

Stable mapping so payroll (ADP) links to RouteStar technician without name matching.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`employeeId` | | R | |
| `sourceSystem` | String enum | R | `adp`\|`routestar`\|`fastcash` |
| `sourceEmployeeId` | String | O | e.g. ADP id |
| `sourceEmployeeName` | String | O | as it appears in that source |
| `nameNormalization` | String | O | normalized name for fuzzy fallback |
| `confidence` | String enum | R | `exact`\|`manual`\|`fuzzy` |
| `isActive` | Boolean | R | |

Unique: `{tenantId, sourceSystem, sourceEmployeeId}` (and a partial unique on normalized name where id absent).

## 4.15 `employeeRateHistory` (source of truth — **retains history**)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`employeeId` | | R | |
| `rateType` | String enum | R | `base_hourly`\|`overtime`\|`skill_tier`\|`salary_annual` |
| `skillTier` | String | O | |
| `rate` | Decimal128 | R | hourly or annual salary |
| `effectiveStart`/`effectiveEnd` | Date | R/O | |
| `source` | sub-doc | R | |

## 4.16 `laborCostRates` (source of truth — config; **burden** lives here, not hard-coded)

Fully-burdened labor rate assumptions per skill tier / employment type / period.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `scope` | String enum | R | `employee`\|`skill_tier`\|`department`\|`default` |
| `employeeId` | ObjectId | O | when scope=employee |
| `skillTier`/`department` | String | O | |
| `baseHourly` | Decimal128 | O | |
| `burdenMultiplier` | Decimal128 | R | e.g. 1.35 (taxes/benefits/insurance) — **business-confirmable** |
| `burdenedHourly` | Decimal128 | O | precomputed or derived |
| `effectiveStart`/`effectiveEnd` | Date | R/O | |

## 4.17 `payrollPeriods` (source of truth)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `periodStart`/`periodEnd` | Date | R | |
| `payFrequency` | String enum | R | `weekly`\|`biweekly`\|`semimonthly`\|`monthly` |
| `checkDate` | Date | O | |
| `status` | String enum | R | `open`\|`closed` |
| `source` | sub-doc | R | |

Validation: periods per tenant must not overlap (checked in DQ, see §12).

## 4.18 `payrollEntries` (source of truth)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`payrollPeriodId`,`employeeId` | | R | |
| `department` | String | O | |
| `availableRates` | [Decimal128] | O | rates offered |
| `appliedRate` | Decimal128 | O | rate used |
| `regularHours` | Decimal128 | R | |
| `overtimeHours` | Decimal128 | R | default 0 |
| `vacationHours` | Decimal128 | R | default 0 |
| `sickHours` | Decimal128 | R | default 0 |
| `otherUnavailableHours` | Decimal128 | R | default 0 |
| `salaryAmount` | Decimal128 | O | |
| `bonusAmount` | Decimal128 | O | |
| `commissionAmount` | Decimal128 | O | |
| `miscReimbursement` | Decimal128 | O | |
| `checkDate` | Date | O | |
| `computedLaborCost` | Decimal128 | O | derived (hourly: rate×hours; salaried: allocated) |
| `source` | sub-doc | R | |

Unique: `{tenantId, 'source.sourceRecordId'}` and `{tenantId, employeeId, payrollPeriodId}`.

## 4.19 `employeeAvailability` (source of truth / derived per period)

Available hours per employee per payroll period — the denominator for utilization.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`employeeId`,`payrollPeriodId` | | R | |
| `scheduledHours` | Decimal128 | R | configured available hours for the period |
| `vacationHours`/`sickHours`/`otherUnavailableHours` | Decimal128 | R | from payroll |
| `availableHours` | Decimal128 | R | `scheduled − vacation − sick − other` |
| `computationNote` | String | O | how scheduledHours was set (config vs. salaried default) |

## 4.20 `routes` (source of truth)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `routeCode` | String | R | e.g. `NRV01`; unique per tenant |
| `sourceRouteId` | String | O | |
| `routeName` | String | O | |
| `isActive` | Boolean | R | |
| `effectiveStart`/`effectiveEnd` | Date | R/O | |
| `source` | sub-doc | O | |

## 4.21 `routeAssignmentHistory` (source of truth — **retains history**)

Which technician ran which route over time (the "as actually run" assignment).

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`routeId`,`technicianId` | | R | |
| `effectiveStart`/`effectiveEnd` | Date | R/O | |
| `assignmentType` | String enum | R | `primary`\|`backup`\|`observed` |
| `source` | sub-doc | O | |

## 4.22 `serviceVisits` (source of truth — the stop/service-visit model; **first BI report**)

Central operational fact. One per completed stop.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `routeStarInvoiceNumber` | String | O | when the visit maps 1:1 to an invoice |
| `invoiceId` | ObjectId → invoices | O | |
| `customerId` | ObjectId → customers | R | |
| `locationId` | ObjectId → customerLocations | O | resolved service location |
| `routeId` | ObjectId → routes | O | attributed route |
| `routeAttributionMethod` | String enum | R | `visit`\|`invoice`\|`tech_assignment`\|`customer_default`\|`unassigned` |
| `routeAttributionConfidence` | String enum | R | `high`\|`medium`\|`low` |
| `technicianId` | ObjectId → employees | O | |
| `serviceCategoryIds` | [ObjectId] | O | categories serviced (from lines) |
| `serviceDate` | Date | R | date completed |
| `dateKey`/`isoWeek`/`monthKey` | String | R | period keys (reporting tz) |
| `arrivalAt` | Date (UTC) | O | check-in |
| `arrivalLocal` | String | O | wall clock |
| `departureAt` | Date (UTC) | O | check-out |
| `departureLocal` | String | O | |
| `timezone` | String | R | |
| `sourceElapsedTimeMinutes` | Decimal128 | O | RouteStar-reported elapsed |
| `calculatedElapsedTimeMinutes` | Decimal128 | O | `departureAt − arrivalAt` |
| `elapsedTimeVarianceMinutes` | Decimal128 | O | source − calculated |
| `elapsedTimeValidationStatus` | String enum | R | `ok`\|`variance`\|`missing_times`\|`negative`\|`overlap`\|`crosses_midnight` |
| `serviceDurationMinutes` | Decimal128 | O | canonical duration used downstream (= calculated when valid) |
| `completionStatus` | String enum | R | `completed`\|`cancelled`\|`suspended`\|`missed` |
| `serviceNotes` | String | O | |
| `enteredBy` | String | O | |
| `outgoingRouteLegId` | ObjectId → routeLegs | O | leg to next stop |
| `source` | sub-doc | R | |

## 4.23 `invoices` (source of truth)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `invoiceNumber` | String | R | unique per tenant |
| `customerId` | ObjectId → customers | R | |
| `routeStarAccountNumber` | String | O | denormalized |
| `invoiceType` | String enum | R | `recurring`\|`one_time`\|`credit`\|`adjustment`\|`trip_charge`\|`unknown` |
| `status` | String enum | R | `open`\|`closed`\|`void`\|`credit`\|`paid` |
| `invoiceDate` | Date | R | |
| `dateCompleted` | Date | O | |
| `enteredBy` | String | O | |
| `assignedToEmployeeId` | ObjectId → employees | O | |
| `routeId` | ObjectId → routes | O | invoice-level route (attribution tier 2) |
| `customerGrouping` | String | O | |
| `subtotal` | Decimal128 | R | |
| `taxTotal` | Decimal128 | O | |
| `total` | Decimal128 | R | |
| `lineItemsTotal` | Decimal128 | O | derived Σ line amounts (reconciliation) |
| `totalVariance` | Decimal128 | O | total − lineItemsTotal |
| `reconciliationStatus` | String enum | R | `ok`\|`variance`\|`no_lines` |
| `isRevenueRecognized` | Boolean | R | false for void/credit per businessRules |
| `monthKey` | String | R | |
| `source` | sub-doc | R | |

## 4.24 `invoiceLineItems` (source of truth — separate collection, never embedded unbounded)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId`,`invoiceId`,`customerId` | | R | |
| `lineNumber` | Int | O | |
| `serviceItemId` | ObjectId → serviceItems | O | canonical |
| `serviceCategoryId` | ObjectId → serviceCategories | R | resolved (UNMAPPED if none) |
| `serviceVisitId` | ObjectId → serviceVisits | O | when identifiable |
| `routeId` | ObjectId → routes | O | |
| `technicianId` | ObjectId → employees | O | |
| `sourceItemCode` | String | R | |
| `sourceDescription` | String | O | retained for audit |
| `quantity` | Decimal128 | R | |
| `rate` | Decimal128 | R | line-item rate (history via snapshot) |
| `sourceAmount` | Decimal128 | R | |
| `calculatedAmount` | Decimal128 | R | quantity × rate |
| `amountVariance` | Decimal128 | R | source − calculated |
| `validationStatus` | String enum | R | `ok`\|`variance`\|`negative` |
| `class`,`warehouse`,`taxCode`,`itemLocation` | String | O | |
| `invoiceDate` | Date | R | denormalized for line-level date filters |
| `serviceDate` | Date | O | |
| `invoiceStatus` | String | R | denormalized |
| `isRevenueRecognized` | Boolean | R | denormalized from invoice + rules |
| `monthKey` | String | R | |
| `source` | sub-doc | R | |

## 4.25 `routeLegs` (derived — computed & stored; Mapbox)

Drive-time/distance between consecutive stops of the same technician/route on the same day.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `serviceDate`,`dateKey` | Date/String | R | |
| `technicianId` | ObjectId | O | |
| `routeId` | ObjectId | O | |
| `fromVisitId`/`toVisitId` | ObjectId → serviceVisits | R | |
| `fromInvoiceId`/`toInvoiceId` | ObjectId | O | |
| `fromCustomerId`/`toCustomerId` | ObjectId | R | |
| `fromLocationId`/`toLocationId` | ObjectId | O | |
| `fromDepartureTime`/`toArrivalTime` | Date | O | |
| `observedGapMinutes` | Decimal128 | O | toArrival − fromDeparture |
| `fromCoord`/`toCoord` | [lng,lat] | O | used for Mapbox (coords, not names) |
| `mapboxDistanceMeters` | Double | O | |
| `mapboxDistanceMiles` | Double | O | |
| `mapboxDurationSeconds` | Double | O | |
| `mapboxDurationMinutes` | Double | O | |
| `mapboxDurationTrafficSeconds` | Double | O | when profile supports |
| `profile` | String | R | `driving`\|`driving-traffic` |
| `geometry` | GeoJSON LineString | O | optional |
| `nonDrivingGapMinutes` | Decimal128 | O | observedGap − mapboxDurationMinutes |
| `mapboxRequestHash` | String | R | cache key |
| `mapboxResponseAt` | Date | O | |
| `calculationStatus` | String enum | R | `ok`\|`missing_coords`\|`missing_times`\|`overlap`\|`same_location`\|`different_tech`\|`crosses_midnight`\|`negative_gap`\|`large_gap`\|`first_stop`\|`last_stop`\|`mapbox_failed`\|`duration_gt_gap` |
| `calculatedAt` | Date | R | |

Unique: `{tenantId, fromVisitId, toVisitId}`.

## 4.26 `mapboxRouteCache` (derived — computed & stored; cost control)

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id` | ObjectId | R | |
| `originHash`/`destinationHash` | String | R | hash of rounded coords (≈5 decimals) |
| `originCoord`/`destinationCoord` | [lng,lat] | R | |
| `profile` | String | R | |
| `timeBucket` | String | R | e.g. `weekday-am`, `weekday-pm`, `weekend`, or `any` |
| `distanceMeters`/`durationSeconds`/`durationTrafficSeconds` | Double | R/O | |
| `geometry` | GeoJSON LineString | O | |
| `mapboxResponseAt` | Date | R | |
| `hitCount` | Int | R | usage counter |
| `expiresAt` | Date | O | optional TTL for traffic-aware entries |

Unique: `{originHash, destinationHash, profile, timeBucket}`.

## 4.27 Cost collections (source of truth / config)

**`supplyCosts`** — supply/chemical cost per job or per item (EnviroMaster Store): `{_id,tenantId,
serviceItemId?,serviceVisitId?,routeId?,customerId?,costType(enum: per_job|per_item|allocation),
amount:Decimal128,effectiveStart,effectiveEnd,source}`.

**`serviceItemCostHistory`** — cost of a canonical item over time: `{_id,tenantId,serviceItemId,
unitCost:Decimal128,effectiveStart,effectiveEnd,source}`.

**`vehicleCosts`** — *business-confirmable allocation*: `{_id,tenantId,allocationBasis(enum:
per_tech|per_route|fixed_pool),routeId?,employeeId?,periodMonthKey,amount:Decimal128,source}`.

**`costAllocationRules`** — how costs roll to stop/route/customer: `{_id,tenantId,ruleType(enum:
labor|supply|vehicle|other),basis(enum: per_stop|per_hour|per_mile|revenue_share|equal_split),
params:Mixed,effectiveStart,effectiveEnd,active}`.

## 4.28 `businessRules` (source of truth — config; no hard-coded assumptions)

Single, versioned place for tunable assumptions.

| Field | Type | R/O | Notes |
|---|---|---|---|
| `_id`,`tenantId` | | R | |
| `key` | String | R | e.g. `stopsPerDayBenchmark`, `reportingTimezone`, `revenueAllocationMethod`, `largeGapThresholdMinutes`, `salariedDefaultAvailableHours`, `excludeStatusesFromRevenue`, `elapsedVarianceToleranceMinutes` |
| `value` | Mixed | R | |
| `valueType` | String enum | R | `number`\|`string`\|`boolean`\|`json` |
| `effectiveStart`/`effectiveEnd` | Date | R/O | rules are versioned |
| `updatedBy` | String | O | |

Seed values: `stopsPerDayBenchmark=10`, `largeGapThresholdMinutes=180`,
`elapsedVarianceToleranceMinutes=10`, `revenueAllocationMethod="proportional_by_line"`,
`excludeStatusesFromRevenue=["void","credit"]`.

## 4.29 Governance collections

**`importBatches`** — `{_id,tenantId,sourceSystem,sourceEntity,fileName?,fileHash?,startedAt,
finishedAt,status(enum: running|completed|failed|partial),counts:{read,inserted,updated,unchanged,
rejected},reconciliation:{sourceRowCount,sourceTotalAmount:Decimal128,loadedRowCount,
loadedTotalAmount:Decimal128,matched:Boolean},watermarkBefore,watermarkAfter,errorSummary?}`.

**`sourceSyncStates`** — one per (tenant, sourceSystem, sourceEntity): `{_id,tenantId,sourceSystem,
sourceEntity,lastSuccessfulSyncAt,lastWatermark(source modified ts or max id),lastBatchId,
cursor?,status,retryCount}`.

**`dataQualityIssues`** — see §12: `{_id,tenantId,issueType,severity(enum: info|warning|error|
critical),collectionName,recordId,sourceRecordId,sourceSystem,description,context:Mixed,detectedAt,
detectedByBatchId,resolutionStatus(enum: open|acknowledged|resolved|ignored),resolvedAt,
resolvedBy,resolutionNotes}`.

**`auditLog`** — `{_id,tenantId,entity,entityId,action(enum: insert|update|supersede|delete|
recompute),actor(enum: etl|user|system),actorId,batchId?,before?,after?,changedFields:[String],at}`.

## 4.30 Materialized summary collections

**`dailyTechnicianMetrics`** (grain: tenant×technician×date): `{_id,tenantId,technicianId,serviceDate,
dateKey,isoWeek,monthKey,department?,routeIds:[ObjectId],stopCount,completedStops,cancelledStops,
suspendedStops,missedStops,totalServiceMinutes:Decimal128,totalDrivingMinutes:Decimal128,
totalNonDrivingGapMinutes:Decimal128,availableHours:Decimal128,loggedServiceHours:Decimal128,
utilizationPercentage:Decimal128,benchmarkStopsPerDay,stopsVsBenchmark,revenue:Decimal128,
laborCost:Decimal128,computedAt,sourceBatchIds:[ObjectId]}`.

**`monthlyRouteMetrics`** (grain: tenant×route×month): totals for stops, service hours, driving hours,
avg drive time between stops, revenue, line-item revenue, revenue by category (sub-doc array),
revenue per stop, revenue per tech, labor cost, estimated contribution margin, utilization, trend refs.

**`monthlyCustomerMetrics`** (grain: tenant×customer×month): total/recurring/one-time revenue, revenue
by category, stop count, revenue per stop, service hours, driving time, labor cost, frequency,
route status, customer profitability, MoM/YoY deltas.

**`monthlyCategoryMetrics`** (grain: tenant×category×month, optionally ×route/×tech): revenue, quantity,
invoice count, stop count, avg revenue per stop/invoice, category revenue %, MoM/YoY.

All materialized docs carry `computedAt` + `sourceBatchIds` so staleness is visible and rebuilds are traceable.

## 4.31 Raw layer collections

All `raw_*` share: `{_id,tenantId,sourceSystem,sourceEntity,importBatchId,sourceRecordId,recordHash,
rawPayload:Mixed(verbatim row/JSON),rawHeaders:[String],rowNumber,importedAt,lastSeenAt,
supersededByHash?,parseStatus(enum: parsed|parse_error),parseErrors?:[String]}`.
Unique: `{tenantId,sourceSystem,sourceEntity,sourceRecordId,recordHash}` (a new hash = new version row;
the curated upsert always reads the latest hash).

Next: [`03-relationships-indexes.md`](03-relationships-indexes.md).
