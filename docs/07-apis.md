# 13. BI API Endpoint Design

REST, versioned under `/api/v1`. All endpoints are tenant-scoped (tenant from auth context, never a
query param the client can forge). All analytics endpoints accept the **common filter set** and return a
consistent envelope.

## 13.1 Common filters (query params)

`startDate`, `endDate` (ISO, required for time-series), `routeId` / `routeCode`, `technicianId`,
`department`, `customerId` / `routeStarAccountNumber`, `serviceCategoryId` / `categoryCode`,
`customerStatus`, `invoiceStatus`, `frequency`, `granularity` (`day|week|month|quarter|year`),
`includeNonRevenue` (bool, default false), `page`, `pageSize`, `sort`.

Server resolves period keys (`dateKey`/`isoWeek`/`monthKey`) from `startDate`/`endDate` in the tenant's
reporting timezone (from `businessRules`), so clients never deal with tz math.

## 13.2 Response envelope

```json
{
  "data": [ /* rows */ ],
  "meta": {
    "granularity": "month",
    "filters": { "...": "echoed" },
    "generatedAt": "2026-07-17T12:00:00Z",
    "source": "materialized|live",
    "freshness": { "lastBatchAt": "2026-07-17T06:00:00Z", "stalenessMinutes": 360 },
    "dataQuality": { "openCriticalIssues": 0, "affectedRows": 3 }
  },
  "page": { "page": 1, "pageSize": 100, "total": 245 }
}
```
`meta.source` tells the UI whether it hit a materialized summary or a live pipeline; `meta.dataQuality`
lets the UI badge numbers that include quarantined/unmapped data.

## 13.3 Endpoints

### Operational / capacity
| Method + path | Backing | Notes |
|---|---|---|
| `GET /technicians/utilization` | dailyTechnicianMetrics (10.1) | numerator/denominator + utilization%; `source=materialized` |
| `GET /technicians/stops` | serviceVisits/dailyTechnicianMetrics (10.2) | per day/week/month, avg/working-day, vs. benchmark |
| `GET /stops/volume-trends` | monthly* (10.4) | total + by status; MoM/YoY |
| `GET /stops/monthly-by-route` | monthlyRouteMetrics | stop counts by route/month |
| `GET /technicians/{id}/checkins` | serviceVisits | **first BI report** — check-in/out per stop with service vs. drive split |
| `GET /route-legs` | routeLegs (10.3) | service time vs. drive time, non-driving gap, per tech/day; Mapbox leg detail |

### Revenue
| Method + path | Backing |
|---|---|
| `GET /revenue/by-category` | invoiceLineItems / monthlyCategoryMetrics (10.5) |
| `GET /revenue/by-route` | invoiceLineItems / monthlyRouteMetrics (10.6) |
| `GET /revenue/by-customer` | invoiceLineItems / monthlyCustomerMetrics |
| `GET /revenue/per-stop` | invoiceLineItems ⋈ serviceVisits (10.7) |
| `GET /customers/{id}/revenue` | monthlyCustomerMetrics + live drill |

### Cost & profitability
| Method + path | Backing |
|---|---|
| `GET /payroll/cost` | payrollEntries + laborCostRates |
| `GET /cost/labor-per-stop` | 10.8 |
| `GET /routes/{id}/profitability` | monthlyRouteMetrics (revenue − allocated cost) |
| `GET /customers/{id}/profitability` | monthlyCustomerMetrics |

### Reference / drill-down
| Method + path | Backing |
|---|---|
| `GET /customers` / `GET /customers/{id}` | customers (+ locations, current schedule, status) |
| `GET /customers/{id}/pricing` | customerPricingItems (current + history via `?asOf=`) |
| `GET /invoices` / `GET /invoices/{id}` | invoices + invoiceLineItems |
| `GET /routes` / `GET /employees` | routes / employees |

### Governance
| Method + path | Backing |
|---|---|
| `GET /data-quality/issues` | dataQualityIssues (filter by type/severity/status) |
| `PATCH /data-quality/issues/{id}` | resolve/ignore (audited) |
| `GET /service-items/unmapped` | invoiceLineItems where category=UNMAPPED + pending mappings |
| `POST /item-category-mappings` | create/approve a mapping (no code change) |
| `GET /import-batches` / `GET /import-batches/{id}` | batch status + reconciliation |
| `GET /sync/status` | sourceSyncStates watermarks/health |

## 13.4 Cross-cutting API rules

- **Read-only analytics** endpoints hit materialized summaries first; fall back to live pipelines for
  custom ranges/dimensions not materialized (envelope reports which).
- **Pagination + max page size** enforced; large exports go through an async `POST /exports` job.
- **RBAC**: financial endpoints (cost, payroll, profitability) gated by a `finance` role; operational
  endpoints by `ops`. PII contact fields require an explicit scope (§17).
- **Caching**: `ETag`/`Last-Modified` from `meta.freshness.lastBatchAt`; summaries change only after a batch.
- **Idempotent config writes** (`item-category-mappings`, `businessRules`) are audited to `auditLog`.

Next: [`08-examples.md`](08-examples.md).
