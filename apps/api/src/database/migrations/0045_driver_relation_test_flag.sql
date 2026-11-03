-- Test data (owner, 2026-10-07): Driver Relations requests and hiring cases are kept, never deleted,
-- but left out of every list, count, badge and thread. Who, when and why sit beside the flag and in
-- the audit log. Additive only: eight columns with safe defaults; no row changes.
ALTER TABLE "driver_relation_requests" ADD COLUMN IF NOT EXISTS "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_relation_requests" ADD COLUMN IF NOT EXISTS "test_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "driver_relation_requests" ADD COLUMN IF NOT EXISTS "test_marked_by" text;--> statement-breakpoint
ALTER TABLE "driver_relation_requests" ADD COLUMN IF NOT EXISTS "test_reason" text;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "test_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "test_marked_by" text;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "test_reason" text;
