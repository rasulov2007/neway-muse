-- A flag on a load (business rule 1.10): somebody saying "this one needs a person".
--
-- One row per flag. It stays open - and the load stays in front of everybody on the Loads
-- list, the Daily Board and Notifications - until somebody closes it with a note saying what
-- was done. Closed flags are kept; nothing here is ever deleted.
--
-- Additive: nothing existing is altered. `0034_load_problems.down.sql` removes it.
CREATE TABLE IF NOT EXISTS "load_problems" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "load_id" text NOT NULL REFERENCES "loads"("id") ON DELETE RESTRICT,
  "load_number" text NOT NULL,
  "kind" text NOT NULL,
  "note" text NOT NULL,
  "opened_by_id" text NOT NULL,
  "opened_by_name" text NOT NULL,
  "opened_at" timestamptz NOT NULL DEFAULT now(),
  "closed_by_id" text,
  "closed_by_name" text,
  "closed_at" timestamptz,
  "close_note" text,
  "version" integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS "load_problems_company_open_idx" ON "load_problems" ("company_id", "closed_at");
CREATE INDEX IF NOT EXISTS "load_problems_load_idx" ON "load_problems" ("load_id");
