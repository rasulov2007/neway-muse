-- Safety cases on the server (Safety v2, owner plan 2026-10-02).
--
-- Accidents, claims (with their payments and the money suggested to Accounting), roadside
-- inspections, violations, safety reviews, drug & alcohol tests and the files attached to any of
-- them. Until now these lived in the browser's workspace snapshot. Production holds no accidents,
-- violations or inspections and one test claim, which stays where it is: nothing is migrated.
--
-- Additive: ten new tables, nothing existing is altered. `0041_safety_cases.down.sql` removes them.
-- Every row carries company_id; every row is versioned; nothing is deleted - a record is voided
-- with a reason, a person and a time.

CREATE TABLE IF NOT EXISTS "safety_counters" (
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "last" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("company_id", "kind")
);

CREATE TABLE IF NOT EXISTS "safety_accidents" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "number" text NOT NULL,
  "owner_id" text,
  "owner_name" text,
  "next_action" text,
  "next_action_due_on" date,
  "is_test" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1,
  "voided_at" timestamptz,
  "voided_by" text,
  "void_reason" text,
  "occurred_at" timestamptz NOT NULL,
  "location" text NOT NULL,
  "city" text,
  "state" text,
  "driver_id" text,
  "driver_name" text,
  "truck_id" text,
  "truck_number" text,
  "trailer_id" text,
  "trailer_number" text,
  "load_id" text,
  "load_number" text,
  "description" text NOT NULL DEFAULT '',
  "fatalities" integer NOT NULL DEFAULT 0,
  "injuries" integer NOT NULL DEFAULT 0,
  "injuries_treated_away" integer NOT NULL DEFAULT 0,
  "disabling_tow" boolean NOT NULL DEFAULT false,
  "citation_issued" boolean NOT NULL DEFAULT false,
  "citation_at" timestamptz,
  "citation_note" text,
  "police_report_number" text,
  "stage" text NOT NULL DEFAULT 'reported',
  "fault" text NOT NULL DEFAULT 'undetermined',
  "preventability" text NOT NULL DEFAULT 'undetermined',
  "preventability_note" text,
  "notes" text,
  "damage_estimate_cents" bigint,
  "company_deductible_cents" bigint,
  "work_order_id" text,
  "work_order_number" text,
  "claim_id" text,
  "claim_number" text,
  "review_id" text,
  "review_number" text,
  "closed_at" timestamptz,
  "closed_by" text,
  "close_kind" text,
  "close_reason" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "safety_accidents_company_number_key" ON "safety_accidents" ("company_id", "number");
CREATE INDEX IF NOT EXISTS "safety_accidents_company_stage_idx" ON "safety_accidents" ("company_id", "stage");
CREATE INDEX IF NOT EXISTS "safety_accidents_driver_idx" ON "safety_accidents" ("company_id", "driver_id");

CREATE TABLE IF NOT EXISTS "safety_claims" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "number" text NOT NULL,
  "owner_id" text,
  "owner_name" text,
  "next_action" text,
  "next_action_due_on" date,
  "is_test" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1,
  "voided_at" timestamptz,
  "voided_by" text,
  "void_reason" text,
  "kind" text NOT NULL,
  "accident_id" text,
  "accident_number" text,
  "load_id" text,
  "load_number" text,
  "driver_id" text,
  "driver_name" text,
  "truck_id" text,
  "truck_number" text,
  "description" text NOT NULL DEFAULT '',
  "insurer" text,
  "policy_number" text,
  "insurer_reference" text,
  "adjuster_name" text,
  "adjuster_phone" text,
  "adjuster_email" text,
  "opened_on" date NOT NULL,
  "submitted_on" date,
  "decision_on" date,
  "decision" text,
  "stage" text NOT NULL DEFAULT 'opened',
  "claimed_cents" bigint,
  "approved_cents" bigint,
  "deductible_cents" bigint,
  "driver_deduction_proposed_cents" bigint,
  "driver_deduction_note" text,
  "closed_at" timestamptz,
  "closed_by" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "safety_claims_company_number_key" ON "safety_claims" ("company_id", "number");
CREATE UNIQUE INDEX IF NOT EXISTS "safety_claims_accident_key" ON "safety_claims" ("company_id", "accident_id") WHERE "accident_id" is not null and "voided_at" is null;
CREATE INDEX IF NOT EXISTS "safety_claims_company_stage_idx" ON "safety_claims" ("company_id", "stage");

CREATE TABLE IF NOT EXISTS "safety_claim_payments" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "claim_id" text NOT NULL REFERENCES "safety_claims"("id") ON DELETE RESTRICT,
  "received_on" date NOT NULL,
  "amount_cents" bigint NOT NULL,
  "method" text,
  "reference" text,
  "note" text,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "voided_at" timestamptz,
  "voided_by" text,
  "void_reason" text
);
CREATE INDEX IF NOT EXISTS "safety_claim_payments_claim_idx" ON "safety_claim_payments" ("company_id", "claim_id");

CREATE TABLE IF NOT EXISTS "safety_accounting_entries" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "claim_id" text NOT NULL REFERENCES "safety_claims"("id") ON DELETE RESTRICT,
  "claim_number" text NOT NULL,
  "kind" text NOT NULL,
  "amount_cents" bigint NOT NULL,
  "state" text NOT NULL DEFAULT 'pending_review',
  "source_key" text NOT NULL,
  "memo" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "reviewed_at" timestamptz,
  "reviewed_by" text,
  "review_note" text,
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "safety_accounting_entries_source_key" ON "safety_accounting_entries" ("company_id", "source_key");
CREATE INDEX IF NOT EXISTS "safety_accounting_entries_state_idx" ON "safety_accounting_entries" ("company_id", "state");

CREATE TABLE IF NOT EXISTS "safety_roadside_inspections" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "number" text NOT NULL,
  "owner_id" text,
  "owner_name" text,
  "next_action" text,
  "next_action_due_on" date,
  "is_test" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1,
  "voided_at" timestamptz,
  "voided_by" text,
  "void_reason" text,
  "inspected_at" timestamptz NOT NULL,
  "level" integer NOT NULL,
  "report_number" text,
  "agency" text NOT NULL,
  "location" text,
  "state" text,
  "driver_id" text,
  "driver_name" text,
  "truck_id" text,
  "truck_number" text,
  "trailer_id" text,
  "trailer_number" text,
  "oos" boolean NOT NULL DEFAULT false,
  "oos_note" text,
  "correction_due_on" date,
  "return_required" boolean NOT NULL DEFAULT false,
  "stage" text NOT NULL DEFAULT 'received',
  "received_at" timestamptz,
  "reviewed_at" timestamptz,
  "corrected_at" timestamptz,
  "certified_at" timestamptz,
  "returned_at" timestamptz,
  "work_order_id" text,
  "work_order_number" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "safety_roadside_company_number_key" ON "safety_roadside_inspections" ("company_id", "number");
CREATE INDEX IF NOT EXISTS "safety_roadside_company_stage_idx" ON "safety_roadside_inspections" ("company_id", "stage");

CREATE TABLE IF NOT EXISTS "safety_violations" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "number" text NOT NULL,
  "owner_id" text,
  "owner_name" text,
  "next_action" text,
  "next_action_due_on" date,
  "is_test" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1,
  "voided_at" timestamptz,
  "voided_by" text,
  "void_reason" text,
  "occurred_at" timestamptz NOT NULL,
  "source" text NOT NULL,
  "inspection_id" text REFERENCES "safety_roadside_inspections"("id") ON DELETE RESTRICT,
  "inspection_number" text,
  "report_number" text,
  "code" text,
  "description" text NOT NULL,
  "category" text,
  "issued_to" text NOT NULL,
  "agency" text NOT NULL,
  "driver_id" text,
  "driver_name" text,
  "truck_id" text,
  "truck_number" text,
  "oos" boolean NOT NULL DEFAULT false,
  "correction_status" text NOT NULL DEFAULT 'not_required',
  "correction_due_on" date,
  "correction_note" text,
  "fine_cents" bigint,
  "court_date" date,
  "citation_disposition" text NOT NULL DEFAULT 'none',
  "dataqs_status" text NOT NULL DEFAULT 'not_filed',
  "dataqs_filed_on" date,
  "dataqs_reference" text,
  "dataqs_note" text,
  "review_id" text,
  "review_number" text,
  "closed_at" timestamptz,
  "closed_by" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "safety_violations_company_number_key" ON "safety_violations" ("company_id", "number");
CREATE INDEX IF NOT EXISTS "safety_violations_inspection_idx" ON "safety_violations" ("company_id", "inspection_id");
CREATE INDEX IF NOT EXISTS "safety_violations_driver_idx" ON "safety_violations" ("company_id", "driver_id");

CREATE TABLE IF NOT EXISTS "safety_reviews" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "number" text NOT NULL,
  "owner_id" text,
  "owner_name" text,
  "next_action" text,
  "next_action_due_on" date,
  "is_test" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1,
  "voided_at" timestamptz,
  "voided_by" text,
  "void_reason" text,
  "kind" text NOT NULL,
  "reason" text NOT NULL,
  "driver_id" text,
  "driver_name" text,
  "linked_type" text,
  "linked_id" text,
  "linked_number" text,
  "status" text NOT NULL DEFAULT 'not_started',
  "scheduled_for" date,
  "preventability_required" boolean NOT NULL DEFAULT false,
  "preventability" text NOT NULL DEFAULT 'undetermined',
  "required_training" text,
  "training_completed_on" date,
  "notes" text,
  "outcome" text,
  "follow_up_on" date,
  "evidence_note" text,
  "completed_at" timestamptz,
  "completed_by" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "safety_reviews_company_number_key" ON "safety_reviews" ("company_id", "number");
CREATE UNIQUE INDEX IF NOT EXISTS "safety_reviews_linked_key" ON "safety_reviews" ("company_id", "kind", "linked_type", "linked_id") WHERE "linked_id" is not null and "voided_at" is null;
CREATE INDEX IF NOT EXISTS "safety_reviews_company_status_idx" ON "safety_reviews" ("company_id", "status");
CREATE INDEX IF NOT EXISTS "safety_reviews_driver_idx" ON "safety_reviews" ("company_id", "driver_id");

CREATE TABLE IF NOT EXISTS "drug_alcohol_tests" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "number" text NOT NULL,
  "owner_id" text,
  "owner_name" text,
  "next_action" text,
  "next_action_due_on" date,
  "is_test" boolean NOT NULL DEFAULT false,
  "created_by" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1,
  "voided_at" timestamptz,
  "voided_by" text,
  "void_reason" text,
  "test_type" text NOT NULL,
  "substance" text NOT NULL,
  "driver_id" text,
  "driver_name" text,
  "accident_id" text REFERENCES "safety_accidents"("id") ON DELETE RESTRICT,
  "accident_number" text,
  "required" boolean NOT NULL DEFAULT true,
  "required_reason" text,
  "occurred_at" timestamptz,
  "scheduled_at" timestamptz,
  "collected_at" timestamptz,
  "result" text NOT NULL DEFAULT 'pending',
  "result_at" timestamptz,
  "not_completed_reason" text,
  "late_reason" text,
  "exception_reviewed_at" timestamptz,
  "exception_reviewed_by" text,
  "exception_note" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "drug_alcohol_tests_company_number_key" ON "drug_alcohol_tests" ("company_id", "number");
CREATE UNIQUE INDEX IF NOT EXISTS "drug_alcohol_tests_accident_key" ON "drug_alcohol_tests" ("company_id", "accident_id", "substance") WHERE "accident_id" is not null and "voided_at" is null;
CREATE INDEX IF NOT EXISTS "drug_alcohol_tests_driver_idx" ON "drug_alcohol_tests" ("company_id", "driver_id");

CREATE TABLE IF NOT EXISTS "safety_case_documents" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "case_type" text NOT NULL,
  "case_id" text NOT NULL,
  "file_id" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL DEFAULT 0,
  "title" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'other',
  "uploaded_by" text NOT NULL DEFAULT '',
  "uploaded_at" timestamptz NOT NULL DEFAULT now(),
  "voided_at" timestamptz,
  "voided_by" text,
  "void_reason" text
);
CREATE INDEX IF NOT EXISTS "safety_case_documents_case_idx" ON "safety_case_documents" ("company_id", "case_type", "case_id");
