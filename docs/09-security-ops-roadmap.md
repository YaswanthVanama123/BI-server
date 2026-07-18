# 17–20. Security & PII · Backup/Retention/DR · Implementation Phases · Risks

## 17. Security & PII considerations

### 17.1 Data classification
- **PII:** `customerContacts.phone/email`, contact names, service addresses (`customerLocations`),
  employee names/IDs (`employees`, `payrollEntries`).
- **Financial-sensitive:** wages/rates (`employeeRateHistory`, `payrollEntries`, `laborCostRates`),
  profitability/cost collections.
- **Operational:** visits, invoices, routes, categories (least sensitive, still tenant-isolated).

### 17.2 Controls
- **Tenant isolation:** `tenantId` on every document + enforced in every query at the data-access layer
  (never trust a client-supplied tenant). Consider a DB user per tenant tier or a middleware guard that
  injects `tenantId` into all filters.
- **RBAC scopes:** `ops`, `finance`, `admin`, `pii_read`. Cost/payroll/profitability endpoints require
  `finance`; contact PII requires `pii_read`. Enforced in API middleware, not the UI.
- **Field-level encryption:** MongoDB Client-Side Field-Level Encryption (CSFLE) or Queryable Encryption
  for `phone`, `email`; keys in a KMS (AWS KMS / GCP KMS). Encryption at rest (WiredTiger) + TLS in transit.
- **Least privilege for ETL:** the import service writes to raw + curated; the BI API is **read-only** on
  analytics collections (separate DB roles). Config writes (`businessRules`, `itemCategoryMappings`) are
  a distinct privileged role, fully audited.
- **Audit:** all config changes and DQ resolutions → `auditLog` (who/what/before/after/when).
- **Secrets:** Mapbox token, ADP/RouteStar credentials in a secret manager; Mapbox token scoped to the
  minimum APIs; server-side only (never shipped to the BI frontend).
- **PII minimization:** the analytics/materialized layer stores no raw PII beyond IDs; contact details
  are fetched on demand from `customerContacts` behind `pii_read`.

## 18. Backup, retention, and disaster recovery

- **Backups:** managed continuous backups with point-in-time recovery (Atlas PITR or `mongodump` +
  oplog). RPO target ≤ 1 h (daily-load system tolerates this comfortably); RTO ≤ 4 h.
- **Raw layer as replay source:** because curated/derived collections are fully rebuildable from `raw_*`
  + config, a corruption event can be repaired by truncating derived collections and re-running ETL +
  materialization — the raw layer is the durable system of record for source data. Back it up with the
  longest retention.
- **Retention:**
  - `raw_*`: retain ≥ 7 years (financial source traceability); archive cold data (older than 2 y) to
    cheaper storage / compressed collections.
  - Source-of-truth + history: retain indefinitely (history is the product).
  - Derived/materialized: no independent retention — rebuildable; keep trailing rebuild window online.
  - `auditLog`, `dataQualityIssues`: ≥ 7 years.
  - `mapboxRouteCache`: traffic entries TTL ~30 d; plain `driving` entries kept (cheap, reused).
- **DR:** multi-AZ replica set (primary + 2 secondaries) minimum; cross-region secondary or scheduled
  cross-region snapshot copy for regional failure. Test restores quarterly (restore drill → validate
  reconciliation totals match a known batch).
- **Schema/versioning:** migrations are versioned and reversible; a `schemaVersion` on config-bearing
  docs where shape may evolve.

## 19. Implementation phases

**Phase 0 — Foundations (week 1–2):** tenants, businessRules seed, serviceCategories,
frequencyDefinitions, routes; connection/model layer; import-batch + raw-layer scaffolding;
CI + backups. *Gate:* Naitik's CSV field list confirmed (source column contract).

**Phase 1 — Customers, locations, geocoding (week 2–4):** customers/locations/contacts/status &
schedule history; Mapbox geocoding of missing/invalid coords; account-number & customer-ID uniqueness
+ DQ. *Deliverable:* clean, geocoded customer master keyed on RouteStar IDs.

**Phase 2 — Invoices, line items, service visits (week 4–7):** invoices + line items + service visits;
item→category mapping engine + unmapped review; elapsed-time validation; invoice↔line reconciliation.
*Deliverable:* **first BI report** (technician check-in/out per stop) + revenue-by-category.
*Gate:* Jeff's line-item/service-coding cleanup (data reliability).

**Phase 3 — Route legs & Mapbox drive time (week 6–8, overlaps P2):** route-leg calculator + cache;
service-vs-drive-time and non-driving-gap analytics; stops-per-tech vs. benchmark.

**Phase 4 — Payroll & cost (week 7–10):** employees + source mappings; ADP payroll periods/entries;
availability & utilization; labor cost + burden; supply cost (EnviroMaster). *Gate:* burden %
confirmation. Vehicle-cost basis remains a stub until business defines it (Hanitha/Alex).

**Phase 5 — Materialization & BI API (week 9–12):** the four monthly summaries + daily technician
metrics via `$merge`; full REST API with filters; freshness/DQ envelope; FastCash reconciliation.

**Phase 6 — Hardening & near-real-time readiness (week 12+):** CSFLE for PII; RBAC finalization; DR
drill; optional change-stream/CDC path to shrink daily → near-real-time (no schema change).

## 20. Risks, assumptions, and unresolved questions

### Assumptions
- RouteStar exposes the enumerated fields via CSV export (or API); a stable per-entity source ID exists
  (invoice #, customer ID, account #). If only names are available for some entity, a mapping/resolution
  step + DQ is required before it can be a join key.
- One service visit maps to one closed invoice in the common case; multi-visit invoices exist and are
  handled by the documented allocation rule.
- Reporting timezone is a single IANA zone per tenant (America/New_York for NRV).

### Open questions requiring business confirmation
1. **Vehicle-cost allocation basis** (per_tech | per_route | fixed_pool) — *"not yet defined,"* needs
   Hanitha/Alex. Modeled but stubbed in `vehicleCosts`/`costAllocationRules`.
2. **Burden multiplier** for fully-burdened labor rate — needs finance sign-off (`laborCostRates`).
3. **Revenue allocation** for invoices covering multiple visits / recurring periods — default is
   proportional-by-line; confirm with finance.
4. **Salaried available-hours** default per period (`businessRules.salariedDefaultAvailableHours`).
5. **Void/credit revenue treatment** — confirm `excludeStatusesFromRevenue` list.
6. **Elapsed-time source reliability** — variance tolerance and whether source elapsed is ever
   authoritative (default: calculated wins).
7. **`ZZZ` churn convention** — confirm exact string patterns → status mapping.
8. **Line-item/service coding cleanup timeline** (Jeff) — gates cost-per-stop and capacity-map
   reliability; until done, expect a larger `UNMAPPED` bucket.
9. **CSV field list & delivery mechanism** (Naitik) — final source column contract.
10. **QuickBooks corporate-fee reconciliation** — explicitly out of scope now; `quickBooksCustomerId`
    reserved for later P&L join.

### Risks & mitigations
| Risk | Mitigation |
|---|---|
| Source lacks reliable "last modified" | recordHash-based change detection + look-back overlap |
| Name-based matching creeps in | Enforce RouteStar-ID join keys; DQ on unresolved refs; no name unique keys |
| Mapbox cost/rate limits | Matrix API batching + aggressive `mapboxRouteCache`; skip legs on guard conditions |
| Float money errors | Decimal128 everywhere; lint/tests forbid `Number` on money fields |
| Unmapped items silently drop revenue | UNMAPPED category is a real, reported bucket + DQ + review workflow |
| Partial-refresh drift in summaries | nightly trailing-N-month full `$merge` self-heal |
| Multi-visit invoice mis-attribution | documented allocation rule + attribution method/confidence stored |
| PII exposure | CSFLE, RBAC scopes, read-only analytics layer with no raw PII |

---

**End of design.** Companion code: [`../src/models/`](../src/models) (Mongoose models) and
[`../src/etl/`](../src/etl) (import runner, importers, Mapbox service, DQ, analytics `$merge` jobs).
