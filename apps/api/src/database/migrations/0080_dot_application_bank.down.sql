-- Rollback for 0080 (drops the sealed ACH bank numbers: only before any application holds them).
ALTER TABLE "dot_driver_applications" DROP COLUMN IF EXISTS "bank_sealed";
ALTER TABLE "dot_driver_applications" DROP COLUMN IF EXISTS "bank_last4";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "sph_confidential_fax";
