-- A carrier may hold several accounts with one provider: two Samsara organisations under one
-- company are two rows, each with its own token, status and sync state.
DROP INDEX IF EXISTS "integration_accounts_company_provider_key";
CREATE INDEX IF NOT EXISTS "integration_accounts_company_provider_idx"
  ON "integration_accounts" ("company_id", "provider");

-- What the provider calls the organisation behind the token, once it has answered.
ALTER TABLE "integration_accounts" ADD COLUMN IF NOT EXISTS "external_name" text;
-- The counts from the last run, so the account can say what it did without a join.
ALTER TABLE "integration_accounts" ADD COLUMN IF NOT EXISTS "last_summary" jsonb;

-- What one run did, kept with the run.
ALTER TABLE "integration_sync_runs" ADD COLUMN IF NOT EXISTS "summary" jsonb;

-- A truck remembers which provider vehicle, in which account, it is.
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "telematics_account_id" text;
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "telematics_external_id" text;
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "telematics_synced_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "trucks_telematics_external_idx"
  ON "trucks" ("company_id", "telematics_account_id", "telematics_external_id");
