-- PTI weeks run Sunday to Saturday (owner, 2026-10-18); they ran Monday to Sunday before.
-- Each Monday-keyed week moves to the Sunday before it. The due day stays the same Wednesday.
UPDATE "pti_inspections" AS p
SET "week_start" = p."week_start" - 1, "updated_at" = now()
WHERE EXTRACT(DOW FROM p."week_start") = 1
  AND NOT EXISTS (
    SELECT 1 FROM "pti_inspections" q
    WHERE q."company_id" = p."company_id" AND q."unit_id" = p."unit_id" AND q."week_start" = p."week_start" - 1
  );
