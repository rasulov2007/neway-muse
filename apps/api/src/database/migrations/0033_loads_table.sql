-- Loads leave the workspace snapshot and become a table.
--
-- One row per load. The columns are what the server enforces, filters and joins on; `record` is
-- the whole load document as the application reads it — stops, documents, notes, timeline and
-- every other field — so nothing the snapshot held is dropped and a field-by-field comparison
-- against the snapshot can be exact. The snapshot row `ws2-loads` is left untouched as the
-- backup until the owner confirms the cutover.
--
-- Additive: nothing existing is altered. `0033_loads_table.down.sql` removes it.
CREATE TABLE IF NOT EXISTS "loads" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "load_number" text NOT NULL,
  "status" text NOT NULL,
  "dispatcher_id" text NOT NULL DEFAULT '',
  -- The second owner of a rolling load (business rule 1.7). Null until somebody is named.
  "updater_id" text,
  "driver_id" text,
  "truck_id" text,
  "trailer_id" text,
  -- Seeded or generated rather than booked: hidden from every screen and count by default.
  "is_demo" boolean NOT NULL DEFAULT false,
  -- Every write checks and increments this, so two people editing one load cannot overwrite
  -- each other without one of them being told.
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "loads_company_number_key" ON "loads" ("company_id", "load_number");
CREATE INDEX IF NOT EXISTS "loads_company_status_idx" ON "loads" ("company_id", "status");
CREATE INDEX IF NOT EXISTS "loads_company_driver_idx" ON "loads" ("company_id", "driver_id");
CREATE INDEX IF NOT EXISTS "loads_company_truck_idx" ON "loads" ("company_id", "truck_id");
CREATE INDEX IF NOT EXISTS "loads_company_updated_idx" ON "loads" ("company_id", "updated_at");
