-- Hand-run rollback of 0076 (local/staging only; forgets which files were soft-deleted).
DROP INDEX IF EXISTS "stored_files_company_deleted_idx";
ALTER TABLE "stored_files" DROP COLUMN IF EXISTS "delete_reason";
ALTER TABLE "stored_files" DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "stored_files" DROP COLUMN IF EXISTS "deleted_at";
