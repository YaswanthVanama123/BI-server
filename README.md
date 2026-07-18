# EnviroMaster BI — Backend

MongoDB data platform + ETL + RouteStar automation for the operational/financial BI system. Primary
operational source is **RouteStar**; payroll is **ADP**; supply cost is the **EnviroMaster Store**; route
distance/travel-time is **Mapbox**. **FastCash** and **QuickBooks** are reconciliation sources
(QuickBooks corporate-fee reconciliation is out of scope). Design docs live in [`docs/`](docs).

## Architecture

Layered `src/` with one responsibility per layer; each layer only depends on the layers below it.

```
src/
├── index.js              barrel — env, db, models, etl, services, automation
├── config/
│   ├── env.js            single source of env/config (dotenv)
│   └── database.js       connectDatabase / disconnectDatabase (Mongoose)
├── utils/
│   ├── util.js           money (Decimal128), hashing, tz-aware dates, period keys
│   └── logger.js         leveled namespaced logger
├── models/               Mongoose schemas (source-of-truth + derived) → { models, syncIndexes }
├── automation/
│   └── routestar/        Playwright extraction, split into layers:
│       ├── config.js · errors.js
│       ├── selectors/               ONE file per screen + index barrel:
│       │     login · grid · closedInvoices · invoiceDetail · pagination
│       ├── BrowserSession.js         browser lifecycle · login · Handsontable grid · pagination
│       ├── RouteStarNavigator.js     screen navigation (closed invoices, customers, detail…)
│       ├── parsers/                  row → normalized raw payload
│       ├── fetchers/                 orchestrate navigate → extract → paginate per screen
│       ├── RouteStarService.js       open() → login → fetch* → close()
│       └── index.js
├── etl/
│   ├── importBatchRunner.js          idempotent batch runner (raw → curated + reconciliation)
│   ├── importers/                    per-source handlers (RouteStar closed invoices) + resolvers/
│   └── index.js
├── services/             business logic
│   ├── mapbox/           MapboxService (cache-aware) + RouteLegCalculator
│   ├── analytics/        aggregation pipelines + materialized-summary builders
│   └── dataQuality/      DQ / reconciliation sweep
├── api/                  READ-SIDE BI API (Express) — serves docs/07-apis.md
│   ├── app.js            express app (cors, json, /health, mounts /api/v1, error handler)
│   ├── lib/              envelope { data, meta, page } + filter parsing (date range → monthKeys)
│   ├── middleware/       requestLogger · tenant (x-tenant-code) · requireDb (503) · asyncHandler · errorHandler
│   ├── controllers/      operations · revenue · cost · reference · governance (read materialized + source)
│   └── routes/           one router per domain + index (mounts under /api/v1)
└── server.js             bootstrap: listen(PORT) + background DB connect + graceful shutdown

scripts/                  thin CLI entrypoints (see npm scripts)
docs/                     full architecture + BI API contract (start at docs/README.md)
```

**Dependency direction:** `config` → `utils` → (`models`) → `services`/`etl`/`automation` → `api` → `scripts`/`server`.
`automation` is self-contained (Playwright only, plus `config`/`utils`); it produces raw rows that `etl`
imports — the two are decoupled.

## Core principles

1. **Two data layers** — raw (`raw_*`, verbatim) + curated (source-of-truth + derived); derived is always rebuildable.
2. **Stable RouteStar IDs are the join keys** (`routeStarCustomerId`, account #, invoice #) — never the display name.
3. **Money is `Decimal128`**; time is UTC + retained wall-clock + IANA tz (configurable per tenant).
4. **History preserved** for pricing, frequency, route/tech assignment, status, wage, address, rate, category.
5. **Idempotent upserts** on natural keys + `recordHash` change detection.
6. **Assumptions are config, not code** — `businessRules`, `costAllocationRules`, `itemCategoryMappings`.
7. **Tenant-scoped everywhere** (`tenantId`).

## Usage

```bash
npm install
cp .env.example .env                # Mongo URI, RouteStar creds, Mapbox token, PORT/CORS
npm run dev                          # start the BI API (nodemon)  → http://localhost:4000
npm start                            # start the BI API (production)
npm run check                       # syntax-check src + scripts
npm run sync-indexes                # connect + build MongoDB indexes
npm run playwright:install          # Chromium for RouteStar extraction
npm run rs:login                    # RouteStar login smoke test
npm run rs:closed-invoices -- --pages=5 --out=closed.json
```

## Data pipeline — inventory_db → bi_* (read-only on the app)

Reuses the RouteStar data the inventory app already synced (`inventory_db.routestar*`), writing everything
under the `bi_` prefix in the same database. **The inventory app's collections are never written, indexed,
or altered** (source access is `find`/`count` only). Run in order (each step is idempotent):

```bash
npm run source:inspect     # list inventory_db collections + counts
npm run seed               # tenant + service categories (incl. UNMAPPED) + frequencies + business rules
npm run import:customers   # routestarcustomers      → bi_customers, bi_customerlocations
npm run import:routes      # routestarcustomerroutes  → bi_routes, bi_customerserviceschedules (+ customer.defaultRoute)
npm run import:items       # routestaritems           → bi_serviceitems (+ auto bi_itemcategorymappings)
npm run import:pricing     # routestarcustomerpricings→ bi_customerpricingagreements, bi_customerpricingitems
npm run import:invoices    # routestarinvoices(closed)→ bi_servicevisits, bi_invoices, bi_invoicelineitems
npm run compute:legs       # Mapbox drive time between consecutive stops → bi_routelegs (needs MAPBOX_TOKEN)
npm run materialize        # → bi_monthly*metrics + bi_dailytechnicianmetrics (powers the dashboards)
```
Order matters: routes + items run **before** invoices so invoices attribute to real routes (via the
customer's default route) and line items resolve to real categories (via the auto-generated item→category
mappings). Re-running `import:invoices` + `materialize` after routes/items is safe and picks up both.

## Payroll (CSV upload)

Payroll hours come from a CSV (ADP export) — there is no payroll data in `inventory_db`. Two ways to load,
both idempotent and both writing only to `bi_employees` / `bi_payrollperiods` / `bi_payrollentries` /
`bi_employeeavailability`:

- **Upload (auto-store):** `POST /api/v1/payroll/upload` (multipart field `file`) — parses the CSV and
  imports immediately, then folds availability into technician utilization. The frontend Payroll Cost page
  has an **Upload payroll CSV** button that calls this.
- **CLI:** `npm run import:payroll -- --file=payroll.csv`.

Headers are matched case/spacing-insensitively with aliases (see `samples/payroll-template.csv`): Employee
Name, Employee ID, Department, Applied Rate, Regular/Overtime/Vacation/Sick Hours, Salary/Bonus/Commission
Amount, Misc Reimbursement, Payroll Period Start/End, Check Date. Employees are linked to the technician
shells created from invoice `assignedTo` names (by normalized name, incl. "Last, First" ↔ "First Last").
Run `npm run materialize` after a payroll import so utilization % reflects the new hours.

**Still pending a source:** none for payroll now — supply/vehicle cost remain (EnviroMaster store / TBD).

## BI API server

`npm run dev` starts the Express API on `PORT` (default **4000**), CORS-enabled for the frontend
(`http://localhost:5174`). It **always starts** — even without MongoDB — so `/health` is reachable
immediately; data endpoints under `/api/v1` return **503** until `MONGODB_URI` is connected.

- `GET /health` — liveness + DB status.
- `GET /api/v1` — endpoint index.
- 24 endpoints under `/api/v1` implementing `docs/07-apis.md` (operations, revenue, cost, reference,
  governance), read from the materialized summaries + source collections, returning `{ data, meta, page }`.
- Tenant via `x-tenant-code` header (or `?tenantCode=`), default `DEFAULT_TENANT_CODE` (`EM-NRV`).

Point the frontend at it: set `VITE_USE_MOCKS=false` and `VITE_API_BASE_URL=http://localhost:4000/api/v1`.
Endpoints return real data once the DB is seeded and the materialized summaries have been built
(`services/analytics` refreshers); on a fresh DB they return empty arrays (valid envelopes).

Programmatic entry:

```js
const bi = require('./src');
await bi.connectDatabase();
const svc = new bi.RouteStarService();
const rows = await svc.fetchClosedInvoices({ maxPages: Infinity });   // opens+logs in on first call
await svc.close();
const tenant = await bi.models.Tenant.findOne({ tenantCode: 'EM-NRV' });
await bi.etl.runImport({ tenant, handler: bi.etl.importers.routestarClosedInvoices, rows,
  fileMeta: { fileName: 'routestar-closed-invoices', headers: Object.keys(rows[0] || {}) } });
```

## Status

- **Design (docs):** complete (20 sections — architecture, 40 schemas, indexing, ETL/sync, Mapbox,
  aggregation pipelines, materialization, data quality, API contract, examples, security, DR, roadmap).
- **Models / ETL / services:** implemented and verified (`npm run check`, barrel load test).
- **Automation:** layered RouteStar client (session/navigator/parser/fetcher/service) with the
  closed-invoices fetcher; more fetchers (customers, invoice detail, pricing, routes) follow the same shape.
- **BI API:** Express server with all 24 documented endpoints wired to controllers/services; app builds
  and all routes mount (verified). Returns data once the DB is seeded + summaries materialized.

## Open items needing business confirmation (see `docs/09-security-ops-roadmap.md §20`)

Vehicle-cost allocation basis · labor burden multiplier · multi-visit revenue allocation · salaried
available-hours default · void/credit revenue treatment · `ZZZ` churn string patterns · line-item coding
cleanup timeline · final CSV field contract.
