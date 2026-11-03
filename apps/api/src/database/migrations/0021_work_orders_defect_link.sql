-- A work order remembers the defect it was opened for (brief §4.5, WP6).
--
-- The link is the field, not the sentence in the notes: the defect carries work_order_id, the
-- work order carries defect_id, and a page can walk either way. Nullable, because most work
-- orders are not raised from a walk-around. Nothing existing is touched.
ALTER TABLE work_orders ADD COLUMN defect_id text;

CREATE INDEX work_orders_defect_idx ON work_orders (company_id, defect_id) WHERE defect_id IS NOT NULL;
