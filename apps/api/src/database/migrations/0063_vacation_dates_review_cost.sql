-- Vacation dates and corrections, and the cost a vacation-return review points at (owner, 2026-10-17).
-- Additive only: nullable columns and a version, no existing row changes meaning.
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "expected_return_on" date;
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "cancelled_by" text;
ALTER TABLE "driver_vacations" ADD COLUMN IF NOT EXISTS "cancel_reason" text;
-- One open vacation per driver; a cancelled entry no longer holds the place.
DROP INDEX IF EXISTS "driver_vacations_open_key";
CREATE UNIQUE INDEX IF NOT EXISTS "driver_vacations_open_key" ON "driver_vacations" ("company_id", "driver_id") WHERE "ended_on" IS NULL AND "cancelled_at" IS NULL;
-- The Accounting expense a vacation-return review was attributed (an existing record; nothing is posted from here).
ALTER TABLE "safety_reviews" ADD COLUMN IF NOT EXISTS "accounting_expense_id" text;
