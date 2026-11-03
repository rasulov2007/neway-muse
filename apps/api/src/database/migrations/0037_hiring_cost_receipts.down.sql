-- Rolls back 0037. Receipts stay in stored_files; only the links on the cost rows go.
DROP INDEX IF EXISTS "hiring_cost_entries_expense_key";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "void_reason";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "voided_by";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "voided_at";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "accounting_expense_id";
ALTER TABLE "hiring_cost_entries" DROP COLUMN IF EXISTS "receipt_file_id";
