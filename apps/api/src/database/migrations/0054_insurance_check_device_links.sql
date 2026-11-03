-- Owner, 2026-10-12: Safety's insurance check on a candidate (asked, then the insurer's answer),
-- and consent / application links that open on the first device only. Additive: nullable columns.
ALTER TABLE "hiring_safety_reviews" ADD COLUMN IF NOT EXISTS "insurance_status" text;
ALTER TABLE "hiring_safety_reviews" ADD COLUMN IF NOT EXISTS "insurance_note" text;
ALTER TABLE "hiring_safety_reviews" ADD COLUMN IF NOT EXISTS "insurance_requested_at" timestamp with time zone;
ALTER TABLE "hiring_safety_reviews" ADD COLUMN IF NOT EXISTS "insurance_requested_by" text;
ALTER TABLE "hiring_safety_reviews" ADD COLUMN IF NOT EXISTS "insurance_responded_at" timestamp with time zone;
ALTER TABLE "hiring_safety_reviews" ADD COLUMN IF NOT EXISTS "insurance_responded_by" text;
ALTER TABLE "hiring_consent_sessions" ADD COLUMN IF NOT EXISTS "bound_device_hash" text;
ALTER TABLE "hiring_consent_sessions" ADD COLUMN IF NOT EXISTS "bound_at" timestamp with time zone;
ALTER TABLE "hiring_application_sessions" ADD COLUMN IF NOT EXISTS "bound_device_hash" text;
ALTER TABLE "hiring_application_sessions" ADD COLUMN IF NOT EXISTS "bound_at" timestamp with time zone;
