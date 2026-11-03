-- 0080: DOT driver application v2 completion (owner, 2026-10-27). Additive only.
-- The ACH debit authorization (WB-hir p.6): the routing and account numbers are sealed like the SSN
-- (credential vault, purpose pii) and never kept in the answers; only the account's last 4 are shown.
ALTER TABLE "dot_driver_applications" ADD COLUMN IF NOT EXISTS "bank_sealed" jsonb;
--> statement-breakpoint
ALTER TABLE "dot_driver_applications" ADD COLUMN IF NOT EXISTS "bank_last4" text;
--> statement-breakpoint
-- The prospective employer's confidential fax number printed on the SPH request (company-level, set by Safety).
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "sph_confidential_fax" text;
