-- Files attached to snapshot-held records (work order invoices, load paperwork) get a row and a
-- storage key instead of riding inside the workspace snapshot as base64.
CREATE TABLE IF NOT EXISTS "stored_files" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL DEFAULT 0,
  "storage_key" text NOT NULL,
  "uploaded_by" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "stored_files_company_idx" ON "stored_files" ("company_id");
