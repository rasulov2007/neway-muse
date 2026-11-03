# Persistence

## The defect this document exists because of

A truck and a driver created through the UI appeared in their lists, and were gone after a refresh.

They had never left the browser. `createTruck` pushed onto `demoData.trucks` — a module-level array
inside the browser bundle — and `createDriver` pushed onto `demoData.drivers`. There was no POST, no
endpoint, and no table. The database had **zero relations**, the API exposed nine routes (health and
eight read-only dashboard endpoints), and `apps/web/src` contained no `fetch` call of any kind.

Nothing was lost, because nothing had ever been saved. It was not a cache bug, a filter bug or a
tenant bug: there was no persistence layer to be wrong.

## What is persistent, and what is not

| Data | Where it lives | Survives a refresh |
| --- | --- | --- |
| **Trucks** | PostgreSQL, `trucks` | Yes |
| **Drivers** | PostgreSQL, `drivers` | Yes |
| **Companies** | PostgreSQL, `companies` | Yes |
| Loads, dispatch, tracking | Generated per session | No |
| Maintenance, work orders, fuel | Generated per session | No |
| Compliance documents and qualification items | Generated per session | No |
| Inspections, accidents, violations | Generated per session | No |
| Invoices, bills, expenses, settlements, payroll, the ledger | Generated per session | No |

The roster is persistent because it is what a user creates and expects to find again. The rest is
still the pinned demo dataset and is regenerated deterministically on every load; those modules move
to the database in their own phases.

## The path a create takes

```
Truck form  →  createTruck()            apps/web/src/demo/fleet-writes.ts
            →  createTruckRecord()      apps/web/src/demo/roster-api.ts
            →  apiPost('/trucks')       apps/web/src/lib/api-client.ts
            →  POST /api/v1/trucks      apps/api/src/modules/roster/roster.controller.ts
            →  TrucksService.create()   validation, duplicate checks, transaction
            →  INSERT INTO trucks       apps/api/src/database/schema/roster.ts
            ←  the stored row, with the id the server assigned
            →  the roster is re-read from the server, not patched locally
```

The driver path is the same through `createDriver` → `createDriverRecord` → `POST /api/v1/drivers`.

Nothing invents an id client-side. A client-generated id that the server later replaces is the
shortest route to a record the UI shows and the database has never heard of.

## The rules that keep it correct

**Company comes from the principal, never from the request.** Every query filters on
`principal.companyId` and every insert stamps it. `CompanyScopeGuard` rejects with 400 any request
carrying `companyId`, `company_id` or `tenant` in the query string. The classic form of this bug —
insert with `companyId` undefined, then select `WHERE companyId = current` — cannot occur, because
the column is `NOT NULL` and the value has one source.

**The API company id and the application company id are the same id.** They were not: the API's
demo principal used `co_demo_northwind` while the application showed `co_northwind`. That mismatch
had no visible effect while nothing was stored, and would have produced exactly the "record exists
but is invisible" failure the moment something was. They are now both `co_northwind`.

**Uniqueness is enforced in the database, not only in the service.** `(company_id, unit_number)`,
`(company_id, upper(vin))` and `(company_id, lower(email))` are unique indexes. A check that lives
only in application code is a check a second caller can skip.

**Nothing is hard-deleted.** A truck is `sold`, a driver is `terminated`. Both keep every load,
work order, fuel fill, settlement and accident that ever referenced them. The list hides them;
`?includeInactive=true` shows them. Terminating a driver releases their unit in the same
transaction, because a terminated driver still holding a truck is how a unit becomes unassignable
with nobody able to say why.

**Archived is not terminated** (owner, 2026-10-02, migration 0039). A driver taken off the roster
without a termination keeps their status and every record; `drivers.archived_at` hides them from
`GET /drivers` (unless `?includeArchived=true`), every picker and both dispatch boards (their board
row is unassigned from the Monday of that week, so past weeks keep them). Drivers > Archived lists
them with Restore (`POST /drivers/:id/restore`, version-checked on the archive time), which brings
the file and the board row back. `apps/api/src/scripts/archive-unassigned-drivers.ts` archived the
UNASSIGNED team; it also restores one driver with `--restore <id> --apply`.

**A failed write is reported as a failure.** The client maps RFC 7807 problem+json to `ApiError`
with the server's own `detail`. Both forms keep the user's input, show the message and allow a
retry; neither shows a success toast or adds a row unless the server returned the record. A network
failure says the server could not be reached and that nothing was saved — it is never rendered as a
validation error, and never as an empty fleet.

**One click is one record.** Both submit buttons pass `loading` while the request is in flight, and
`Button` sets `disabled={disabled || loading}`.

## The roster import

`apps/api/src/database/seed/roster.seed.ts` is generated by
`npx tsx --tsconfig apps/web/tsconfig.app.json apps/api/scripts/export-roster.ts`.

It is the fleet this carrier already ran on, moved into the database **with its ids unchanged** —
`trk_2785` is still `trk_2785` — so every generated load, work order, fuel fill and settlement that
references a unit still resolves. It is a migration of existing records, not an invention of new
ones.

The import runs on boot and is **conditional on the table being empty**. It is never an upsert: a
carrier that has been running for a week has real edits in these rows, and re-applying a seed every
boot would quietly revert them. Empty means "this database has never held the roster"; anything else
means somebody's data is in there and it is not ours to rewrite.

### Demo data is a development convenience

Every seed — roster, workforce, qualification file, hiring funnel — runs behind one switch,
`SEED_DEMO_DATA` (`apps/api/src/config/env.ts`): on outside production, off in it, and settable
either way. A live workspace never refills itself: with the switch off an empty table means
"nothing entered yet", not "put the demo fleet back". The permission registry, the company row and
the onboarding templates are configuration, not demo data, and are synced regardless. The web build
has the matching switch, `VITE_DATASET=empty` (set in `infra/Dockerfile.web`): the browser then
starts every collection at zero instead of generating the Northwind Freight workspace, and the
reporting source answers from the (empty) workspace rather than the generated demo book.

To take a workspace back to zero — the demo removed before real use starts — run
`node apps/api/dist/scripts/reset-workspace.js` on the server (dry run first; `--confirm` to delete;
`--accounts` to also remove the imported demo accounts that never held a credential). It deletes every
operational table, the `app_state` snapshot and the uploaded files in one transaction, and keeps the
company, accounts, roles, permissions, settings, departments and onboarding templates. Take a
`pg_dump` first; nothing it removes comes back.

## Migrations

`apps/api/src/database/migrations/` — generated with `npm run db:generate -w @neway/api`, applied
with `npm run db:migrate -w @neway/api`, and applied automatically on API boot before the server
starts listening. Every migration this project generates is additive. The SQL is copied into `dist`
by the `assets` rule in `nest-cli.json`; without it the migrator would find an empty folder in
production and silently apply nothing.

## Tests

- `apps/web/src/demo/roster-api.test.ts` — a created truck and driver survive
  `invalidateRoster()`, which is what a refresh does to that module. Also asserts the server's id is
  used, that a refused duplicate is reported rather than added, and that a new driver starts
  `off_duty` with nothing verified.
- `apps/web/src/test/roster-server.ts` — stubs the transport only, so unit tests exercise the real
  client, paging and error mapping. An unrecognised route throws instead of resolving empty.
- `apps/web/e2e/smoke.spec.ts` — creates a truck through the actual form in one browser context and
  finds it from a **second context**, which shares no memory, cache or storage with the first. Also
  asserts that an unreachable server is reported rather than shown as an empty fleet.
