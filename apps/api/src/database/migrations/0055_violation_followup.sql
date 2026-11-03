-- Violations follow-up (owner, 2026-10-13): the citation and court details, the lawyer, the
-- driver's training, the charge or bonus sent to Accounting, and the notes - all on the row.
-- Additive only: new columns with defaults; nothing existing changes.
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "citation_number" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "state" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "inspection_level" integer;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "dispute" boolean DEFAULT false NOT NULL;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "lawyer_name" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "lawyer_phone" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "lawyer_fee_cents" bigint;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "lawyer_paid" boolean DEFAULT false NOT NULL;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "training_status" text DEFAULT 'pending' NOT NULL;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "training_completed_on" date;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "trainer_name" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "training_proof_file_id" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "followup_status" text DEFAULT 'undecided' NOT NULL;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "money_kind" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "money_cents" bigint;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "money_party" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "money_reason" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "money_tx_id" text;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "money_sent_at" timestamp with time zone;
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "notes" jsonb DEFAULT '[]'::jsonb NOT NULL;
