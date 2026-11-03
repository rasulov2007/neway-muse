# NEWAY TMS — Development Roadmap

**Status:** Phases 0–2 complete (foundation, architecture, design system + shell). Awaiting approval before Phase 3.
**Companion:** [ARCHITECTURE.md](ARCHITECTURE.md) and the documents in [docs/](docs/).

## Principles

1. One phase at a time. A phase is done when its exit checks pass; the next phase does not start on a broken foundation.
2. Every phase ships a usable vertical slice (schema + API + UI + tests + seed data), not a horizontal layer.
3. Business first: before a feature is built, its owner, purpose, upstream, downstream, failure modes, audit needs, and permissions are written down in the phase's design note (`docs/decisions/`).
4. Every phase adds tests: unit, integration, API, permission-per-role, tenant-isolation, and critical-flow UI tests for what it built.
5. Nothing is faked. A provider not yet connected is a labeled mock.
6. The same eight checks close every phase: tests green; no errors in API, worker, or browser console during a smoke run; UI consistent with the design system gallery; permissions verified per role; database integrity (migrations up/down, constraints, schema lint); responsive at 1280/1024/768; "completed" written; "remaining" written.

## Sizing

**S** one session · **M** 2–3 sessions · **L** 4–6 sessions · **XL** more. One engineer with AI assistance.

---

## Phase 0 — Project Foundation (S) ✅ scaffolded

Independent monorepo: `apps/api` (NestJS + Fastify, pino logging, RFC 7807 errors, env validation, health endpoint, Drizzle wiring without tables), `apps/web` (Vite + React 19 + Tailwind v4, token stub, health page), `packages/shared` (zod schemas), lint/format/typecheck/test scripts, `.env.example`, `infra/docker-compose.yml` for PostgreSQL, `git init`.

Exit: install, typecheck, lint, format check, tests, and builds pass; health endpoint verified; no references to any other project.

## Phase 1 — Architecture (S) ✅ written

ARCHITECTURE.md, DATABASE.md, MULTI_TENANCY.md, RBAC.md, AI_ARCHITECTURE.md, INTEGRATIONS.md, ROADMAP.md; module dependency diagram; risks; assumptions; decisions needed.

Exit: owner approves stack (D1) and isolation model (D2); remaining decisions accepted or answered.

## Phase 2 — Design System (M) ✅ built 2026-09-07

Delivered: 43 design-system components with tests, tokens, status system, app shell (sidebar with nested navigation and collapse, topbar, company selector, command palette, notification center, user menu), TanStack Router with every navigation page, dashboard, example pages (trucks table + drawer, load detail, truck form, AI Command Center), component gallery at `/dev/gallery`, deterministic demo dataset, Playwright smoke suite (50 tests, zero console errors), 149 unit tests. Details in `docs/DESIGN_SYSTEM.md`.

- Tokens: color, type, spacing, radii, shadows, motion, status palette; light theme (dark theme tokens reserved).
- Shell: Sidebar (8 groups, collapsible, permission-driven), Topbar (company switcher, search/command palette, notifications, user menu), PageHeader, content grid, responsive behavior.
- Components: Button, IconButton, Card, KPI Card, DataTable (server-driven contract: sort, filter, page, column chooser, selection, bulk actions, export, virtualization, empty/loading/error), FilterBar, SearchInput, Select/Combobox (async), DatePicker/RangePicker, Tabs, Drawer, Modal, ConfirmDialog, Form primitives (react-hook-form + zod), StatusBadge, Timeline, ActivityFeed, Toast, NotificationCenter (UI), CommandPalette (UI), EmptyState, Skeleton, ErrorState, Chart wrappers (line/bar/area/donut). Deferred to the phase that first needs real data: Map wrapper (MapLibre) → Phase 6 Tracking; DocumentViewer and FileDropzone → Phase 4 Documents.
- TanStack Router with typed file routes and route-level code splitting; role-based landing route.
- Component gallery page at `/dev/gallery` showing every component in every state; used for UI consistency checks in all later phases.

Exit: gallery complete; Testing Library tests for each component's states; accessibility basics (focus, labels, keyboard) on interactive components; responsive check.

## Phase 2b — Executive Dashboard and reporting domain (L) ✅ built 2026-09-07 (out of roadmap order, at the owner's direction)

The dashboard was requested ahead of its roadmap position (analytics normally follow the data modules in Phase 12). It was built as a **reporting domain**, not as a dashboard-shaped application, so the mistake that sank the previous product is not repeated: the calculations live in pure, tested engines behind a data-source interface, and the dashboard is one consumer of them.

- `apps/api/src/modules/reporting/`: `ReportingPeriodService` (the only date logic: presets, comparison periods, reporting weeks, trailing 8 weeks, monthly 4-week dispatch mapping, timezone-safe), engines (`financial-calculator`, `ops-net-calculator`, `truck-pnl-calculator`, `fuel-analytics`, `dispatch-performance`, `data-quality`, `money`) as pure functions over `ReportingFacts`, and `ReportingDataSource` with a deterministic demo implementation. Accounting and dispatch reports will call the same engines; there is no second dispatcher-KPI algorithm.
- `apps/api/src/modules/dashboard/`: eight endpoints, server-side financial masking through a permission seam, a company-scope guard that rejects any client-supplied company id, zod validation, an LRU cache keyed by company and period, and drill-downs whose totals equal the headline numbers.
- `packages/shared/src/dashboard/`: the typed contracts both sides validate against.
- `apps/web/src/features/dashboard/`: period selector plus independent widgets (executive KPI strip, 8-week trend, ops net by driver pay type, P&L per truck, dispatch performance, fuel, fuel by state, attention, data health, AI insights) with loading, empty, and error states per widget.
- Honesty rules enforced end to end: missing expense data renders "—" with a reason rather than 0; estimates are labeled; unknown driver pay types keep their money in a visible bucket; revenue reconciliation is surfaced, not silently trusted.

**Carries into later phases:** the demo data source is replaced by a database source in Phase 3+ with no change to the engines; the demo role header is replaced by real authentication in Phase 3; the "attention" and "AI insights" widgets read the web demo data until Phases 4–8 and 14 deliver their modules, and are labeled as demo in the UI.

## Phase 3 — Multi-Tenant Authentication and Administration (L)

Backend
- Platform: companies, plans, subscriptions, platform users and roles, platform settings, support sessions, platform audit, health.
- IAM: users, memberships, sessions (list/revoke), argon2id, access/refresh rotation, MFA, invitations, password reset, API keys.
- Tenant context, tenant-scoped db handle, RLS policies, schema lint, fail-closed guard.
- Permission registry, roles, membership roles with scopes, route guard, service authorize, field masking, permission version.
- Company: profile, locations, departments, settings, status definitions, sequences.
- Staff: employees, positions, teams, team members, shifts, tasks, activity/presence.
- Audit log with field diffs and summaries; domain event outbox + worker dispatcher; notifications core with in-app channel, email adapter (SMTP) and mock; WebSocket gateway.
- Seed: two demo companies for isolation tests.

Frontend
- Login, MFA, reset, invitation acceptance, company selection/switcher.
- Platform Admin: Companies, Plans, Platform Users, Settings, Health, Audit.
- Administration: Users, Roles & Permissions (matrix editor), Departments, Settings, Audit Logs, Sessions.
- HR → Employees (list, drawer, page skeleton) and Staff (teams, shifts, presence).
- Notification center live; role-based landing.

Exit: isolation matrix (MULTI_TENANCY.md §7) green; role matrix and masking tests green; every route has a permission; audit written for every mutation; events reach the worker and produce a notification end to end.

## Phase 4 — Fleet Foundation (M)

- Documents module: types, polymorphic ownership, versions, storage adapter (local/S3), signed URLs, access log, public upload links, expiration engine with dedupe alerts.
- Parties: vendors (needed by fleet), facilities skeleton; customers and brokers come in Phase 5.
- Fleet: trucks and trailers (separate lists and create flows), assignments history, leases, telematics devices, odometer readings with regression guard.
- Drivers: profiles, statuses, pairs, pay plans skeleton, compliance summary fields; qualification requirements catalog and items; holds; dispatch gates.
- Fleet Dashboard read model.
- UI: Fleet Dashboard; Trucks (list, drawer, page: Overview / Documents / History); Trailers; Drivers (list, page: Overview / Documents); Documents views; CSV importers for trucks, trailers, drivers.
- Seed: realistic fleet (units 2785, 3012, 3091, 3120 …; Cascadia, VNL, T680, 579, Anthem), 240 drivers, documents with expirations.

Exit: gate computation tests; expiration alerts dedupe across reruns; uploads validated; importer dry-run and rollback; per-role checks.

## Phase 5 — Dispatch (XL)

- Customers, brokers, facilities (complete), contacts.
- Loads, stops (multi-stop), charges (typed lines), expenses, assignments (driver/co-driver/truck/trailer/dispatcher) with gate checks, status state machine with exception overlay, status history, timeline events, notes, trips, detention entries, TONU, cancel.
- Dispatch board (driver × day cells, human-typed), board snapshots.
- Documents on loads: rate confirmation, BOL, POD; closed gate.
- Global search index.
- UI: Dispatch (board and at-risk view), Loads (server-driven table, saved filters), Load page (Overview / Tracking placeholder / Documents / Financial / Timeline / Notes), New Load, assignment drawer with gate warnings, Customers, Brokers, Facilities, Trips.
- Seed: 90 days of loads across statuses.

Exit: state machine tests; closed gate tests; scope tests (team-scoped dispatcher); timeline completeness for the sample flow; search finds loads by number, reference, driver, unit.

## Phase 6 — Tracking (L)

- Integration adapter contracts (all categories) + `integration_accounts`, `sync_runs`, `webhook_events`, `external_refs`; Administration → Integrations (connect, test, status).
- Telematics: Mock provider with simulated movement; first real provider adapter (chosen by the owner) with contract tests.
- Positions (partitioned), live state, geofences (facilities), tracking events, ETA (routing adapter + road factors, proportional recomputation, route cache), tracking alerts with dedupe (late ETA, deviation, idle, speeding, long stop, unexpected stop, missed appointment, GPS/vehicle offline), HOS ingestion.
- Maps adapter (OSRM/ORS + MapLibre tiles), weather adapter.
- UI: Tracking (live fleet map with clustering, load tracking map, driver tracking), Load page Tracking tab, Truck page Tracking tab, public tracking share link.

Exit: mock telematics drives a seeded load through pickup and delivery geofences producing the expected events and alerts; ETA within tolerance on fixtures; sync failures visible in Integrations.

## Phase 7 — Maintenance (M)

- Maintenance types, PM schedules with next-due from odometer velocity, repair orders + lines + activity, service records, parts and stock, tires and readings, inspections, defects (telematics faults, MPG-drop suggestions, driver reports), vendors/shops, warranty, downtime, cost per mile per asset. Events to accounting on RO completion.
- UI: Maintenance dashboard, PM due/overdue/scheduled, Repair Orders, Service History, Parts, Tires, Inspections; Truck page Maintenance tab.

Exit: next-due math tests; RO completion creates service record, bill, expense exactly once; fleet vs maintenance manager permission checks.

## Phase 8 — Safety & Compliance (L)

- Safety events (telematics sync), violations (CSA categories), accidents, claims, drug & alcohol, training, meetings, safety scores (company/driver/truck) with configurable weights, driver qualification workflow (requirements, items, verification, holds), compliance dashboard, automatic alerts.
- UI: Safety dashboard, Driver Safety, Violations, Accidents, Inspections, Compliance (expiring/missing by scope), Driver page Safety tab.

Pulled forward (2026-09-08, owner's safety programme Phase 1, see docs/SAFETY.md): the compliance
expiration engine and requirement catalog (`packages/shared/src/compliance`), Safety Command Center
(`/safety`), Compliance workbench (`/safety/compliance`), consent centre, driver verification
pipeline and the compliance audit trail — over the demo data layer, ahead of the database. Still
in this phase: telematics safety-event sync, violations, accidents, claims, scores, training,
meetings, and the database-backed compliance module.

Exit: score snapshots reproducible; safety specialist cannot release holds; PII masked outside safety/HR; alert dedupe.

## Phase 9 — Fuel (M)

- Fuel cards, stations, transactions (mock provider + CSV import; real provider in Phase 15), load allocation, daily stats (MPG, CPM, idle), anomaly detectors (location mismatch vs positions, impossible gallons, duplicates, excess consumption, MPG drop, card misuse), IFTA quarter report.
- UI: Fuel dashboard, Transactions, Anomalies, Efficiency by truck/driver/route, IFTA; Truck and Driver pages Fuel tabs.

Exit: detector fixtures; import idempotency; MPG matches hand calculation on seed.

## Phase 10 — Accounting (XL)

- Charge types, expense categories, invoices from typed charge lines, credit memos and revisions, factoring batches, AR aging, payments and applications, AP bills, expenses, fixed-cost allocation, ledger periods with close, load/driver/truck/customer/broker/route/dispatcher profitability read models.
- Settlements: driver settlements from pay plans, lines, deduction plans, escrow, statements (PDF), finalize/pay/reverse.
- Payroll (staff): periods, payslips, compensation adjustments, company-defined pay rules (versioned), finalize/pay/reverse.
- UI: Accounting dashboard, Invoices, AR, AP, Expenses, Payments, Settlements, Payroll, Profitability; Load page Financial tab complete; Driver page Payroll tab.

Exit: closed period rejects postings; invoice/credit memo flow; settlement never pays a load twice; role checks (accountant cannot finalize); reconciliation test: sum of load revenue = sum of invoice lines for closed loads.

## Phase 11 — HR & Staff (M)

- Recruiting pipeline with public application form, onboarding/offboarding checklists (creates user + membership + employee/driver), PTO policies/balances/requests, attendance (manual + device adapter), training, performance reviews and events, employee documents, staff activity and productivity views (who is working, assigned/completed/pending work, response times).
- UI: HR dashboard, Employees (complete), Recruiting, Onboarding, Attendance, PTO, Performance, Staff activity.

Exit: hire flow creates correct records and roles; PTO accrual tests; HR specialist cannot edit compensation.

## Phase 12 — Reporting & Analytics (M)

- Report definitions (dataset, filters, columns, grouping), saved and scheduled reports, exports CSV/XLSX/PDF (streamed), analytics read models per department, company and department KPIs, Executive Dashboard (all KPIs, alerts, at-risk loads, upcoming events, staff activity).
- UI: Reports (library + builder), Analytics, Dashboard.

Exit: exports equal on-screen totals; 100k-row export streams; read-only role sees no money.

## Phase 13 — Workflow Engine (M)

- Rules (trigger, conditions, actions), action registry, runs and steps, approvals, escalation timers, templates (maintenance threshold, late load, CDL expiring, invoice aging), admin editor.
- UI: Administration → Workflows; approval queue in notifications.

Exit: template rules fire on seeded events; failed steps visible and retryable; automation principal cannot exceed its ceiling.

## Phase 14 — AI (L)

- LLM adapter (Anthropic + mock), usage metering and caps, detectors and insights, assistant with tools, recommendations, action policies and approvals, Command Center, Action Center, AI reports, correlation pass, evaluation set. See AI_ARCHITECTURE.md §8 for sub-steps.

Exit: consequential actions require approval and cannot be lowered; eval set passes; cap stops calls; mock provider runs everything without a key.

## Phase 15 — Integrations (L)

- Remaining providers: additional telematics (Motive/Geotab/Samsara as chosen), fuel cards, load boards, QuickBooks, Stripe, Twilio, Telegram, paid maps; connect flows, contract tests, budgets, webhook handlers.

Exit: each adapter passes contract tests; status honest; failures alert.

## Phase 16 — Production Hardening (M)

- Security review (RBAC matrix, isolation matrix, uploads, headers, rate limits, dependency audit), performance (seeded 500 trucks / 100k loads / 20M positions; k6 against budgets; index review), monitoring and alerting, backups and restore drill, accessibility pass, responsive pass, error handling and empty/loading states audit, deployment runbook.

Exit: budgets met; restore drill succeeds; runbook complete.

---

## Recommended implementation order (why this sequence)

Foundation (0–3) makes every later module tenant-safe and auditable by default. Fleet (4) and Dispatch (5) establish the assets and the spine. Tracking (6) makes dispatch live. Maintenance (7), Safety (8), and Fuel (9) attach cost and risk to the assets. Accounting (10) turns the spine into money. HR (11) completes the people side. Reporting (12) needs all of the above. Workflows (13) and AI (14) act on reliable data and events. Integrations (15) widen the data sources once the consuming modules exist. Hardening (16) measures the whole.
