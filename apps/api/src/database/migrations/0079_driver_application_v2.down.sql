-- Rollback for 0079 (only if no application was sent: the tables hold driver records).
DROP TABLE IF EXISTS "dot_application_change_requests";
DROP TABLE IF EXISTS "dot_application_files";
DROP TABLE IF EXISTS "dot_application_signatures";
DROP TABLE IF EXISTS "dot_application_sessions";
DROP TABLE IF EXISTS "dot_application_links";
DROP TABLE IF EXISTS "dot_driver_applications";
DROP TABLE IF EXISTS "application_document_templates";
DROP TABLE IF EXISTS "email_messages";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "recruiting_reply_to";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "accounting_reply_to";
