DROP TABLE IF EXISTS "hiring_safety_checks";
DROP TABLE IF EXISTS "hiring_link_deliveries";
DROP TABLE IF EXISTS "sms_preferences";
ALTER TABLE "hiring_consent_documents" DROP COLUMN IF EXISTS "valid_until";
ALTER TABLE "hiring_consent_documents" DROP COLUMN IF EXISTS "scope";
