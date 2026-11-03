-- Who pays for a repair: the company, or the driver.
--
-- A driver charge is held until somebody records that the driver was told. Existing rows are
-- company expenses, which is what they have always been, so the default carries them unchanged.
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "charge_party" text NOT NULL DEFAULT 'company';
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "charge_driver_id" text;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "charge_driver_name" text;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "driver_informed" boolean;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "driver_informed_at" timestamp with time zone;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "driver_informed_by" text;

-- The two questions accounting asks: which charges are held, and what does one driver owe.
CREATE INDEX IF NOT EXISTS "work_orders_charge_idx"
  ON "work_orders" ("company_id", "charge_party", "driver_informed");
CREATE INDEX IF NOT EXISTS "work_orders_charge_driver_idx"
  ON "work_orders" ("company_id", "charge_driver_id");
