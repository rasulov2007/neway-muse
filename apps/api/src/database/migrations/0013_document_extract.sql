-- Structured data read off a document, kept with the document it came from.
--
-- Additive and nullable: every existing row keeps its meaning, and a file uploaded before this
-- simply has no extract. The evidence and what was read from it cannot drift apart, because they
-- are the same row.
ALTER TABLE "compliance_documents" ADD COLUMN IF NOT EXISTS "extracted" jsonb;
