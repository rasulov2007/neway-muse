-- Rolls back 0039. Archived drivers become ordinary rows again (their status was never changed);
-- the audit lines that recorded each archive and restore stay in "audit_logs".
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "archived_by";
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "archived_reason";
ALTER TABLE "drivers" DROP COLUMN IF EXISTS "archived_at";
