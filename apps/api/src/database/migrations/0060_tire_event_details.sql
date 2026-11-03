-- Tire work orders (owner, 2026-10-14): what each tire was - the work, brand and model, the
-- reason, tread at removal, its own price and labor share, the odometer and shop - and the unit
-- the work order was written on when the tire belongs to another (a trailer's tire on the truck's
-- order). Additive: columns only.
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "action" text;
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "brand" text;
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "model" text;
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "tread_removed_32" numeric(4, 1);
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "tire_cost_cents" integer;
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "labor_cents" integer;
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "odometer" integer;
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "vendor_name" text;
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "recorded_on_unit_id" text;
ALTER TABLE "repair_tire_events" ADD COLUMN IF NOT EXISTS "event_on" date;
