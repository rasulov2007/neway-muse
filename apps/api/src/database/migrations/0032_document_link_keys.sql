-- Where an imported document came from, so a second run recognises its own work.
--
-- `source` already exists on this table and means how the document arrived (staff, driver portal,
-- integration). This is the other half: which system, and its key there.
ALTER TABLE "compliance_documents" ADD COLUMN IF NOT EXISTS "source_system" text;
ALTER TABLE "compliance_documents" ADD COLUMN IF NOT EXISTS "external_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "compliance_documents_external_key"
  ON "compliance_documents" ("company_id", "source_system", "external_id")
  WHERE "source_system" IS NOT NULL AND "external_id" IS NOT NULL;
