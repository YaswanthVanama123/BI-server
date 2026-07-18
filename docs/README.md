# EnviroMaster Operational & Financial BI — Database Architecture

Production-ready MongoDB architecture and data-processing pipeline for an operational
and financial BI platform. The primary operational source is **RouteStar**, payroll comes
from **ADP**, supply cost from the **EnviroMaster Store / inventory system**, and
route-distance/travel-time is computed with **Mapbox**. **FastCash** and **QuickBooks**
are reconciliation sources (QuickBooks corporate-fee reconciliation is explicitly out of scope).

## How this doc set maps to the requested 20-section deliverable

| Requested section | File |
|---|---|
| 1. Architecture overview | [`01-overview-mapping-collections.md`](01-overview-mapping-collections.md) |
| 2. Source-to-target data mapping | [`01-overview-mapping-collections.md`](01-overview-mapping-collections.md) |
| 3. Complete collection list | [`01-overview-mapping-collections.md`](01-overview-mapping-collections.md) |
| 4. Detailed schema for every collection | [`02-schemas.md`](02-schemas.md) |
| 5. Mongoose model examples | [`../src/models/`](../src/models) + [`02-schemas.md`](02-schemas.md) |
| 6. Relationship diagram (Mermaid) | [`03-relationships-indexes.md`](03-relationships-indexes.md) |
| 7. Indexing strategy | [`03-relationships-indexes.md`](03-relationships-indexes.md) |
| 8. ETL & synchronization workflow | [`04-etl-mapbox.md`](04-etl-mapbox.md) + [`../src/etl/`](../src/etl) |
| 9. Mapbox integration design | [`04-etl-mapbox.md`](04-etl-mapbox.md) |
| 10. Aggregation pipelines per BI metric | [`05-aggregations-materialization.md`](05-aggregations-materialization.md) |
| 11. Materialized-view / summary strategy | [`05-aggregations-materialization.md`](05-aggregations-materialization.md) |
| 12. Data-quality framework | [`06-data-quality.md`](06-data-quality.md) |
| 13. API endpoint design | [`07-apis.md`](07-apis.md) |
| 14. Example raw records | [`08-examples.md`](08-examples.md) |
| 15. Example curated records | [`08-examples.md`](08-examples.md) |
| 16. Example analytics results | [`08-examples.md`](08-examples.md) |
| 17. Security & PII | [`09-security-ops-roadmap.md`](09-security-ops-roadmap.md) |
| 18. Backup / retention / DR | [`09-security-ops-roadmap.md`](09-security-ops-roadmap.md) |
| 19. Implementation phases | [`09-security-ops-roadmap.md`](09-security-ops-roadmap.md) |
| 20. Risks / assumptions / open questions | [`09-security-ops-roadmap.md`](09-security-ops-roadmap.md) |

## Layer model (two layers, as required)

- **A. Raw/source layer** — `raw_*` collections. Imported RouteStar / ADP / FastCash records
  stored close to original format for traceability and reprocessing. Never joined by the BI API.
- **B. Curated analytics layer** — source-of-truth business collections + derived/materialized
  analytics collections. This is what the BI API reads.

## Non-negotiable conventions (applied to every collection)

1. **Money** is stored as `Decimal128` (never JS floats). Helpers in [`../src/utils/util.js`](../src/utils/util.js).
2. **Time** is stored in UTC (`Date`) with the original wall-clock string and IANA `timezone` retained.
   Reporting timezone is configurable in `businessRules`.
3. Every imported document carries a **`source` sub-document** (§ conventions in `02-schemas.md`).
4. **Stable RouteStar IDs** (`routeStarCustomerId`, `routeStarAccountNumber`, invoice #, etc.) are the
   join keys — **never** the display customer name.
5. All imports are **idempotent upserts** keyed on `(tenantId, sourceSystem, sourceRecordId)`.
6. **History is preserved** via effective-dated history collections; source-of-truth rows are never
   silently overwritten when a business value changes.
7. Everything is **tenant-scoped** (`tenantId`) so the platform is multi-company / franchise-ready.

See [`01-overview-mapping-collections.md`](01-overview-mapping-collections.md) to start.
