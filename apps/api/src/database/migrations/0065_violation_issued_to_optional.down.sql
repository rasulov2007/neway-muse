UPDATE "safety_violations" SET "issued_to" = 'driver' WHERE "issued_to" IS NULL;
ALTER TABLE "safety_violations" ALTER COLUMN "issued_to" SET NOT NULL;
