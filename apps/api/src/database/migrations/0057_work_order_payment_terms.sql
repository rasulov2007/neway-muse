-- How a work order's invoice is settled (owner, 2026-10-13): 'company_paid' or 'pay_later'.
-- Null on every existing order: nothing was said. Additive.
ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "payment_terms" text;
