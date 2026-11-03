-- Work orders and trailers become rows.
--
-- They lived as JSON inside `app_state`, a blob the browser wrote whole. That made the API unable
-- to filter what it returned (every signed-in account received every invoice total), made a
-- migration unable to touch a work order, and made two people saving in the same minute overwrite
-- each other. Nothing in `app_state` is deleted here; the data migration reads it and leaves it.
--
-- Reversible: `0018_fleet_work_orders.down.sql` drops only what this file creates.

CREATE TABLE IF NOT EXISTS "trailers" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "unit_number" text NOT NULL,
  "vin" text DEFAULT '' NOT NULL,
  "year" integer,
  "make" text,
  "type" text DEFAULT 'dry_van' NOT NULL,
  "length_ft" integer,
  "plate" text,
  "plate_state" text,
  "status" text DEFAULT 'available' NOT NULL,
  "ownership" text DEFAULT 'owned' NOT NULL,
  "current_truck_id" text,
  "current_load_id" text,
  "next_inspection_date" text,
  "home_terminal" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "trailers_company_unit_number_key" ON "trailers" ("company_id", "unit_number");
CREATE INDEX IF NOT EXISTS "trailers_company_idx" ON "trailers" ("company_id");

CREATE TABLE IF NOT EXISTS "work_orders" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "number" text NOT NULL,
  "asset_type" text NOT NULL,
  "unit_id" text NOT NULL,
  "unit_number" text DEFAULT '' NOT NULL,
  -- Two values: in_shop or completed. The six it replaces carried two facts at once.
  "status" text NOT NULL,
  "shop_stage" text,
  "work_type" text NOT NULL,
  "work_done" text,
  -- Nullable on purpose: a required title was a field people filled to make the form submit.
  "title" text,
  "shop_in_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "downtime_minutes" integer,
  "odometer" integer,
  "assigned_to" text,
  "vendor_id" text,
  "vendor_name" text DEFAULT '' NOT NULL,
  "parts_total" numeric(12, 2) DEFAULT '0' NOT NULL,
  "labor_total" numeric(12, 2) DEFAULT '0' NOT NULL,
  "fees_total" numeric(12, 2) DEFAULT '0' NOT NULL,
  "total" numeric(12, 2) DEFAULT '0' NOT NULL,
  "invoice_number" text,
  "invoice_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "notes" text,
  "migrated_from" text,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "work_orders_company_number_key" ON "work_orders" ("company_id", "number");
CREATE INDEX IF NOT EXISTS "work_orders_company_status_idx" ON "work_orders" ("company_id", "status");
CREATE INDEX IF NOT EXISTS "work_orders_unit_idx" ON "work_orders" ("company_id", "unit_id");

CREATE TABLE IF NOT EXISTS "work_order_actions" (
  "id" text PRIMARY KEY NOT NULL,
  "work_order_id" text NOT NULL REFERENCES "work_orders"("id") ON DELETE cascade,
  "stage" text,
  "note" text,
  "action" text DEFAULT 'stage_changed' NOT NULL,
  "user_id" text,
  "user_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "work_order_actions_order_idx" ON "work_order_actions" ("work_order_id", "created_at");

CREATE TABLE IF NOT EXISTS "unit_maintenance_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "asset_type" text NOT NULL,
  "unit_id" text NOT NULL,
  "oil_change_interval_miles" integer,
  "pm_interval_miles" integer,
  "pm_interval_days" integer,
  "annual_inspection_months" integer,
  "last_oil_change_at" timestamp with time zone,
  "last_oil_change_odometer" integer,
  "last_pm_at" timestamp with time zone,
  "last_pm_odometer" integer,
  "last_annual_inspection_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "unit_maintenance_settings_unit_key" ON "unit_maintenance_settings" ("company_id", "asset_type", "unit_id");
