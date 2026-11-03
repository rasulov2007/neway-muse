-- Rolls back 0040. Deactivated companies become ordinary companies again; the audit lines that
-- recorded each platform action stay in "audit_logs".
ALTER TABLE "companies" DROP COLUMN IF EXISTS "deactivated_by";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "deactivated_reason";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "deactivated_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "is_platform_admin";
