-- Accident & Claims v2, phase P4 — investigation, evidence and restricted data (docs/accidents/IMPLEMENTATION-PLAN.md §4,
-- SPEC §1.4 Investigation / Evidence, §8.2–8.3). ADDITIVE ONLY: new tables, new nullable columns (or a constant
-- default), new triggers that only refuse what was never allowed (a hard delete of case evidence, changing an immutable
-- version, removal under legal hold). No DROP, no RENAME, no type change, no value changed.
-- Determinations (fault, preventability, CPDP) already live on safety_accidents (0069) and legal liability in
-- accident_restricted (0069); corrective actions stay safety_reviews rows (owner decision Q3).

-- ---------------------------------------------------------------------------------------- 1. parties
CREATE TABLE IF NOT EXISTS "accident_other_vehicles" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text NOT NULL REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "description" text NOT NULL,
  "owner_name" text,
  "driver_name" text,
  "insurer" text,
  "policy_no" text,
  "plate" text,
  "damage" text,
  "towed" text CHECK ("towed" IN ('yes','no','unknown','na')),
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "accident_other_vehicles_accident_idx" ON "accident_other_vehicles" ("company_id", "accident_id");

-- A witness's contact is restricted: the API redacts it for a viewer without accidents.restricted.
CREATE TABLE IF NOT EXISTS "accident_witnesses" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text NOT NULL REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "name" text NOT NULL,
  "contact" text,
  "note" text,
  "statement_document_id" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "accident_witnesses_accident_idx" ON "accident_witnesses" ("company_id", "accident_id");

-- ---------------------------------------------------------------------------------------- 2. investigation records
CREATE TABLE IF NOT EXISTS "accident_facts" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text NOT NULL REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "text" text NOT NULL,
  "source" text NOT NULL,
  "provenance" text NOT NULL CHECK ("provenance" IN ('verified','driver','preliminary')),
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "accident_facts_accident_idx" ON "accident_facts" ("company_id", "accident_id", "created_at");

CREATE TABLE IF NOT EXISTS "accident_questions" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text NOT NULL REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "text" text NOT NULL,
  "owner_id" text,
  "owner_name" text,
  "answer" text,
  "resolved_at" timestamp with time zone,
  "resolved_by" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CHECK (("resolved_at" IS NULL) = ("answer" IS NULL))
);
CREATE INDEX IF NOT EXISTS "accident_questions_accident_idx" ON "accident_questions" ("company_id", "accident_id", "created_at");

CREATE TABLE IF NOT EXISTS "accident_statements" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text NOT NULL REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "party" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('Driver','Witness','Third party','Police')),
  "taken_at" timestamp with time zone NOT NULL,
  "taken_by" text NOT NULL,
  "summary" text NOT NULL,
  "document_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "accident_statements_accident_idx" ON "accident_statements" ("company_id", "accident_id", "taken_at");

CREATE TABLE IF NOT EXISTS "accident_factors" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text NOT NULL REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "category" text NOT NULL CHECK ("category" IN ('Driver','Vehicle','Environment','Other party','Operational')),
  "label" text NOT NULL,
  "level" text DEFAULT 'possible' NOT NULL CHECK ("level" IN ('possible','confirmed','ruled_out')),
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "accident_factors_accident_idx" ON "accident_factors" ("company_id", "accident_id", "created_at");

-- "Evidence reviewed" checklist.
CREATE TABLE IF NOT EXISTS "accident_review_items" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "accident_id" text NOT NULL REFERENCES "safety_accidents"("id") ON DELETE restrict,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL CHECK ("state" IN ('pending','requested','reviewed','not_available')),
  "note" text,
  "restricted" boolean DEFAULT false NOT NULL,
  "sort" integer DEFAULT 0 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "accident_review_items_key" ON "accident_review_items" ("company_id", "accident_id", "key");

-- ---------------------------------------------------------------------------------------- 3. restricted-access log
-- Every successful read of restricted data by a permitted user (SPEC §8.3, ACCEPTANCE K7). Append-only.
CREATE TABLE IF NOT EXISTS "restricted_access_log" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_id" text NOT NULL,
  "actor_name" text,
  "accident_id" text,
  "claim_id" text,
  "resource" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "restricted_access_log_idx" ON "restricted_access_log" ("company_id", "at" DESC);

-- ---------------------------------------------------------------------------------------- 4. evidence versions
-- A new upload of a document is a new immutable row; earlier versions stay downloadable. Version 1 of a document
-- written before P4 is its own safety_case_documents file (no row here).
ALTER TABLE "safety_case_documents"
  ADD COLUMN IF NOT EXISTS "current_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "sha256" text;

CREATE TABLE IF NOT EXISTS "safety_document_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "document_id" text NOT NULL REFERENCES "safety_case_documents"("id") ON DELETE restrict,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "file_id" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer DEFAULT 0 NOT NULL,
  "sha256" text NOT NULL,
  "note" text,
  "uploaded_by" text NOT NULL,
  "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "safety_document_versions_key" ON "safety_document_versions" ("document_id", "version");

CREATE OR REPLACE FUNCTION "safety_document_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('neway.workspace_reset', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'safety_document_versions rows are immutable (% blocked)', TG_OP;
END
$fn$;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'safety_document_versions_no_change') THEN
    CREATE TRIGGER "safety_document_versions_no_change" BEFORE UPDATE OR DELETE ON "safety_document_versions"
      FOR EACH ROW EXECUTE FUNCTION "safety_document_versions_immutable"();
  END IF;
END
$do$;

-- Evidence on an accident or a claim is never hard-deleted and never moved to another record; under a legal hold on the
-- accident it cannot be removed (voided) either. The whole-workspace reset is the one exception (as for the timeline).
CREATE OR REPLACE FUNCTION "safety_case_documents_protect"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF coalesce(current_setting('neway.workspace_reset', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND OLD."case_type" IN ('accident', 'claim') THEN
    RAISE EXCEPTION 'Evidence on an accident or claim cannot be deleted; remove it with a reason instead';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."case_type" IN ('accident', 'claim')
     AND (NEW."case_id" IS DISTINCT FROM OLD."case_id" OR NEW."case_type" IS DISTINCT FROM OLD."case_type") THEN
    RAISE EXCEPTION 'Evidence cannot be moved off its accident or claim';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."voided_at" IS NOT NULL AND OLD."voided_at" IS NULL AND NEW."case_type" = 'accident'
     AND EXISTS (SELECT 1 FROM "safety_accidents" a WHERE a."id" = NEW."case_id" AND a."legal_hold_since" IS NOT NULL) THEN
    RAISE EXCEPTION 'Legal hold: evidence on this accident cannot be removed';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fn$;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'safety_case_documents_protect_evidence') THEN
    CREATE TRIGGER "safety_case_documents_protect_evidence" BEFORE UPDATE OR DELETE ON "safety_case_documents"
      FOR EACH ROW EXECUTE FUNCTION "safety_case_documents_protect"();
  END IF;
END
$do$;
