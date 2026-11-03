-- The completed-load pipeline (Accounting corrective brief, section 3): one row per completed
-- load, keyed on the load, holding the invoice candidate and the earning candidates it produced
-- or the error that stopped it. A retry or a backfill finds the row and updates it; it can never
-- make a second one. Additive; `0036_acct_completions.down.sql` removes it.
CREATE TABLE IF NOT EXISTS "acct_completions" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "load_id" text NOT NULL,
  "load_number" text NOT NULL,
  "load_status" text NOT NULL,
  "state" text NOT NULL,
  "source_key" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "acct_completions_load_key" ON "acct_completions" ("company_id", "load_id");
CREATE UNIQUE INDEX IF NOT EXISTS "acct_completions_source_key" ON "acct_completions" ("company_id", "source_key");
CREATE INDEX IF NOT EXISTS "acct_completions_state_idx" ON "acct_completions" ("company_id", "state");
