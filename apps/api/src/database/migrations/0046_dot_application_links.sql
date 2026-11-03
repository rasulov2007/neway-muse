-- The DOT application sent to the driver (owner, 2026-10-07). A recruiter makes a private link for
-- one hiring case; the driver fills the application in on a phone, submits it and uploads the CDL.
-- Only the SHA-256 digest of the token is kept. One live link per case: a new one turns the old
-- one off (revoked_at), and nothing is ever deleted.
-- Additive only: one new table. No existing row is touched.
CREATE TABLE IF NOT EXISTS "hiring_dot_links" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"last_saved_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"cdl_uploaded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hiring_dot_links" ADD CONSTRAINT "hiring_dot_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_dot_links" ADD CONSTRAINT "hiring_dot_links_hiring_case_id_hiring_cases_id_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_dot_links_token_key" ON "hiring_dot_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_dot_links_live_key" ON "hiring_dot_links" USING btree ("hiring_case_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_dot_links_case_idx" ON "hiring_dot_links" USING btree ("company_id","hiring_case_id","created_at");
--> statement-breakpoint
-- The review gate (owner, 2026-10-07). A driver's Submit through the link is their certification:
-- it is frozen as submitted (who signed, when, the exact answers) with status 'driver_submitted',
-- and nothing reaches the qualification file until a recruiter accepts it. A return to the driver
-- moves the certification into the history; it is never deleted.
ALTER TABLE "hiring_dot_applications" ADD COLUMN IF NOT EXISTS "submitted_via" text;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD COLUMN IF NOT EXISTS "certified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD COLUMN IF NOT EXISTS "certified_name" text;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD COLUMN IF NOT EXISTS "certified_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD COLUMN IF NOT EXISTS "certification_history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD COLUMN IF NOT EXISTS "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD COLUMN IF NOT EXISTS "returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD COLUMN IF NOT EXISTS "returned_by" text;--> statement-breakpoint
ALTER TABLE "hiring_dot_applications" ADD COLUMN IF NOT EXISTS "return_note" text;--> statement-breakpoint
-- CDL files a driver sends before the recruiter accepts: kept privately against the link and
-- filed into the candidate's documents on Accept. Superseded, never deleted.
CREATE TABLE IF NOT EXISTS "hiring_dot_link_files" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"link_id" text NOT NULL,
	"code" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"expires_on" date,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"filed_at" timestamp with time zone,
	"filed_document_id" text
);
--> statement-breakpoint
ALTER TABLE "hiring_dot_link_files" ADD CONSTRAINT "hiring_dot_link_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_dot_link_files" ADD CONSTRAINT "hiring_dot_link_files_hiring_case_id_hiring_cases_id_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_dot_link_files" ADD CONSTRAINT "hiring_dot_link_files_link_id_hiring_dot_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."hiring_dot_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_dot_link_files_case_idx" ON "hiring_dot_link_files" USING btree ("company_id","hiring_case_id");
