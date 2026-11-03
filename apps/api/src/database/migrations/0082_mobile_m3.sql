-- Mobile M3 (docs/mobile/API.md §7-§14): what the driver app's breakdowns, receipts, Driver Care,
-- referrals, vacations, documents and safety reports need beyond 0081. Additive.
--
-- Vacation requests live on driver_vacations (0081 request columns). A request that has not started
-- is not an open vacation: the "one open vacation per driver" index now counts only office-entered
-- rows (request_status null) and requests that started.
DROP INDEX IF EXISTS "driver_vacations_open_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_vacations_open_key" ON "driver_vacations" ("company_id", "driver_id") WHERE "ended_on" IS NULL AND "cancelled_at" IS NULL AND ("request_status" IS NULL OR "request_status" = 'started');
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "requested_end_on" date;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "truck_parked_file_id" text;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "truck_parked_source" text;
--> statement-breakpoint
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "keys_handed_by" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_vacations_request_idx" ON "driver_vacations" ("company_id", "request_status") WHERE "request_status" IS NOT NULL;
--> statement-breakpoint
-- The driver who referred a lead from the app (Recruiting sees it; the driver sees the stage only).
ALTER TABLE "hiring_leads" ADD COLUMN IF NOT EXISTS "referred_by_driver_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_leads_referrer_idx" ON "hiring_leads" ("company_id", "referred_by_driver_id") WHERE "referred_by_driver_id" IS NOT NULL;
--> statement-breakpoint
-- A breakdown's flag on the load (load_problems) and the shop's name as chosen.
ALTER TABLE "fleet_breakdowns" ADD COLUMN IF NOT EXISTS "load_problem_id" text;
--> statement-breakpoint
ALTER TABLE "fleet_breakdowns" ADD COLUMN IF NOT EXISTS "vendor_name" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fleet_breakdowns_idempotency_key" ON "fleet_breakdowns" ("company_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
-- What a driver filed from the app that lives in another module's table (a company-card receipt
-- as a draft Fleet expense, a safety report as an accident / roadside inspection / DR request):
-- the pointer that lets "my receipts" and "my reports" list exactly the driver's own records.
CREATE TABLE IF NOT EXISTS "driver_app_submissions" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "driver_id" text NOT NULL,
  "membership_id" text,
  -- company_expense · safety_report
  "kind" text NOT NULL,
  -- accident · roadside_inspection · violation (safety reports) · the receipt category
  "subkind" text,
  -- fleet_expense · accident · roadside_inspection · driver_relation_request
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "target_number" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "idempotency_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_app_submissions_driver_idx" ON "driver_app_submissions" ("company_id", "driver_id", "kind", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_app_submissions_idempotency_key" ON "driver_app_submissions" ("company_id", "driver_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
