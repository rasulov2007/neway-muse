CREATE TABLE "compliance_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"owner_label" text NOT NULL,
	"requirement_code" text NOT NULL,
	"title" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"storage_key" text,
	"issued_on" date,
	"expires_on" date,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"source" text DEFAULT 'staff' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"rejection_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_document_id" text,
	"contains_pii" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"consent_request_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"actor" text NOT NULL,
	"note" text,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"driver_name" text NOT NULL,
	"purpose" text NOT NULL,
	"requirement_code" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by" text NOT NULL,
	"sent_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"signer_name" text,
	"signer_channel" text,
	"signed_document_id" text
);
--> statement-breakpoint
CREATE TABLE "qualification_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"requirement_code" text NOT NULL,
	"scope" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_label" text NOT NULL,
	"document_id" text,
	"issued_on" date,
	"expires_on" date,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"verification_failed" boolean DEFAULT false NOT NULL,
	"verification_note" text,
	"waived_until" date,
	"waived_reason" text,
	"not_applicable" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"driver_name" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_id" text NOT NULL,
	"owner_name" text NOT NULL,
	"safety_review_status" text DEFAULT 'not_started' NOT NULL,
	"safety_review_at" timestamp with time zone,
	"safety_review_by" text,
	"decision" text,
	"decision_at" timestamp with time zone,
	"decision_by" text,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hiring_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"applicant_id" text,
	"driver_id" text,
	"verification_case_id" text,
	"candidate_name" text NOT NULL,
	"state" text NOT NULL,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"end_reason" text,
	"end_note" text,
	"recruiter_id" text,
	"recruiter_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hiring_stage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"case_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"by_id" text,
	"by_name" text NOT NULL,
	"reason" text,
	"note" text,
	"source" text DEFAULT 'user' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_consent_request_id_consent_requests_id_fk" FOREIGN KEY ("consent_request_id") REFERENCES "public"."consent_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_items" ADD CONSTRAINT "qualification_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_cases" ADD CONSTRAINT "verification_cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD CONSTRAINT "hiring_cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD CONSTRAINT "hiring_cases_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_cases" ADD CONSTRAINT "hiring_cases_verification_case_id_verification_cases_id_fk" FOREIGN KEY ("verification_case_id") REFERENCES "public"."verification_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_stage_events" ADD CONSTRAINT "hiring_stage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_stage_events" ADD CONSTRAINT "hiring_stage_events_case_id_hiring_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."hiring_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_documents_owner_idx" ON "compliance_documents" USING btree ("company_id","owner_type","owner_id","requirement_code");--> statement-breakpoint
CREATE INDEX "compliance_documents_status_idx" ON "compliance_documents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "consent_events_request_idx" ON "consent_events" USING btree ("consent_request_id","sort_order");--> statement-breakpoint
CREATE INDEX "consent_requests_driver_idx" ON "consent_requests" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "consent_requests_status_idx" ON "consent_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "qualification_items_entity_requirement_key" ON "qualification_items" USING btree ("company_id","scope","entity_id","requirement_code");--> statement-breakpoint
CREATE INDEX "qualification_items_entity_idx" ON "qualification_items" USING btree ("company_id","scope","entity_id");--> statement-breakpoint
CREATE INDEX "qualification_items_expires_idx" ON "qualification_items" USING btree ("company_id","expires_on");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_cases_open_driver_key" ON "verification_cases" USING btree ("company_id","driver_id") WHERE "verification_cases"."decision" is null;--> statement-breakpoint
CREATE INDEX "verification_cases_driver_idx" ON "verification_cases" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hiring_cases_verification_case_key" ON "hiring_cases" USING btree ("verification_case_id") WHERE "hiring_cases"."verification_case_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "hiring_cases_applicant_key" ON "hiring_cases" USING btree ("applicant_id") WHERE "hiring_cases"."applicant_id" is not null;--> statement-breakpoint
CREATE INDEX "hiring_cases_state_idx" ON "hiring_cases" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX "hiring_stage_events_case_idx" ON "hiring_stage_events" USING btree ("case_id","at");