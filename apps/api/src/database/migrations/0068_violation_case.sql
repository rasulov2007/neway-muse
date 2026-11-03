-- One inspection paper, one case (owner, 2026-10-21). Violations entered together from one paper
-- share a case id; a violation without one is a case of its own. Additive only.
ALTER TABLE "safety_violations" ADD COLUMN IF NOT EXISTS "case_id" text;
CREATE INDEX IF NOT EXISTS "safety_violations_case_idx" ON "safety_violations" ("company_id", "case_id");
