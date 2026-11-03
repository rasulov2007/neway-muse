-- Claim lines (Claims v2 §2.2, owner 2026-10-14): one incident, many claims. The New claim dialog
-- ticks the kinds; each becomes a line on the one claim file. Additive: one table.
CREATE TABLE IF NOT EXISTS "safety_claim_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
	"claim_id" text NOT NULL REFERENCES "safety_claims"("id") ON DELETE RESTRICT,
	"kind" text NOT NULL,
	"status" text DEFAULT 'not_filed' NOT NULL,
	"insurer" text,
	"reserve_cents" bigint,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "safety_claim_lines_kind_key" ON "safety_claim_lines" ("company_id", "claim_id", "kind") WHERE "voided_at" IS NULL;
