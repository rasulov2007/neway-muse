-- Oil change / PM, Phase 1B (docs/pm-module/04-sheet-import.md): what the importer writes to.
--
-- Shops become records (§3.6): a vendors table in the database with the normalized address the
-- importer deduplicates on. Work orders gain lines (Fleet package §3.6, the minimum the PM
-- completion shape needs), the invoice total as the sheet gives it (nullable: a missing cost is
-- missing, not zero), an "historic" mark for imported spend, and the flags a person reviews.
-- Readings gain "age unknown", for a mileage the sheet gave without a date.

CREATE TABLE IF NOT EXISTS "vendors" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "name" text NOT NULL,
  -- shop · lessor · other
  "kind" text NOT NULL DEFAULT 'shop',
  "address_line" text,
  "city" text,
  "state" text,
  "zip" text,
  -- street number + street + ZIP after normalization; what deduplication compares
  "address_norm" text,
  "is_own_yard" boolean NOT NULL DEFAULT false,
  "payment_terms_days" integer,
  -- active · draft · inactive. A draft is what the importer creates for an address nobody confirmed.
  "status" text NOT NULL DEFAULT 'active',
  -- user · import · migration
  "source" text NOT NULL DEFAULT 'user',
  "legacy_vendor_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "vendors_address_norm_key"
  ON "vendors" ("company_id", "address_norm") WHERE "address_norm" IS NOT NULL AND "status" <> 'inactive';
CREATE INDEX IF NOT EXISTS "vendors_company_idx" ON "vendors" ("company_id", "status");

CREATE TABLE IF NOT EXISTS "work_order_lines" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "work_order_id" text NOT NULL REFERENCES "work_orders"("id") ON DELETE CASCADE,
  -- e.g. pm.oil_change, brakes, tires. Item level preferred.
  "system_code" text NOT NULL,
  -- repair · pm · tires · fee · other
  "line_kind" text NOT NULL DEFAULT 'repair',
  "description" text,
  "parts_amount" numeric(12, 2),
  "labor_amount" numeric(12, 2),
  "labor_hours" numeric(8, 2),
  "total_amount" numeric(12, 2) NOT NULL DEFAULT 0,
  -- the PM service a line resets, when it is a PM line
  "pm_service_code" text,
  "sort" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "work_order_lines_order_idx" ON "work_order_lines" ("work_order_id", "sort");

ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "invoice_total" numeric(12, 2);
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "invoice_date" date;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "historic" boolean NOT NULL DEFAULT false;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "flags" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "odometer_readings" ADD COLUMN IF NOT EXISTS "age_unknown" boolean NOT NULL DEFAULT false;
ALTER TABLE "pm_status" ADD COLUMN IF NOT EXISTS "reading_age_unknown" boolean NOT NULL DEFAULT false;
