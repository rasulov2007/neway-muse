-- A warning may leave "issued to" blank (owner, 2026-10-19). Inspections and citations still say it;
-- the API enforces that.
ALTER TABLE "safety_violations" ALTER COLUMN "issued_to" DROP NOT NULL;
