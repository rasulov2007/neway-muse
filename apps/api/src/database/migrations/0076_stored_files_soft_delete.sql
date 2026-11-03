-- 0076: soft delete for stored files (owner brief, 2026-10-25, finding 4). Additive only.
-- A file is never removed from disk or from this table again: an administrator may mark an
-- unattached file deleted (with a reason), and restore it; every read ignores a deleted file except
-- the administrator's restore view. Files a load, invoice, safety record, company document or other
-- business record points at cannot be deleted at all; they leave with that record (void / archive).
ALTER TABLE "stored_files" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "stored_files" ADD COLUMN IF NOT EXISTS "deleted_by" text;
--> statement-breakpoint
ALTER TABLE "stored_files" ADD COLUMN IF NOT EXISTS "delete_reason" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stored_files_company_deleted_idx" ON "stored_files" ("company_id", "deleted_at");
