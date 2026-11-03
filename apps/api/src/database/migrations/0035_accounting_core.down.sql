-- Rolls the accounting tables back. Posted finance data lives here: export it first
-- (GET /accounting/export/ledger.csv) and never run this against a company that has invoiced.
DROP TABLE IF EXISTS "acct_billing_exceptions";
DROP TABLE IF EXISTS "acct_deliveries";
DROP TABLE IF EXISTS "acct_import_records";
DROP TABLE IF EXISTS "acct_staff_pay_plans";
DROP TABLE IF EXISTS "acct_payroll_periods";
DROP TABLE IF EXISTS "acct_payment_batches";
DROP TABLE IF EXISTS "acct_payee_profiles";
DROP TABLE IF EXISTS "acct_settlements";
DROP TABLE IF EXISTS "acct_settlement_batches";
DROP TABLE IF EXISTS "acct_vendor_arrangements";
DROP TABLE IF EXISTS "acct_recurring_deductions";
DROP TABLE IF EXISTS "acct_driver_transactions";
DROP TABLE IF EXISTS "acct_driver_profiles";
DROP TABLE IF EXISTS "acct_expenses";
DROP TABLE IF EXISTS "acct_bills";
DROP TABLE IF EXISTS "acct_payments";
DROP TABLE IF EXISTS "acct_invoices";
DROP TABLE IF EXISTS "acct_journal_entries";
DROP TABLE IF EXISTS "acct_ledger_periods";
DROP TABLE IF EXISTS "acct_settings";
