# 12. Data-Quality & Reconciliation Framework

Every check writes a `dataQualityIssues` document (schema §4.29) with:
`issueType, severity, collectionName, recordId, sourceRecordId, sourceSystem, description, context,
detectedAt, detectedByBatchId, resolutionStatus, resolvedAt, resolvedBy, resolutionNotes`.

Checks run in ETL step 8 (per-batch, scoped to touched records) and as a nightly full sweep.
Implementation: [`../src/services/dataQuality/dataQualityChecks.js`](../src/services/dataQuality/dataQualityChecks.js).

## 12.1 Check catalogue

| issueType | Rule | Default severity | Collection |
|---|---|---|---|
| `duplicate_invoice_number` | >1 invoice with same (tenant, invoiceNumber) | critical | invoices |
| `duplicate_routestar_customer_id` | >1 customer same routeStarCustomerId | critical | customers |
| `duplicate_account_number` | >1 customer same routeStarAccountNumber | error | customers |
| `invoice_total_mismatch` | `abs(invoice.total − Σ line amounts) > tol` | error | invoices |
| `line_amount_mismatch` | `abs(sourceAmount − quantity×rate) > tol` | warning | invoiceLineItems |
| `departure_before_arrival` | `departureAt < arrivalAt` | error | serviceVisits |
| `next_arrival_before_prev_departure` | overlap between consecutive stops same tech/day | warning | routeLegs |
| `missing_customer_ref` | visit/invoice/line without resolvable customerId | error | serviceVisits/invoices |
| `missing_employee_mapping` | technician/name unmapped to employees | warning | serviceVisits/payrollEntries |
| `missing_route_mapping` | route code not in routes | warning | serviceVisits/invoices |
| `missing_coordinates` | location has no source coords and geocode failed | warning | customerLocations |
| `invalid_coordinates` | `|lat|>90 || |lng|>180 || (0,0)` or outside tenant bbox | error | customerLocations |
| `missing_pricing_frequency` | pricing row with no normalizable frequency | warning | customerPricingItems |
| `unknown_service_item_category` | line/pricing item resolves to UNMAPPED | warning | invoiceLineItems |
| `negative_invoice_amount` | invoice total < 0 (non-credit) | warning | invoices |
| `revenue_included_void` | void/credit invoice with isRevenueRecognized=true | error | invoices |
| `payroll_period_overlap` | two payrollPeriods overlap for tenant | error | payrollPeriods |
| `visit_outside_payroll_period` | visit serviceDate not covered by any payroll period | info | serviceVisits |
| `mapbox_duration_gt_gap` | leg mapboxDurationMinutes > observedGapMinutes | warning | routeLegs |
| `unusually_long_service_duration` | serviceDurationMinutes > businessRules max | warning | serviceVisits |
| `unusually_long_drive_gap` | observedGapMinutes > largeGapThresholdMinutes | info | routeLegs |
| `invoice_without_service_visit` | closed invoice with no linkable visit | warning | invoices |
| `visit_without_invoice` | completed visit with no invoice | info | serviceVisits |
| `elapsed_time_variance` | `abs(source − calculated) > elapsedVarianceToleranceMinutes` | warning | serviceVisits |
| `schema_drift` | import file headers changed vs. expected | critical | importBatches |
| `reconciliation_mismatch` | batch loaded totals ≠ source control totals, or vs. FastCash | error | importBatches |

Tolerances (`tol`, thresholds) come from `businessRules`, never hard-coded.

## 12.2 Reconciliation logic

1. **Row/control-total recon (per batch):** source row count and Σ(amount) vs. loaded → `batch.reconciliation`.
   Mismatch → `reconciliation_mismatch`.
2. **Invoice ↔ line-item recon:** `invoices.lineItemsTotal` recomputed on every line change; sets
   `reconciliationStatus` and raises `invoice_total_mismatch`.
3. **Cross-source recon:** RouteStar monthly stop volume / revenue vs. **FastCash** weekly figures (the
   stated ~400–500 stops/mo validation) → variance report + DQ.
4. **Elapsed-time recon:** `sourceElapsedTimeMinutes` vs. `calculatedElapsedTimeMinutes` (never trust the
   displayed elapsed) → `elapsedTimeValidationStatus` + `elapsed_time_variance`.
5. **Mapbox recon:** `mapboxDurationMinutes` vs. `observedGapMinutes` → `nonDrivingGapMinutes`,
   `mapbox_duration_gt_gap`.

## 12.3 Lifecycle & surfacing

- Severity gates: `critical` can fail/partial a batch; `error`/`warning`/`info` don't block load but flag.
- `resolutionStatus` workflow: `open → acknowledged → resolved | ignored`; resolving requires
  `resolvedBy` + `resolutionNotes` (audited).
- A **data-quality dashboard** endpoint (§13) exposes open counts by type/severity, plus the two
  headline lists: **unmapped service items** and **invoices↔visits linkage gaps**.
- Quarantine: records with `critical` DQ get `source.dataQualityStatus='quarantined'` and are excluded
  from analytics until resolved (but never deleted).

Next: [`07-apis.md`](07-apis.md).
