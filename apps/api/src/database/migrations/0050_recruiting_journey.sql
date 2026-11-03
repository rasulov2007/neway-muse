-- The recruiting journey (owner brief, 2026-10-11): Lead → Consent → Safety review → Application →
-- Onboarding and costs → Hire → Driver documents.
--
-- Additive only. New tables for the candidate consent (its link sessions, the signed submission, a
-- snapshot of each disclosure as signed, and the CDL front it carried), the candidate Safety review
-- and its reports, the pre-hire onboarding checklist and the travel bookings. Existing tables gain
-- nullable or defaulted columns only: hiring_cases (application reviewed, onboarding started, hold)
-- and hiring_cost_entries (who paid, whose cost, approval and payment, refunds, the accounting
-- records a cost became). No existing row changes meaning; every current lead, case, application
-- and cost reads exactly as before. Rolling back (0050 .down.sql) drops what this adds.

-- ------------------------------------------------------------------------------------- consent

CREATE TABLE IF NOT EXISTS "hiring_consent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"lead_id" text,
	"hiring_case_id" text,
	"subject_key" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	"link_copied_at" timestamp with time zone,
	"link_copied_by" text,
	"emailed_at" timestamp with time zone,
	"emailed_to" text,
	"emailed_by" text,
	"marked_sent_at" timestamp with time zone,
	"marked_sent_by" text,
	"marked_sent_channel" text,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"consent_id" text,
	"staging_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_consent_sessions_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_consent_sessions_lead_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."hiring_leads"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_consent_sessions_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_consent_sessions_token_key" ON "hiring_consent_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_consent_sessions_live_key" ON "hiring_consent_sessions" USING btree ("company_id","subject_key") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_consent_sessions_lead_idx" ON "hiring_consent_sessions" USING btree ("company_id","lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_consent_sessions_case_idx" ON "hiring_consent_sessions" USING btree ("company_id","hiring_case_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hiring_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"session_id" text NOT NULL,
	"lead_id" text,
	"hiring_case_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"reference" text NOT NULL,
	"submission_key" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"confirmation_statement" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"signature_method" text NOT NULL,
	"signature_text" text,
	"signature_storage_key" text,
	"signature_sha256" text,
	"signature_bytes" integer,
	"signature_width" integer,
	"signature_height" integer,
	"client_signed_at" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_sealed" jsonb,
	"ip_hash" text,
	"user_agent" text,
	CONSTRAINT "hiring_consents_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_consents_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."hiring_consent_sessions"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_consents_lead_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."hiring_leads"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_consents_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_consents_session_key" ON "hiring_consents" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_consents_submission_key" ON "hiring_consents" USING btree ("company_id","submission_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_consents_reference_key" ON "hiring_consents" USING btree ("company_id","reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_consents_case_idx" ON "hiring_consents" USING btree ("company_id","hiring_case_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hiring_consent_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"consent_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"document_type" text NOT NULL,
	"disclosure_version" text NOT NULL,
	"disclosure_sha256" text NOT NULL,
	"disclosure_text" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hiring_consent_documents_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_consent_documents_consent_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."hiring_consents"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_consent_documents_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_consent_documents_type_key" ON "hiring_consent_documents" USING btree ("consent_id","document_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_consent_documents_case_idx" ON "hiring_consent_documents" USING btree ("company_id","hiring_case_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hiring_consent_files" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"consent_id" text NOT NULL,
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
	CONSTRAINT "hiring_consent_files_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_consent_files_consent_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."hiring_consents"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_consent_files_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_consent_files_code_key" ON "hiring_consent_files" USING btree ("consent_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_consent_files_case_idx" ON "hiring_consent_files" USING btree ("company_id","hiring_case_id");--> statement-breakpoint

-- --------------------------------------------------------------------------------- safety review

CREATE TABLE IF NOT EXISTS "hiring_safety_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by_user_id" text NOT NULL,
	"opened_by_name" text NOT NULL,
	"request_note" text,
	"fmcsa_full_query_status" text DEFAULT 'not_requested' NOT NULL,
	"fmcsa_full_query_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" text,
	"decided_by_name" text,
	"decision_note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_safety_reviews_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_safety_reviews_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_safety_reviews_case_key" ON "hiring_safety_reviews" USING btree ("company_id","hiring_case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_safety_reviews_status_idx" ON "hiring_safety_reviews" USING btree ("company_id","status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hiring_safety_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"review_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"kind" text NOT NULL,
	"result" text DEFAULT 'pending' NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"document_id" text,
	"file_name" text,
	"received_on" date,
	"note" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"uploaded_by_name" text NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_name" text,
	"review_note" text,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hiring_safety_reports_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_safety_reports_review_fk" FOREIGN KEY ("review_id") REFERENCES "public"."hiring_safety_reviews"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "hiring_safety_reports_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_safety_reports_review_idx" ON "hiring_safety_reports" USING btree ("company_id","review_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------- onboarding, travel

CREATE TABLE IF NOT EXISTS "hiring_onboarding_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"owner_employee_id" text,
	"owner_name" text,
	"due_on" date,
	"completed_at" timestamp with time zone,
	"completed_by_name" text,
	"result" text,
	"evidence_document_id" text,
	"evidence_file_id" text,
	"note" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_onboarding_tasks_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_onboarding_tasks_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_onboarding_tasks_code_key" ON "hiring_onboarding_tasks" USING btree ("company_id","hiring_case_id","code");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hiring_travel_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"vendor" text,
	"route_from" text,
	"route_to" text,
	"booking_reference" text,
	"depart_at" timestamp with time zone,
	"arrive_at" timestamp with time zone,
	"check_in_on" date,
	"check_out_on" date,
	"notes" text,
	"confirmation_file_id" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_name" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hiring_travel_items_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "hiring_travel_items_case_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hiring_travel_items_case_idx" ON "hiring_travel_items" USING btree ("company_id","hiring_case_id");--> statement-breakpoint

-- -------------------------------------------------------------------------- existing tables grow

ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "application_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "application_reviewed_by" text;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "onboarding_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "onboarding_started_by" text;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "on_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "on_hold_by" text;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD COLUMN IF NOT EXISTS "on_hold_reason" text;--> statement-breakpoint

-- Costs: who paid, whose cost it is, and where it stands. Existing rows are company expenses paid by
-- the company and already approved (that is what entering them meant); payment stays as recorded.
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "paid_by" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "cost_owner" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "vendor" text;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "approval_status" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "approved_by" text;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "payment_status" text DEFAULT 'unpaid' NOT NULL;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "travel_item_id" text;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "refund_amount" numeric(12, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "nonrefundable_fee" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "driver_agreement_note" text;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "driver_agreement_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "driver_transaction_id" text;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "reimbursement_expense_id" text;--> statement-breakpoint
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
