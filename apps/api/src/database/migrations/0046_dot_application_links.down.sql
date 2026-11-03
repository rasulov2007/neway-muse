-- Reverts 0046 completely: the staged driver files, the links, and the review-gate columns.
-- Data lost: every link (digests only), staged CDL files' rows (their bytes stay in storage under
-- dot-link/<company>/), and the frozen driver certifications not yet accepted.
DROP TABLE IF EXISTS "hiring_dot_link_files";
DROP TABLE IF EXISTS "hiring_dot_links";
ALTER TABLE "hiring_dot_applications" DROP COLUMN IF EXISTS "return_note";
ALTER TABLE "hiring_dot_applications" DROP COLUMN IF EXISTS "returned_by";
ALTER TABLE "hiring_dot_applications" DROP COLUMN IF EXISTS "returned_at";
ALTER TABLE "hiring_dot_applications" DROP COLUMN IF EXISTS "reviewed_by";
ALTER TABLE "hiring_dot_applications" DROP COLUMN IF EXISTS "reviewed_at";
ALTER TABLE "hiring_dot_applications" DROP COLUMN IF EXISTS "certification_history";
ALTER TABLE "hiring_dot_applications" DROP COLUMN IF EXISTS "certified_snapshot";
ALTER TABLE "hiring_dot_applications" DROP COLUMN IF EXISTS "certified_name";
ALTER TABLE "hiring_dot_applications" DROP COLUMN IF EXISTS "certified_at";
ALTER TABLE "hiring_dot_applications" DROP COLUMN IF EXISTS "submitted_via";
-- Applications a driver submitted but nobody accepted go back to drafts (the status no longer exists).
UPDATE "hiring_dot_applications" SET "status" = 'draft' WHERE "status" = 'driver_submitted';
