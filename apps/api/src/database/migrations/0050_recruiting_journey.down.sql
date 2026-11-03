-- Rolls back 0050. What is lost: every consent link and signed consent (with its disclosure
-- snapshots and CDL front rows; the files stay in storage), every candidate Safety review and
-- report row (the report files stay in the qualification file), the pre-hire onboarding tasks and
-- travel bookings, and the new cost columns (who paid, whose cost, approval, payment, refunds).
-- Take a backup first; nothing here can be undone.

ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "version";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "reimbursement_expense_id";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "driver_transaction_id";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "driver_agreement_at";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "driver_agreement_note";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "nonrefundable_fee";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "refund_amount";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "travel_item_id";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "paid_at";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "payment_status";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "approved_by";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "approved_at";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "approval_status";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "vendor";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "cost_owner";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "paid_by";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "on_hold_reason";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "on_hold_by";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "on_hold_at";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "onboarding_started_by";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "onboarding_started_at";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "application_reviewed_by";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "application_reviewed_at";
DROP TABLE IF EXISTS "hiring_travel_items";
DROP TABLE IF EXISTS "hiring_onboarding_tasks";
DROP TABLE IF EXISTS "hiring_safety_reports";
DROP TABLE IF EXISTS "hiring_safety_reviews";
DROP TABLE IF EXISTS "hiring_consent_files";
DROP TABLE IF EXISTS "hiring_consent_documents";
DROP TABLE IF EXISTS "hiring_consents";
DROP TABLE IF EXISTS "hiring_consent_sessions";
