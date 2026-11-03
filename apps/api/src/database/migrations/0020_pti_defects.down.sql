-- Reverses 0020_pti_defects.sql.
--
-- Drops only what that file created, children first. The workspace blob's ws2-ptirecords was
-- never written by this migration or by the backfill, so the screens that read it are unaffected
-- and nothing the carrier typed is lost.
DROP TABLE IF EXISTS "pti_defect_history";
DROP TABLE IF EXISTS "pti_defects";
DROP TABLE IF EXISTS "pti_inspections";
