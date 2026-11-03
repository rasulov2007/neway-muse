-- 0077: self-onboarding (owner, 2026-10-26). Additive only; nothing existing is rewritten.
-- Personal fields an employee record carries in their own columns instead of free-text notes:
-- date of birth and passport / ID number are personal data, masked for readers without the
-- sensitive personnel codes (the same rule as the driver date of birth). Null = not recorded.
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "date_of_birth" date;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "id_number" text;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "home_address" text;
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "shift_time" text;
--> statement-breakpoint
-- When the person submitted Complete your profile. Null with no linked employee = still to do.
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "profile_completed_at" timestamp with time zone;
