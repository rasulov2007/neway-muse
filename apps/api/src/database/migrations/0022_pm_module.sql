-- Oil change / PM (docs/pm-module/02-pm-spec.md §3), behind the pm_module flag.
--
-- Four tables and three columns. Nothing existing is rewritten: unit_maintenance_settings keeps
-- the older oil-change baseline, which the calculation reads until a recorded completion or the
-- import replaces it; trucks.odometer keeps being the roster's latest value, while
-- odometer_readings keeps the history the due status needs to be honest about age.

-- The service catalog. One row per company and code; OIL_CHANGE is seeded by the service.
CREATE TABLE IF NOT EXISTS "pm_services" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "resets_interval" boolean NOT NULL DEFAULT true,
  "default_interval_miles" integer,
  "default_interval_days" integer,
  "default_interval_hours" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "pm_services_code_key" ON "pm_services" ("company_id", "code");

-- Intervals. A unit plan always wins over its group plan; a voided plan stays for the record.
CREATE TABLE IF NOT EXISTS "pm_plans" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "service_code" text NOT NULL,
  -- group · unit
  "scope" text NOT NULL,
  "group_name" text,
  "unit_id" text,
  "interval_miles" integer NOT NULL,
  "interval_days" integer,
  "interval_hours" integer,
  "due_soon_miles" integer,
  "due_soon_days" integer,
  "reason" text,
  "set_by" text NOT NULL,
  "set_by_name" text NOT NULL DEFAULT '',
  "set_at" timestamp with time zone NOT NULL DEFAULT now(),
  "voided_at" timestamp with time zone,
  "voided_by" text,
  "void_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "pm_plans_unit_key"
  ON "pm_plans" ("company_id", "service_code", "unit_id") WHERE "scope" = 'unit' AND "voided_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "pm_plans_group_key"
  ON "pm_plans" ("company_id", "service_code", "group_name") WHERE "scope" = 'group' AND "voided_at" IS NULL;

-- One usable reading per unit per day is enough. A reading that fails validation is kept as a
-- conflict and never used; a manual one carries the photo it was taken from.
CREATE TABLE IF NOT EXISTS "odometer_readings" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "unit_id" text NOT NULL,
  "reading_at" timestamp with time zone NOT NULL,
  -- The calendar date of the reading in the company's timezone.
  "reading_date" date NOT NULL,
  "odometer_miles" integer NOT NULL,
  "engine_hours" numeric(10, 1),
  -- eld · invoice · manual · import
  "source" text NOT NULL,
  -- ok · conflict · void
  "status" text NOT NULL DEFAULT 'ok',
  -- below_previous · too_high_per_day
  "conflict_reason" text,
  "conflict_with" integer,
  "photo_id" text,
  "note" text,
  "created_by" text NOT NULL,
  "created_by_name" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "voided_at" timestamp with time zone,
  "void_reason" text
);
CREATE INDEX IF NOT EXISTS "odometer_readings_unit_idx" ON "odometer_readings" ("company_id", "unit_id", "reading_at" DESC);
-- The telematics feed writes one row per unit per day and updates it as the day goes on.
CREATE UNIQUE INDEX IF NOT EXISTS "odometer_readings_eld_day_key"
  ON "odometer_readings" ("company_id", "unit_id", "reading_date") WHERE "source" = 'eld';

-- The cached verdict per unit and service (§3.3). Never written by hand; recomputed on every
-- reading, completion, plan change and nightly.
CREATE TABLE IF NOT EXISTS "pm_status" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "unit_id" text NOT NULL,
  "service_code" text NOT NULL,
  "last_service_id" text,
  "last_service_at" timestamp with time zone,
  "last_service_odometer" integer,
  -- completion · import · baseline
  "last_service_source" text,
  "interval_miles" integer,
  "interval_days" integer,
  "interval_hours" integer,
  -- unit · group · fleet
  "plan_origin" text,
  "plan_id" text,
  "due_soon_miles" integer,
  "due_soon_days" integer,
  "next_service_odometer" integer,
  "next_service_date" date,
  "miles_since_service" integer,
  "miles_remaining" integer,
  "days_since_service" integer,
  "days_remaining" integer,
  "avg_miles_per_day" numeric(10, 1),
  -- 30d · 60d · group_median
  "avg_basis" text,
  "estimated_due_date" date,
  -- overdue · overdue_at_least · due_soon · ok · no_reading · no_baseline · no_interval
  "due_status" text NOT NULL,
  -- miles · days · hours
  "due_basis" text,
  "miles_over_at_reading" integer,
  "reading_id" text,
  "reading_at" timestamp with time zone,
  "reading_odometer" integer,
  "reading_source" text,
  "reading_age_hours" numeric(10, 1),
  "reading_stale" boolean NOT NULL DEFAULT false,
  "computed_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "pm_status_unit_service_key" ON "pm_status" ("company_id", "unit_id", "service_code");
CREATE INDEX IF NOT EXISTS "pm_status_due_idx" ON "pm_status" ("company_id", "service_code", "due_status");

-- The customer's ownership groups (NWF, Ryder, M&K) and who is responsible for a unit's PM.
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "group_name" text;
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "pm_responsibility" text NOT NULL DEFAULT 'us';
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "lessor_name" text;

-- A completion is a work order (§3.5). These are the fields that make one a PM completion: the
-- service it resets, the odometer read AT the service and when it happened. Only a row with
-- pm_service_code set counts as a baseline; a completed order without it changes nothing about PM.
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "pm_service_code" text;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "service_at" timestamp with time zone;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "service_odometer" integer;
-- record_repair · work_order_form · migration · import
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "entered_via" text;
CREATE INDEX IF NOT EXISTS "work_orders_pm_service_idx"
  ON "work_orders" ("company_id", "unit_id", "pm_service_code", "service_at") WHERE "pm_service_code" IS NOT NULL;
