ALTER TABLE "safety_reviews" DROP COLUMN IF EXISTS "accounting_expense_id";
DROP INDEX IF EXISTS "driver_vacations_open_key";
CREATE UNIQUE INDEX IF NOT EXISTS "driver_vacations_open_key" ON "driver_vacations" ("company_id", "driver_id") WHERE "ended_on" IS NULL;
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "cancel_reason";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "cancelled_by";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "cancelled_at";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "version";
ALTER TABLE "driver_vacations" DROP COLUMN IF EXISTS "expected_return_on";
