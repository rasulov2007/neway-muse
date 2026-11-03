-- Rolls back 0042. Children before parents. Online applications are dropped with their table; the
-- leads they created stay (they are ordinary leads), and the audit lines about them stay in
-- "audit_logs".
DROP TABLE IF EXISTS "hiring_lead_applications";
DROP TABLE IF EXISTS "hiring_apply_links";
ALTER TABLE "hiring_leads" DROP COLUMN IF EXISTS "last_applied_at";
