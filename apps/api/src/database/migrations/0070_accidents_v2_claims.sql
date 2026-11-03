-- Accident & Claims v2, phase P2 — claims (docs/accidents/IMPLEMENTATION-PLAN.md §4 mapping, owner decision Q1 = Option A).
-- ADDITIVE ONLY: new nullable columns (or NOT NULL with a constant default), new tables, new indexes, new CHECKs that
-- every existing row already satisfies. No DROP, no RENAME, no type change, no change to an existing value.
--
-- One claim per coverage line, many claims per accident. The legacy partial UNIQUE index "safety_claims_accident_key"
-- (one live claim per accident) is NOT touched here: the non-unique "safety_claims_accident_idx" below is the index
-- v2 reads with. Dropping the unique index is a CUTOVER step (apps/api/src/database/cutover/accidents-v2/C1_claims_index_swap.sql), run only
-- with the owner at cutover — until then a second claim on the same accident is refused (409 cutover-required).
-- Everything new is read and written only by the accidents_v2 endpoints (ACCIDENTS_V2, default off).

-- ---------------------------------------------------------------------------------------- 1. safety_claims (extended)
-- v2 vocabulary beside the legacy one: claim_type (legacy `kind` keeps its own values), status (legacy `stage`
-- keeps its pipeline). insurer / insurer_reference (claim #) / adjuster_* / claimed_cents / deductible_cents /
-- closed_at / last_activity_at / owner_* are reused as they are (one column per fact).
ALTER TABLE "safety_claims"
  ADD COLUMN IF NOT EXISTS "claim_type" text CHECK ("claim_type" IN ('physical_damage','auto_liability','cargo','recovery','workers_comp')),
  ADD COLUMN IF NOT EXISTS "status" text CHECK ("status" IN ('Draft','Open','Under review','Awaiting documents','Negotiating','Settled','Denied','Closed')),
  ADD COLUMN IF NOT EXISTS "title" text,
  ADD COLUMN IF NOT EXISTS "standalone_kind" text,
  ADD COLUMN IF NOT EXISTS "what_was_lost" text,
  ADD COLUMN IF NOT EXISTS "claimant" text,
  ADD COLUMN IF NOT EXISTS "responsible_party" text,
  ADD COLUMN IF NOT EXISTS "unit_label" text,
  ADD COLUMN IF NOT EXISTS "opened_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "reported_to_insurer_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "reserve_cents" bigint CHECK ("reserve_cents" >= 0),
  ADD COLUMN IF NOT EXISTS "settlement_cents" bigint CHECK ("settlement_cents" >= 0),
  ADD COLUMN IF NOT EXISTS "disputed" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "restricted" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "restricted_reason" text,
  ADD COLUMN IF NOT EXISTS "next_follow_up_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "next_follow_up_assignee_id" text,
  ADD COLUMN IF NOT EXISTS "next_follow_up_assignee_name" text,
  ADD COLUMN IF NOT EXISTS "next_follow_up_what" text,
  ADD COLUMN IF NOT EXISTS "idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "legacy_ref" text,
  ADD COLUMN IF NOT EXISTS "legacy_payload" jsonb;
-- Workers' comp is always restricted (bodily injury). No existing row has claim_type, so every row satisfies it.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'safety_claims_workers_comp_restricted') THEN
    ALTER TABLE "safety_claims" ADD CONSTRAINT "safety_claims_workers_comp_restricted"
      CHECK ("claim_type" IS DISTINCT FROM 'workers_comp' OR "restricted");
  END IF;
END
$do$;
CREATE INDEX IF NOT EXISTS "safety_claims_accident_idx" ON "safety_claims" ("company_id", "accident_id") WHERE "accident_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "safety_claims_follow_up_idx" ON "safety_claims" ("company_id", "next_follow_up_at") WHERE "next_follow_up_at" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "safety_claims_idempotency_key" ON "safety_claims" ("company_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
-- The cutover split (C2) keys each claim it writes on its source line, so a re-run never doubles one.
CREATE UNIQUE INDEX IF NOT EXISTS "safety_claims_legacy_ref_key" ON "safety_claims" ("company_id", "legacy_ref") WHERE "legacy_ref" IS NOT NULL;

-- ---------------------------------------------------------------------------------------- 2. claim payments (extended)
-- One source of truth for claim money. NULL direction = a legacy row, which was always money received (to_us).
ALTER TABLE "safety_claim_payments"
  ADD COLUMN IF NOT EXISTS "direction" text CHECK ("direction" IN ('to_us','by_insurer_to_claimant','by_us')),
  ADD COLUMN IF NOT EXISTS "party" text,
  ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;

-- ---------------------------------------------------------------------------------------- 3. claim documents checklist
CREATE TABLE IF NOT EXISTS "safety_claim_documents" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "claim_id" text NOT NULL REFERENCES "safety_claims"("id") ON DELETE restrict,
  "label" text NOT NULL,
  "received" boolean DEFAULT false NOT NULL,
  "received_at" timestamp with time zone,
  "received_by" text,
  "file_id" text,
  "sort" integer DEFAULT 0 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "safety_claim_documents_label_key" ON "safety_claim_documents" ("company_id", "claim_id", "label");

-- ---------------------------------------------------------------------------------------- 4. correspondence & notes
CREATE TABLE IF NOT EXISTS "safety_claim_log" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "claim_id" text NOT NULL REFERENCES "safety_claims"("id") ON DELETE restrict,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "by_id" text,
  "by_name" text NOT NULL,
  "channel" text NOT NULL CHECK ("channel" IN ('Email','Phone','Portal','Letter','Note')),
  "text" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "safety_claim_log_claim_idx" ON "safety_claim_log" ("company_id", "claim_id", "at");
