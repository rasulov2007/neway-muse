-- Hand-run rollback of 0071 (local/staging only; never with v2 data that must be kept).
DROP INDEX IF EXISTS "safety_tasks_work_order_idx";
DROP TABLE IF EXISTS "unit_status_history";
ALTER TABLE "trucks" DROP COLUMN IF EXISTS "daily_contribution_cents";
DROP INDEX IF EXISTS "acct_bills_claim_idx";
DROP INDEX IF EXISTS "acct_bills_accident_idx";
ALTER TABLE "acct_bills" DROP COLUMN IF EXISTS "accident_cost_category", DROP COLUMN IF EXISTS "claim_id", DROP COLUMN IF EXISTS "accident_id";
DROP TABLE IF EXISTS "work_order_estimates";
DROP INDEX IF EXISTS "work_orders_accident_idx";
ALTER TABLE "work_orders"
  DROP COLUMN IF EXISTS "eta", DROP COLUMN IF EXISTS "policy_exception_reason", DROP COLUMN IF EXISTS "approved_at", DROP COLUMN IF EXISTS "approved_by",
  DROP COLUMN IF EXISTS "approved_estimate_id", DROP COLUMN IF EXISTS "approved_cents", DROP COLUMN IF EXISTS "estimates_required", DROP COLUMN IF EXISTS "accident_id";
