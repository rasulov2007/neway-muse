-- 0079: DOT driver application v2 + shared email log (owner brief, 2026-10-27). Additive only:
-- new tables and two nullable columns on companies; nothing existing is rewritten or dropped.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "recruiting_reply_to" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "accounting_reply_to" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_document_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "doc_key" text NOT NULL,
  "version" text NOT NULL,
  "title" text NOT NULL,
  "content" jsonb NOT NULL,
  "source_file_name" text,
  "source_storage_key" text,
  "source_sha256" text,
  "content_sha256" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "note" text,
  "created_by_user_id" text NOT NULL,
  "created_by_name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "approved_by_user_id" text,
  "approved_by_name" text,
  "approved_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  "retired_by_name" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "application_document_templates_version_uq" ON "application_document_templates" ("company_id", "doc_key", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "application_document_templates_approved_uq" ON "application_document_templates" ("company_id", "doc_key") WHERE status = 'approved';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_document_templates_company_idx" ON "application_document_templates" ("company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dot_driver_applications" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "subject_key" text NOT NULL,
  "lead_id" text,
  "hiring_case_id" text,
  "driver_id" text,
  "candidate_name" text NOT NULL,
  "candidate_email" text,
  "status" text DEFAULT 'sent' NOT NULL,
  "template_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "prefill" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "ssn_sealed" jsonb,
  "ssn_last4" text,
  "version" integer DEFAULT 1 NOT NULL,
  "first_opened_at" timestamp with time zone,
  "last_saved_at" timestamp with time zone,
  "submitted_at" timestamp with time zone,
  "submit_count" integer DEFAULT 0 NOT NULL,
  "review_started_at" timestamp with time zone,
  "review_started_by_name" text,
  "employer_forms" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "internal_note" text,
  "approved_at" timestamp with time zone,
  "approved_by_user_id" text,
  "approved_by_name" text,
  "rejected_at" timestamp with time zone,
  "rejected_by_name" text,
  "rejected_reason" text,
  "hired_at" timestamp with time zone,
  "hired_by_name" text,
  "roster_driver_id" text,
  "created_by_user_id" text NOT NULL,
  "created_by_name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_driver_applications_subject_uq" ON "dot_driver_applications" ("company_id", "subject_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dot_driver_applications_status_idx" ON "dot_driver_applications" ("company_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dot_application_links" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "application_id" text NOT NULL REFERENCES "dot_driver_applications"("id") ON DELETE RESTRICT,
  "token_hash" text NOT NULL,
  "email" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by_name" text,
  "revoked_reason" text,
  "emailed_at" timestamp with time zone,
  "copied_at" timestamp with time zone,
  "first_opened_at" timestamp with time zone,
  "last_opened_at" timestamp with time zone,
  "code_hash" text,
  "code_expires_at" timestamp with time zone,
  "code_sent_at" timestamp with time zone,
  "code_failures" integer DEFAULT 0 NOT NULL,
  "paused_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "created_by_user_id" text NOT NULL,
  "created_by_name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_application_links_token_uq" ON "dot_application_links" ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_application_links_live_uq" ON "dot_application_links" ("application_id") WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dot_application_links_app_idx" ON "dot_application_links" ("application_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dot_application_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "link_id" text NOT NULL REFERENCES "dot_application_links"("id") ON DELETE RESTRICT,
  "application_id" text NOT NULL,
  "session_hash" text NOT NULL,
  "ip" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_application_sessions_hash_uq" ON "dot_application_sessions" ("session_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dot_application_sessions_link_idx" ON "dot_application_sessions" ("link_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dot_application_signatures" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "application_id" text NOT NULL REFERENCES "dot_driver_applications"("id") ON DELETE RESTRICT,
  "doc_key" text NOT NULL,
  "doc_version" text NOT NULL,
  "signer_role" text NOT NULL,
  "signer_name" text NOT NULL,
  "signer_user_id" text,
  "signer_title" text,
  "typed_name" text NOT NULL,
  "esign_consent" boolean NOT NULL,
  "image_storage_key" text NOT NULL,
  "image_sha256" text NOT NULL,
  "evidence_sha256" text NOT NULL,
  "content_sha256" text,
  "ip" text,
  "user_agent" text,
  "signed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "superseded_at" timestamp with time zone,
  "superseded_reason" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dot_application_signatures_app_idx" ON "dot_application_signatures" ("application_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dot_application_signatures_current_uq" ON "dot_application_signatures" ("application_id", "doc_key") WHERE superseded_at IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dot_application_files" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "application_id" text NOT NULL REFERENCES "dot_driver_applications"("id") ON DELETE RESTRICT,
  "slot" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage_key" text NOT NULL,
  "sha256" text NOT NULL,
  "source" text DEFAULT 'driver' NOT NULL,
  "uploaded_by_name" text,
  "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "removed_at" timestamp with time zone,
  "removed_reason" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dot_application_files_app_idx" ON "dot_application_files" ("application_id", "slot");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dot_application_change_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "application_id" text NOT NULL REFERENCES "dot_driver_applications"("id") ON DELETE RESTRICT,
  "sections" jsonb NOT NULL,
  "message" text NOT NULL,
  "requested_by_user_id" text NOT NULL,
  "requested_by_name" text NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dot_application_change_requests_app_idx" ON "dot_application_change_requests" ("application_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "to_address" text NOT NULL,
  "from_address" text NOT NULL,
  "reply_to" text,
  "subject" text NOT NULL,
  "provider" text NOT NULL,
  "provider_message_id" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "entity_type" text,
  "entity_id" text,
  "events" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "bounced_at" timestamp with time zone,
  "complained_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_messages_entity_idx" ON "email_messages" ("company_id", "entity_type", "entity_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_messages_provider_uq" ON "email_messages" ("provider_message_id") WHERE provider_message_id IS NOT NULL;
