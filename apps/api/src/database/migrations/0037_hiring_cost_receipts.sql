-- Recruiting redesign (2026-10-01): candidate costs carry a receipt, can point at the Accounting
-- expense that already booked them, and are voided rather than deleted. Additive and nullable;
-- existing rows are untouched. `0037_hiring_cost_receipts.down.sql` removes the columns.
--
--   receipt_file_id        the stored_files row holding the receipt (company-scoped by the API)
--   accounting_expense_id  an acct_expenses row this cost is attributed from; one candidate cost
--                          per expense, so the same booked dollar is never counted twice
--   voided_at/_by/_reason  a mistaken manual entry, or an automatic one whose source record was
--                          corrected, is hidden from totals and kept with who, when and why
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "receipt_file_id" text;
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "accounting_expense_id" text;
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "voided_at" timestamptz;
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "voided_by" text;
ALTER TABLE "hiring_cost_entries" ADD COLUMN IF NOT EXISTS "void_reason" text;
CREATE UNIQUE INDEX IF NOT EXISTS "hiring_cost_entries_expense_key"
  ON "hiring_cost_entries" ("company_id", "accounting_expense_id")
  WHERE "accounting_expense_id" IS NOT NULL AND "voided_at" IS NULL;
