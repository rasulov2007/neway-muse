-- Reverses 0023_pm_import.sql: the two tables and the columns it added, nothing else.
ALTER TABLE "pm_status" DROP COLUMN IF EXISTS "reading_age_unknown";
ALTER TABLE "odometer_readings" DROP COLUMN IF EXISTS "age_unknown";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "flags";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "historic";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "invoice_date";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "invoice_total";
DROP TABLE IF EXISTS "work_order_lines";
DROP TABLE IF EXISTS "vendors";
