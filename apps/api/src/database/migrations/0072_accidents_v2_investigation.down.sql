-- Hand-run rollback of 0072 (local/staging only; never with v2 data that must be kept).
DROP TRIGGER IF EXISTS "safety_case_documents_protect_evidence" ON "safety_case_documents";
DROP FUNCTION IF EXISTS "safety_case_documents_protect"();
DROP TRIGGER IF EXISTS "safety_document_versions_no_change" ON "safety_document_versions";
DROP TABLE IF EXISTS "safety_document_versions";
DROP FUNCTION IF EXISTS "safety_document_versions_immutable"();
ALTER TABLE "safety_case_documents" DROP COLUMN IF EXISTS "sha256", DROP COLUMN IF EXISTS "current_version";
DROP TABLE IF EXISTS "restricted_access_log";
DROP TABLE IF EXISTS "accident_review_items";
DROP TABLE IF EXISTS "accident_factors";
DROP TABLE IF EXISTS "accident_statements";
DROP TABLE IF EXISTS "accident_questions";
DROP TABLE IF EXISTS "accident_facts";
DROP TABLE IF EXISTS "accident_witnesses";
DROP TABLE IF EXISTS "accident_other_vehicles";
