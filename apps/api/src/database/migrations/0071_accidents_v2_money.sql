-- Accident & Claims v2, phase P3 — equipment, downtime and money (docs/accidents/IMPLEMENTATION-PLAN.md §4, SPEC §6.4–6.6).
-- ADDITIVE ONLY: new nullable columns, new tables, new indexes. No DROP, no RENAME, no type change, no value changed.
-- Costs are never copied into Safety: the case reads AP bills and work orders where they live; downtime from the
-- out-of-service periods (0069) that Fleet verifies; the unit status history is written only when the owning department
-- (Dispatch) confirms a request. Everything new is read and written only by the accidents_v2 endpoints (default off).

-- ---------------------------------------------------------------------------------------- 1. work orders (Fleet)
-- Many work orders per accident. The estimates policy (more than the threshold → N estimates) and the approval with
-- its policy-exception reason live on the work order; the shop stage and completion stay Fleet's own columns.
ALTER TABLE "work_orders"
  ADD COLUMN IF NOT EXISTS "accident_id" text,
  ADD COLUMN IF NOT EXISTS "estimates_required" integer CHECK ("estimates_required" >= 1),
  ADD COLUMN IF NOT EXISTS "approved_cents" bigint CHECK ("approved_cents" >= 0),
  ADD COLUMN IF NOT EXISTS "approved_estimate_id" text,
  ADD COLUMN IF NOT EXISTS "approved_by" text,
  ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "policy_exception_reason" text,
  ADD COLUMN IF NOT EXISTS "eta" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "work_orders_accident_idx" ON "work_orders" ("company_id", "accident_id") WHERE "accident_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "work_order_estimates" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "work_order_id" text NOT NULL REFERENCES "work_orders"("id") ON DELETE restrict,
  "vendor" text NOT NULL,
  "amount_cents" bigint NOT NULL CHECK ("amount_cents" >= 0),
  "received_at" timestamp with time zone NOT NULL,
  "selected" boolean DEFAULT false NOT NULL,
  "file_id" text,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_order_estimates_wo_idx" ON "work_order_estimates" ("company_id", "work_order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "work_order_estimates_one_selected" ON "work_order_estimates" ("work_order_id") WHERE "selected";

-- ---------------------------------------------------------------------------------------- 2. AP bills (Accounting)
-- A bill counts on a case directly (accident_id) or through its work order (source repair_order:<wo>); a bill linked
-- to a claim counts through the claim, never twice (SPEC §7.13).
ALTER TABLE "acct_bills"
  ADD COLUMN IF NOT EXISTS "accident_id" text,
  ADD COLUMN IF NOT EXISTS "claim_id" text,
  ADD COLUMN IF NOT EXISTS "accident_cost_category" text
    CHECK ("accident_cost_category" IN ('Towing','Storage','Tractor repair','Trailer repair','Transload / recovery','Rental equipment','Deductible','Cargo','Other'));
CREATE INDEX IF NOT EXISTS "acct_bills_accident_idx" ON "acct_bills" ("company_id", "accident_id") WHERE "accident_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "acct_bills_claim_idx" ON "acct_bills" ("company_id", "claim_id") WHERE "claim_id" IS NOT NULL;

-- ---------------------------------------------------------------------------------------- 3. lost revenue (not cash)
-- A truck's daily contribution for the lost-revenue estimate. NULL = the settings fallback ($640/truck-day) until the
-- owner decides how contribution is computed (SPEC §12 open decision 5).
ALTER TABLE "trucks"
  ADD COLUMN IF NOT EXISTS "daily_contribution_cents" bigint CHECK ("daily_contribution_cents" >= 0);

-- ---------------------------------------------------------------------------------------- 4. unit status history
-- The Daily board keeps a status per driver row, not per unit, and no history by unit (SPEC §12 open decision 1). A row
-- here is written only when Dispatch CONFIRMS a request (unit unavailable → ACCIDENT, ready after repair → READY); the
-- previous row of the unit is closed (until). Never written by Safety directly.
CREATE TABLE IF NOT EXISTS "unit_status_history" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "unit_kind" text NOT NULL CHECK ("unit_kind" IN ('truck','trailer')),
  "unit_id" text NOT NULL,
  "status" text NOT NULL,
  "since" timestamp with time zone NOT NULL,
  "until" timestamp with time zone,
  "set_by" text,
  "source" text DEFAULT 'dispatch_confirmation' NOT NULL,
  "accident_id" text,
  "task_id" text,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CHECK ("until" IS NULL OR "until" >= "since")
);
CREATE INDEX IF NOT EXISTS "unit_status_history_unit_idx" ON "unit_status_history" ("company_id", "unit_kind", "unit_id", "since" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "unit_status_history_one_open" ON "unit_status_history" ("company_id", "unit_kind", "unit_id") WHERE "until" IS NULL;

-- ---------------------------------------------------------------------------------------- 5. tasks on a work order
-- A task about a work order completes only with that work order (never by title — SPEC §11 shortcut 3).
CREATE INDEX IF NOT EXISTS "safety_tasks_work_order_idx" ON "safety_tasks" ("company_id", "work_order_id") WHERE "work_order_id" IS NOT NULL;
