-- Company info (owner, 2026-10-19): the carrier's own profile and papers. New tables only.
CREATE TABLE IF NOT EXISTS "company_profiles" (
  "company_id" text PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "record" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "company_documents" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "kind" text NOT NULL,
  "title" text DEFAULT '' NOT NULL,
  "file_id" text NOT NULL,
  "file_name" text DEFAULT '' NOT NULL,
  "issued_on" date,
  "expires_on" date,
  "note" text,
  "uploaded_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "voided_at" timestamp with time zone,
  "voided_by" text,
  "void_reason" text
);
CREATE INDEX IF NOT EXISTS "company_documents_company_kind_idx" ON "company_documents" ("company_id", "kind");
