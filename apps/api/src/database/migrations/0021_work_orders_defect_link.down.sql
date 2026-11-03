-- Reverses 0021_work_orders_defect_link.sql. Drops the index and the column it added; no row is
-- deleted, and the defect side of the link (pti_defects.work_order_id) is untouched.
DROP INDEX IF EXISTS work_orders_defect_idx;
ALTER TABLE work_orders DROP COLUMN IF EXISTS defect_id;
