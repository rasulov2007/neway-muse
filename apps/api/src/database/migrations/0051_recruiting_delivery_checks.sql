-- Recruiting integrations (owner brief, 2026-10-11, second part): the consent and application links
-- sent by SMS (Twilio) or email from the TMS, with their delivery results, and the Safety checks
-- (MVR, PSP, Clearinghouse limited and full query) tracked Requested → Pending → Received → Reviewed.
--
-- Additive only: two new tables. Nothing existing changes; it ships with 0050 as one package.
-- Rolling back (0051 .down.sql) drops what this adds.

-- The Clearinghouse limited consent (FMCSA sample, company scope): what each signed document
-- allowed and until when. Nullable; MVR and PSP documents leave both empty.
ALTER TABLE "hiring_consent_documents" ADD COLUMN IF NOT EXISTS "scope" text;
ALTER TABLE "hiring_consent_documents" ADD COLUMN IF NOT EXISTS "valid_until" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "hiring_link_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"lead_id" text,
	"hiring_case_id" text,
	"subject_key" text NOT NULL,
	"link_kind" text NOT NULL,
	"session_id" text NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"provider" text NOT NULL,
	"integration_account_id" text,
	"provider_message_id" text,
	"provider_status" text,
	"error_code" text,
	"error_message" text,
	"resend_of_id" text,
	"created_by_user_id" text NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"status_checked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "hiring_link_deliveries" ADD CONSTRAINT "hiring_link_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "hiring_link_deliveries" ADD CONSTRAINT "hiring_link_deliveries_lead_id_hiring_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."hiring_leads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "hiring_link_deliveries" ADD CONSTRAINT "hiring_link_deliveries_hiring_case_id_hiring_cases_id_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE INDEX IF NOT EXISTS "hiring_link_deliveries_subject_idx" ON "hiring_link_deliveries" USING btree ("company_id","subject_key");
CREATE INDEX IF NOT EXISTS "hiring_link_deliveries_case_idx" ON "hiring_link_deliveries" USING btree ("company_id","hiring_case_id");
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_link_deliveries_provider_key" ON "hiring_link_deliveries" USING btree ("provider","provider_message_id") WHERE "provider_message_id" IS NOT NULL;

-- Texting consent per phone number (company scoped): the opt-in staff recorded, and the person's
-- STOP / START replies. Nobody who replied STOP is texted.
CREATE TABLE IF NOT EXISTS "sms_preferences" (
	"company_id" text NOT NULL,
	"phone" text NOT NULL,
	"status" text NOT NULL,
	"opted_in_at" timestamp with time zone,
	"opted_in_by" text,
	"opted_in_source" text,
	"opted_in_note" text,
	"opted_out_at" timestamp with time zone,
	"opted_out_source" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sms_preferences_pk" PRIMARY KEY("company_id","phone")
);
DO $$ BEGIN
 ALTER TABLE "sms_preferences" ADD CONSTRAINT "sms_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "hiring_safety_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"review_id" text NOT NULL,
	"hiring_case_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"order_ref" text,
	"note" text,
	"requested_at" timestamp with time zone,
	"requested_by_user_id" text,
	"requested_by_name" text,
	"pending_at" timestamp with time zone,
	"pending_by_name" text,
	"received_at" timestamp with time zone,
	"received_by_name" text,
	"report_id" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_name" text,
	"result" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "hiring_safety_checks" ADD CONSTRAINT "hiring_safety_checks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "hiring_safety_checks" ADD CONSTRAINT "hiring_safety_checks_review_id_hiring_safety_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."hiring_safety_reviews"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "hiring_safety_checks" ADD CONSTRAINT "hiring_safety_checks_hiring_case_id_hiring_cases_id_fk" FOREIGN KEY ("hiring_case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_safety_checks_review_kind_key" ON "hiring_safety_checks" USING btree ("review_id","kind");
CREATE INDEX IF NOT EXISTS "hiring_safety_checks_case_idx" ON "hiring_safety_checks" USING btree ("company_id","hiring_case_id");
