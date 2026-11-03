-- Test leads (owner, 2026-10-07). A lead can be marked as test data: kept, never deleted, but
-- left out of every list, count, phone dedupe and analytics. Who, when and why are stored beside
-- the flag and in the audit log. Additive only: four columns with safe defaults; no row changes.
ALTER TABLE "hiring_leads" ADD COLUMN IF NOT EXISTS "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hiring_leads" ADD COLUMN IF NOT EXISTS "test_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_leads" ADD COLUMN IF NOT EXISTS "test_marked_by" text;--> statement-breakpoint
ALTER TABLE "hiring_leads" ADD COLUMN IF NOT EXISTS "test_reason" text;
