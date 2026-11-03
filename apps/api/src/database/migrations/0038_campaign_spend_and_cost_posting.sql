-- Recruiting decisions (owner, 2026-10-01). Additive: one new table, three nullable columns, one
-- backfill that only inserts. `0038_campaign_spend_and_cost_posting.down.sql` takes it back out.
--
-- 1. Campaign spend by date. A campaign's spend becomes dated entries (date, amount, note, who),
--    so cost per lead and per hire can be taken for a reporting period. Voided, never deleted;
--    `version` is checked and bumped on every edit.
--
--    Backfill: each campaign whose old single total is above zero gets ONE entry for that total,
--    dated at the campaign's start date (or, were it ever missing, the Eastern calendar date it
--    was created). The id is derived from the campaign id and a campaign that already has any
--    entry is skipped, so running this twice - or again after a down and up - inserts nothing
--    twice. `hiring_campaigns.spend` is left in place (rollback) and no longer read.
CREATE TABLE IF NOT EXISTS "hiring_campaign_spend" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "campaign_id" text NOT NULL REFERENCES "hiring_campaigns"("id") ON DELETE RESTRICT,
  "spent_on" date NOT NULL,
  "amount" numeric(12, 2) NOT NULL,
  "note" text,
  "recorded_by" text NOT NULL,
  "client_key" text,
  "version" integer NOT NULL DEFAULT 1,
  "voided_at" timestamptz,
  "voided_by" text,
  "void_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "hiring_campaign_spend_campaign_idx"
  ON "hiring_campaign_spend" ("company_id", "campaign_id", "spent_on");
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_campaign_spend_client_key"
  ON "hiring_campaign_spend" ("company_id", "client_key")
  WHERE "client_key" IS NOT NULL;

INSERT INTO "hiring_campaign_spend"
  ("id", "company_id", "campaign_id", "spent_on", "amount", "note", "recorded_by", "created_at", "updated_at")
SELECT
  'cmpsp_0038_' || c."id",
  c."company_id",
  c."id",
  COALESCE(c."period_start", (c."created_at" AT TIME ZONE 'America/New_York')::date),
  c."spend",
  'Campaign spend total before spend was dated (migration 0038)',
  'Migration 0038',
  c."created_at",
  c."created_at"
FROM "hiring_campaigns" c
WHERE c."spend" > 0
  AND NOT EXISTS (SELECT 1 FROM "hiring_campaign_spend" s WHERE s."campaign_id" = c."id")
ON CONFLICT ("id") DO NOTHING;

-- 2. Candidate costs post to Accounting as expenses. `accounting_expense_id` (0037) already holds
--    the linked expense; these say whether posting created it (vs. attributed from Accounting),
--    who posted it, and why the last post, update or void in Accounting did not happen.
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "accounting_posted_at" timestamptz;
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "accounting_posted_by" text;
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "accounting_post_note" text;
