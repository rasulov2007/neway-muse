-- Rollback for 0081 (mobile foundation). Only before any driver signs in through the app:
-- dropping memberships.driver_id unlinks every driver login, and the mobile tables hold device
-- tokens, idempotency answers and (later phases) messages and breakdowns.
ALTER TABLE "pti_inspections" DROP COLUMN IF EXISTS "driver_submission_count";
ALTER TABLE "pti_inspections" DROP COLUMN IF EXISTS "correction_reason";
ALTER TABLE "pti_inspections" DROP COLUMN IF EXISTS "correction_requested_by";
ALTER TABLE "pti_inspections" DROP COLUMN IF EXISTS "correction_requested_at";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "keys_handed_at";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "truck_parked_note";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "truck_parked_by";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "truck_parked_at";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "decided_reason";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "decided_at";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "decided_by";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "requested_by_driver";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "requested_at";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "request_status";
DROP TABLE IF EXISTS "fleet_breakdowns";
DROP TABLE IF EXISTS "messages";
DROP TABLE IF EXISTS "conversation_participants";
DROP TABLE IF EXISTS "conversations";
DROP TABLE IF EXISTS "mobile_push_log";
DROP TABLE IF EXISTS "mobile_idempotency";
DROP TABLE IF EXISTS "mobile_devices";
ALTER TABLE "auth_sessions" DROP COLUMN IF EXISTS "client";
DROP INDEX IF EXISTS "memberships_company_driver_key";
ALTER TABLE "memberships" DROP COLUMN IF EXISTS "driver_id";
-- Then remove the drizzle row: DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1795450000000;
