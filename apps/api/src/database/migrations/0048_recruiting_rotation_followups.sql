-- Recruiting redesign (owner, 2026-10-08): the HR rotation kept in the database, follow-up dates
-- on candidates, the Safety request, and the intake adapter for the external driver application.
--
-- Additive only: two new nullable/defaulted column groups and three new tables. No existing row is
-- changed by this file. The rotation roster is NOT seeded here: the first read or allocation after
-- deploy seeds it inside the allocator's transaction, under the same per-company advisory lock,
-- from the rotation that is live today (the recruiters in their current order and the last
-- `auto_assign` audit entry as the pointer), so the next recipient is the same before and after.
-- Rolling back (0048 .down.sql) drops the new tables and columns; the audit pointer the previous
-- code reads keeps being written by the new allocator, so the old code resumes at the right turn.

ALTER TABLE "hiring_leads" ADD COLUMN IF NOT EXISTS "next_follow_up_on" date;--> statement-breakpoint
ALTER TABLE "hiring_leads" ADD COLUMN IF NOT EXISTS "follow_up_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_leads" ADD COLUMN IF NOT EXISTS "follow_up_set_by" text;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "next_follow_up_on" date;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "follow_up_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "follow_up_set_by" text;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "safety_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "safety_requested_by" text;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "safety_request_note" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_leads_follow_up_idx" ON "hiring_leads" USING btree ("company_id","next_follow_up_on") WHERE "next_follow_up_on" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_cases_follow_up_idx" ON "hiring_cases" USING btree ("company_id","next_follow_up_on") WHERE "next_follow_up_on" IS NOT NULL;--> statement-breakpoint
-- One row per recruiter account in a company's rotation, in turn order. Keyed by the user id (the
-- account), with the employee the leads are assigned to. Excluding keeps the row and its place.
CREATE TABLE IF NOT EXISTS "hiring_rotation_members" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"user_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"position" integer NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"excluded_at" timestamp with time zone,
	"excluded_by" text,
	"exclude_reason" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_via" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_rotation_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_rotation_members_user_key" ON "hiring_rotation_members" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_rotation_members_order_idx" ON "hiring_rotation_members" USING btree ("company_id","position");--> statement-breakpoint
-- The cursor: who took the last turn, and at which place in the order.
CREATE TABLE IF NOT EXISTS "hiring_rotation_state" (
	"company_id" text PRIMARY KEY NOT NULL,
	"last_user_id" text,
	"last_employee_id" text,
	"last_position" integer,
	"last_lead_id" text,
	"last_assigned_at" timestamp with time zone,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seeded_from" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_rotation_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action
);--> statement-breakpoint
-- Applications received through the external intake adapter, one row per accepted submission.
-- The SSN is sealed with the vault (only the last four are readable); answers never hold it.
CREATE TABLE IF NOT EXISTS "hiring_external_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"dot_link_id" text NOT NULL,
	"provider" text NOT NULL,
	"submission_key" text NOT NULL,
	"reference" text NOT NULL,
	"answers" jsonb NOT NULL,
	"authorizations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ssn_sealed" jsonb,
	"ssn_last4" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" text,
	"ip_hash" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_external_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_external_applications_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_external_applications_link_fk" FOREIGN KEY ("dot_link_id") REFERENCES "public"."hiring_dot_links"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_external_applications_key" ON "hiring_external_applications" USING btree ("company_id","provider","submission_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_external_applications_link_key" ON "hiring_external_applications" USING btree ("dot_link_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_external_applications_case_idx" ON "hiring_external_applications" USING btree ("company_id","hiring_case_id");
