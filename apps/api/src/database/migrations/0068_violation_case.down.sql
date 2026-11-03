DROP INDEX IF EXISTS "safety_violations_case_idx";
ALTER TABLE "safety_violations" DROP COLUMN IF EXISTS "case_id";
