-- Hand-run rollback of 0070 (local/staging only; never with v2 claim data that must be kept).
DROP TABLE IF EXISTS "safety_claim_log";
DROP TABLE IF EXISTS "safety_claim_documents";
ALTER TABLE "safety_claim_payments" DROP COLUMN IF EXISTS "paid_at", DROP COLUMN IF EXISTS "party", DROP COLUMN IF EXISTS "direction";
DROP INDEX IF EXISTS "safety_claims_legacy_ref_key";
DROP INDEX IF EXISTS "safety_claims_idempotency_key";
DROP INDEX IF EXISTS "safety_claims_follow_up_idx";
DROP INDEX IF EXISTS "safety_claims_accident_idx";
ALTER TABLE "safety_claims" DROP CONSTRAINT IF EXISTS "safety_claims_workers_comp_restricted";
ALTER TABLE "safety_claims"
  DROP COLUMN IF EXISTS "legacy_payload", DROP COLUMN IF EXISTS "legacy_ref", DROP COLUMN IF EXISTS "idempotency_key",
  DROP COLUMN IF EXISTS "next_follow_up_what", DROP COLUMN IF EXISTS "next_follow_up_assignee_name", DROP COLUMN IF EXISTS "next_follow_up_assignee_id",
  DROP COLUMN IF EXISTS "next_follow_up_at", DROP COLUMN IF EXISTS "restricted_reason", DROP COLUMN IF EXISTS "restricted", DROP COLUMN IF EXISTS "disputed",
  DROP COLUMN IF EXISTS "settlement_cents", DROP COLUMN IF EXISTS "reserve_cents", DROP COLUMN IF EXISTS "reported_to_insurer_at", DROP COLUMN IF EXISTS "opened_at",
  DROP COLUMN IF EXISTS "unit_label", DROP COLUMN IF EXISTS "responsible_party", DROP COLUMN IF EXISTS "claimant", DROP COLUMN IF EXISTS "what_was_lost",
  DROP COLUMN IF EXISTS "standalone_kind", DROP COLUMN IF EXISTS "title", DROP COLUMN IF EXISTS "status", DROP COLUMN IF EXISTS "claim_type";
