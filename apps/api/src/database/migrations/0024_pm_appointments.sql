-- Oil change / PM, Phase 1C-1E (docs/pm-module/02-pm-spec.md §3.7, §6): the appointment is the
-- same work order in status `scheduled`. These are its fields. A scheduled order is a booking:
-- the unit is still on the road, and nothing about the due status changes until a completion is
-- recorded (§4.3). The $0 reason is the completion's (§6.2).
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "scheduled_for" timestamp with time zone;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "responsible_name" text;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "estimated_cost" numeric(12, 2);
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "note_for_shop" text;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "notify_driver" boolean NOT NULL DEFAULT true;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "notify_dispatcher" boolean NOT NULL DEFAULT true;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "hold_minutes" integer;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "zero_reason" text;
-- A voided completion stays on the record (§6.3): who, when, why. It is no longer a baseline.
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "voided_by" text;
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "void_reason" text;
CREATE INDEX IF NOT EXISTS "work_orders_scheduled_idx" ON "work_orders" ("company_id", "scheduled_for");
