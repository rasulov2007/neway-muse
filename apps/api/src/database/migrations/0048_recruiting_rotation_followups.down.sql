-- Reverts 0048 completely.
-- Data lost: the persisted rotation order, exclusions and cursor (the previous code reads its
-- pointer from the `auto_assign` audit entries, which the new allocator kept writing, so the next
-- turn stays right); the current follow-up dates on leads and candidates (every note that set one
-- stays in the audit trail with its date); the Safety request stamp on cases (its audit entry
-- stays); and applications received through the external intake adapter (their files stay in
-- hiring_dot_link_files, their audit entries stay).
DROP TABLE IF EXISTS "hiring_external_applications";
DROP TABLE IF EXISTS "hiring_rotation_state";
DROP TABLE IF EXISTS "hiring_rotation_members";
DROP INDEX IF EXISTS "hiring_cases_follow_up_idx";
DROP INDEX IF EXISTS "hiring_leads_follow_up_idx";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "safety_request_note";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "safety_requested_by";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "safety_requested_at";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "follow_up_set_by";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "follow_up_set_at";
ALTER TABLE "hiring_cases" DROP COLUMN IF EXISTS "next_follow_up_on";
ALTER TABLE "hiring_leads" DROP COLUMN IF EXISTS "follow_up_set_by";
ALTER TABLE "hiring_leads" DROP COLUMN IF EXISTS "follow_up_set_at";
ALTER TABLE "hiring_leads" DROP COLUMN IF EXISTS "next_follow_up_on";
