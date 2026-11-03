-- Reverses 0022_pm_module.sql.
--
-- Drops only what that file created. unit_maintenance_settings, work_orders and the roster's
-- odometer are untouched; the three truck columns go with their values, which the import can
-- write again.
DROP TABLE IF EXISTS "pm_status";
DROP TABLE IF EXISTS "odometer_readings";
DROP TABLE IF EXISTS "pm_plans";
DROP TABLE IF EXISTS "pm_services";
ALTER TABLE "trucks" DROP COLUMN IF EXISTS "lessor_name";
ALTER TABLE "trucks" DROP COLUMN IF EXISTS "pm_responsibility";
ALTER TABLE "trucks" DROP COLUMN IF EXISTS "group_name";
DROP INDEX IF EXISTS "work_orders_pm_service_idx";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "entered_via";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "service_odometer";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "service_at";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "pm_service_code";
