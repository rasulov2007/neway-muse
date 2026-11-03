-- Violations (owner, 2026-10-12): what the paper was (inspection, citation or warning), and a fine
-- that does not apply (N/A) told apart from an amount nobody entered. Additive: two columns.
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "violation_type" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "fine_not_applicable" boolean DEFAULT false NOT NULL;
