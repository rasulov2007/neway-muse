-- The personal driver application (owner brief, 2026-10-08).
--
-- Recruiting issues one private link per lead or candidate; the approved NORTHWIND FREIGHT application
-- page (served at /application/) posts to the same-origin /api/applications. These four tables hold
-- the link sessions (token digest only), the received application (SSN sealed), its documents and
-- each report authorization (MVR and PSP separately, with the drawn signature image kept in
-- private storage and the canonical disclosure text the server verified against).
--
-- Additive only: four new tables, no existing row or column is changed. Rolling back
-- (0049 .down.sql) drops them; see that file for what is lost.

CREATE TABLE IF NOT EXISTS "hiring_application_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"lead_id" text,
	"hiring_case_id" text,
	"subject_key" text NOT NULL,
	"token_hash" text NOT NULL,
	"schema_version" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"link_copied_at" timestamp with time zone,
	"link_copied_by" text,
	"marked_sent_at" timestamp with time zone,
	"marked_sent_by" text,
	"marked_sent_channel" text,
	"submitted_at" timestamp with time zone,
	"submission_id" text,
	"staging_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_application_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_application_sessions_lead_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."hiring_leads"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_application_sessions_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_application_sessions_token_key" ON "hiring_application_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_application_sessions_live_key" ON "hiring_application_sessions" USING btree ("company_id","subject_key") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_application_sessions_case_idx" ON "hiring_application_sessions" USING btree ("company_id","hiring_case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_application_sessions_lead_idx" ON "hiring_application_sessions" USING btree ("company_id","lead_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hiring_driver_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"session_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"lead_id" text,
	"applicant_id" text,
	"driver_id" text NOT NULL,
	"reference" text NOT NULL,
	"submission_key" text NOT NULL,
	"schema_version" text NOT NULL,
	"answers" jsonb NOT NULL,
	"ssn_sealed" jsonb NOT NULL,
	"ssn_last4" text NOT NULL,
	"consent_statement" text NOT NULL,
	"via" text NOT NULL,
	"ip_hash" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_driver_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_driver_applications_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."hiring_application_sessions"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_driver_applications_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_driver_applications_lead_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."hiring_leads"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_driver_applications_session_key" ON "hiring_driver_applications" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_driver_applications_submission_key" ON "hiring_driver_applications" USING btree ("company_id","submission_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_driver_applications_reference_key" ON "hiring_driver_applications" USING btree ("company_id","reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_driver_applications_case_idx" ON "hiring_driver_applications" USING btree ("company_id","hiring_case_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hiring_driver_application_files" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"application_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"code" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"declared_type" text,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"filed_document_id" text,
	"filed_at" timestamp with time zone,
	CONSTRAINT "hiring_driver_application_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_driver_application_files_application_fk" FOREIGN KEY ("application_id") REFERENCES "public"."hiring_driver_applications"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_driver_application_files_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_driver_application_files_code_key" ON "hiring_driver_application_files" USING btree ("application_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_driver_application_files_case_idx" ON "hiring_driver_application_files" USING btree ("company_id","hiring_case_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hiring_driver_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"application_id" text NOT NULL,
	"session_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"document_type" text NOT NULL,
	"decision" text NOT NULL,
	"signer_name" text,
	"printed_signature" text,
	"signature_method" text,
	"electronic_signature" boolean,
	"disclosure_opened_claim" boolean,
	"client_signed_at" text,
	"received_at" timestamp with time zone NOT NULL,
	"disclosure_version" text,
	"disclosure_sha256" text,
	"disclosure_text" text,
	"signature_storage_key" text,
	"signature_sha256" text,
	"signature_bytes" integer,
	"signature_width" integer,
	"signature_height" integer,
	CONSTRAINT "hiring_driver_authorizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_driver_authorizations_application_fk" FOREIGN KEY ("application_id") REFERENCES "public"."hiring_driver_applications"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_driver_authorizations_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_driver_authorizations_type_key" ON "hiring_driver_authorizations" USING btree ("application_id","document_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_driver_authorizations_case_idx" ON "hiring_driver_authorizations" USING btree ("company_id","hiring_case_id");
