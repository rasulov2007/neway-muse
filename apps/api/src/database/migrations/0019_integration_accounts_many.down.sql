-- Reverses 0019_integration_accounts_many.sql.
--
-- The unique index is put back last, and it will refuse to be created while a company holds more
-- than one account for the same provider. That is the right refusal: the operator decides which
-- of the two rows survives; this file does not delete either of them.
DROP INDEX IF EXISTS "trucks_telematics_external_idx";
ALTER TABLE "trucks" DROP COLUMN IF EXISTS "telematics_synced_at";
ALTER TABLE "trucks" DROP COLUMN IF EXISTS "telematics_external_id";
ALTER TABLE "trucks" DROP COLUMN IF EXISTS "telematics_account_id";

ALTER TABLE "integration_sync_runs" DROP COLUMN IF EXISTS "summary";

ALTER TABLE "integration_accounts" DROP COLUMN IF EXISTS "last_summary";
ALTER TABLE "integration_accounts" DROP COLUMN IF EXISTS "external_name";

DROP INDEX IF EXISTS "integration_accounts_company_provider_idx";
CREATE UNIQUE INDEX "integration_accounts_company_provider_key"
  ON "integration_accounts" ("company_id", "provider");
