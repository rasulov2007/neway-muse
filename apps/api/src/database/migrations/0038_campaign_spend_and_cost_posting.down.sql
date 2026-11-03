-- Rolls back 0038. Dated spend entries are dropped with their table; `hiring_campaigns.spend`
-- was kept equal to the live entries' sum, so the older code reads the right totals again. The
-- Accounting expenses that candidate costs posted stay in Accounting (voided or not) - only the
-- posting markers on the cost rows go; `accounting_expense_id` (0037) keeps the link.
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "accounting_post_note";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "accounting_posted_by";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "accounting_posted_at";
DROP INDEX IF EXISTS "hiring_campaign_spend_client_key";
DROP INDEX IF EXISTS "hiring_campaign_spend_campaign_idx";
DROP TABLE IF EXISTS "hiring_campaign_spend";
