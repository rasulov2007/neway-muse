ALTER TABLE "safety_claims" DROP COLUMN IF EXISTS "last_activity_at";
ALTER TABLE "safety_claims" DROP COLUMN IF EXISTS "liability_pct";
ALTER TABLE "safety_claims" DROP COLUMN IF EXISTS "liability_party";
DROP TABLE IF EXISTS "safety_driver_charges";
