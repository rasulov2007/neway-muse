DROP INDEX IF EXISTS "compliance_documents_external_key";
ALTER TABLE "compliance_documents" DROP COLUMN IF EXISTS "external_id";
ALTER TABLE "compliance_documents" DROP COLUMN IF EXISTS "source_system";
