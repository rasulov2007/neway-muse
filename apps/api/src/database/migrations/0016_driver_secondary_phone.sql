-- A second number for a driver and what it is (cell, home, spouse, dispatch-only).
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "secondary_phone" text;
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "secondary_phone_label" text;
