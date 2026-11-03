-- Claims v2 phase 1 (owner brief, 2026-10-13): a driver charge raised on a claim, from Safety
-- applying it to the last settlement deduction. The money itself stays Accounting's driver
-- transaction (driver_tx_id), created on approval; this row is the workflow around it.
-- Additive: one table and three claim columns.
CREATE TABLE IF NOT EXISTS "safety_driver_charges" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
	"number" text NOT NULL,
	"source_type" text DEFAULT 'claim' NOT NULL,
	"source_id" text NOT NULL,
	"claim_id" text,
	"claim_number" text,
	"driver_id" text NOT NULL,
	"driver_name" text DEFAULT '' NOT NULL,
	"driver_kind" text DEFAULT 'company' NOT NULL,
	"basis" text NOT NULL,
	"policy_cents" bigint NOT NULL,
	"amount_cents" bigint NOT NULL,
	"adjust_reason" text,
	"state" text NOT NULL,
	"state_before_hold" text,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_on" date,
	"notified_by" text,
	"notify_method" text,
	"driver_response" text,
	"notice_file_id" text,
	"authorization_file_id" text,
	"lease_clause" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"recovery_method" text,
	"installment_cents" bigint,
	"installments_total" integer,
	"driver_tx_id" text,
	"dispute_text" text,
	"dispute_raised_by" text,
	"dispute_resolution" text,
	"pending_change" jsonb,
	"waive_reason" text,
	"waived_by" text,
	"waived_at" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "safety_driver_charges_company_number_key" ON "safety_driver_charges" ("company_id", "number");
-- One live charge per source, driver and basis: a second Apply is refused by the database.
CREATE UNIQUE INDEX IF NOT EXISTS "safety_driver_charges_active_key" ON "safety_driver_charges" ("company_id", "source_type", "source_id", "driver_id", "basis")
	WHERE "state" NOT IN ('rejected', 'waived', 'recovered', 'cancelled');
CREATE INDEX IF NOT EXISTS "safety_driver_charges_driver_idx" ON "safety_driver_charges" ("company_id", "driver_id");
CREATE INDEX IF NOT EXISTS "safety_driver_charges_claim_idx" ON "safety_driver_charges" ("company_id", "claim_id");

ALTER TABLE "safety_claims" ADD COLUMN IF NOT EXISTS "liability_party" text;
ALTER TABLE "safety_claims" ADD COLUMN IF NOT EXISTS "liability_pct" integer;
ALTER TABLE "safety_claims" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;
UPDATE "safety_claims" SET "last_activity_at" = "updated_at";
