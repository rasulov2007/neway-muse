-- The dispatch operations layer around the boards (owner's brief, 2026-09-22): the board
-- roster with its assignment history, commission policy versions, per-week overrides and
-- flags, salary runs, adjustments and allocations, detention claims, and the audit log.
-- Additive; nothing existing changes. Board cells keep their driver ids: a driver's roster
-- row carries the driver's own id, so every typed cell stays where it was.
CREATE TABLE IF NOT EXISTS "dispatch_roster" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "driver_id" text,
  "import_key" text,
  "name" text NOT NULL,
  "co_driver" text,
  "source_name" text,
  "pay_tag" text,
  "truck_unit" text,
  "phone" text NOT NULL DEFAULT '',
  "dispatcher_id" text NOT NULL DEFAULT '',
  "dispatcher_name" text NOT NULL DEFAULT '',
  "comment" text NOT NULL DEFAULT '',
  "unassigned_at" timestamp with time zone,
  "unassigned_from" date,
  "unassigned_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_roster_driver_key" ON "dispatch_roster" ("company_id", "driver_id");
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_roster_import_key" ON "dispatch_roster" ("company_id", "import_key");
CREATE INDEX IF NOT EXISTS "dispatch_roster_company_idx" ON "dispatch_roster" ("company_id");

CREATE TABLE IF NOT EXISTS "dispatch_roster_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "roster_id" text NOT NULL,
  "effective_from" date NOT NULL,
  "dispatcher_id" text NOT NULL,
  "dispatcher_name" text NOT NULL,
  "truck_unit" text,
  "co_driver" text,
  "pay_tag" text,
  "by" text NOT NULL,
  "at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "dispatch_roster_assignments_idx" ON "dispatch_roster_assignments" ("company_id", "roster_id", "effective_from");

CREATE TABLE IF NOT EXISTS "dispatch_policy_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "version" text NOT NULL,
  "effective_from" date NOT NULL,
  "note" text NOT NULL DEFAULT '',
  "policy" text NOT NULL,
  "created_by" text NOT NULL,
  "created_by_name" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_policy_versions_key" ON "dispatch_policy_versions" ("company_id", "version");

CREATE TABLE IF NOT EXISTS "dispatch_week_overrides" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "roster_id" text NOT NULL,
  "week_start" date NOT NULL,
  "mode" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "reason" text NOT NULL,
  "by" text NOT NULL,
  "by_name" text NOT NULL DEFAULT '',
  "at" timestamp with time zone NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_week_overrides_key" ON "dispatch_week_overrides" ("company_id", "roster_id", "week_start");

CREATE TABLE IF NOT EXISTS "dispatch_week_flags" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "roster_id" text NOT NULL,
  "week_start" date NOT NULL,
  "complaint" boolean NOT NULL DEFAULT false,
  "junior" boolean NOT NULL DEFAULT false,
  "reason" text NOT NULL DEFAULT '',
  "by" text NOT NULL,
  "by_name" text NOT NULL DEFAULT '',
  "at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_week_flags_key" ON "dispatch_week_flags" ("company_id", "roster_id", "week_start");

CREATE TABLE IF NOT EXISTS "dispatch_allocations" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "dispatcher_id" text NOT NULL,
  "effective_from" date NOT NULL,
  "shares" text NOT NULL,
  "by" text NOT NULL,
  "by_name" text NOT NULL DEFAULT '',
  "at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "dispatch_allocations_idx" ON "dispatch_allocations" ("company_id", "dispatcher_id", "effective_from");

CREATE TABLE IF NOT EXISTS "dispatch_salary_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "period_kind" text NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "snapshot" text,
  "created_by" text NOT NULL,
  "created_by_name" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finalized_by" text,
  "finalized_by_name" text,
  "finalized_at" timestamp with time zone,
  "reopened_by" text,
  "reopened_by_name" text,
  "reopened_at" timestamp with time zone,
  "reopen_reason" text,
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_salary_runs_key" ON "dispatch_salary_runs" ("company_id", "period_kind", "period_start");

CREATE TABLE IF NOT EXISTS "dispatch_salary_adjustments" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "dispatcher_id" text NOT NULL,
  "employee_name" text NOT NULL DEFAULT '',
  "month" text NOT NULL,
  "kind" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "reason" text NOT NULL,
  "approved_by_name" text NOT NULL,
  "by" text NOT NULL,
  "by_name" text NOT NULL DEFAULT '',
  "at" timestamp with time zone NOT NULL DEFAULT now(),
  "voided_at" timestamp with time zone,
  "void_reason" text
);
CREATE INDEX IF NOT EXISTS "dispatch_salary_adjustments_idx" ON "dispatch_salary_adjustments" ("company_id", "month");

CREATE TABLE IF NOT EXISTS "dispatch_claims" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "load_number" text NOT NULL,
  "claim_type" text NOT NULL,
  "roster_id" text,
  "driver_name" text NOT NULL DEFAULT '',
  "claim_date" date NOT NULL,
  "requested_cents" integer NOT NULL DEFAULT 0,
  "recovered_cents" integer NOT NULL DEFAULT 0,
  "updater" text NOT NULL DEFAULT '',
  "updater_payout_cents" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'open',
  "notes" text NOT NULL DEFAULT '',
  "by" text NOT NULL,
  "by_name" text NOT NULL DEFAULT '',
  "at" timestamp with time zone NOT NULL DEFAULT now(),
  "voided_at" timestamp with time zone,
  "void_reason" text,
  "version" integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS "dispatch_claims_idx" ON "dispatch_claims" ("company_id", "claim_date");
CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_claims_live_load_key" ON "dispatch_claims" ("company_id", "load_number") WHERE "voided_at" IS NULL;

CREATE TABLE IF NOT EXISTS "dispatch_audit" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "entity" text NOT NULL,
  "entity_id" text NOT NULL,
  "action" text NOT NULL,
  "before" text,
  "after" text,
  "by" text NOT NULL,
  "by_name" text NOT NULL DEFAULT '',
  "at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "dispatch_audit_idx" ON "dispatch_audit" ("company_id", "entity", "entity_id");
