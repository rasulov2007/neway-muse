DROP INDEX IF EXISTS "work_orders_charge_driver_idx";
DROP INDEX IF EXISTS "work_orders_charge_idx";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "driver_informed_by";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "driver_informed_at";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "driver_informed";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "charge_driver_name";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "charge_driver_id";
ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "charge_party";
