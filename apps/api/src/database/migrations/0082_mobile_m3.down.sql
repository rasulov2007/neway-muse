-- Rollback for 0082 (mobile M3). Run only before drivers file from the app: it drops the pointers
-- from the driver's receipts and reports to their records (the records themselves stay).
DROP TABLE IF EXISTS "driver_app_submissions";
DROP INDEX IF EXISTS "fleet_breakdowns_idempotency_key";
ALTER TABLE "fleet_breakdowns" DROP COLUMN IF EXISTS "vendor_name";
ALTER TABLE "fleet_breakdowns" DROP COLUMN IF EXISTS "load_problem_id";
DROP INDEX IF EXISTS "hiring_leads_referrer_idx";
ALTER TABLE "hiring_leads" DROP COLUMN IF EXISTS "referred_by_driver_id";
DROP INDEX IF EXISTS "driver_vacations_request_idx";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "keys_handed_by";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "truck_parked_source";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "truck_parked_file_id";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "requested_end_on";
-- Requests that never started must be cancelled first, or the old index cannot be rebuilt.
UPDATE "driver_vacations" SET "cancelled_at" = now(), "cancel_reason" = 'Rollback of 0082: request that never started' WHERE "request_status" IN ('requested', 'approved', 'rejected') AND "cancelled_at" IS NULL;
DROP INDEX IF EXISTS "driver_vacations_open_key";
CREATE UNIQUE INDEX IF NOT EXISTS "driver_vacations_open_key" ON "driver_vacations" ("company_id", "driver_id") WHERE "ended_on" IS NULL AND "cancelled_at" IS NULL;
-- Then remove the drizzle row: DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795500000000;
