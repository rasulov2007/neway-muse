-- Consent safety questions (owner, 2026-10-13): the eight answers as given, and whether any was
-- Yes (an automatic disqualification under the company's policy). Additive: two columns.
ALTER TABLE "hiring_consents" ADD COLUMN IF NOT EXISTS "safety_answers" jsonb;
ALTER TABLE "hiring_consents" ADD COLUMN IF NOT EXISTS "safety_disqualified" boolean DEFAULT false NOT NULL;
