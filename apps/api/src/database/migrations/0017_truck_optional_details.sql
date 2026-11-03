-- A truck exists before every detail is known (round 3, P1 #5): plate, plate state, colour,
-- home terminal and the in-service date are recorded later, from the unit's page.
ALTER TABLE "trucks" ALTER COLUMN "plate" DROP NOT NULL;
ALTER TABLE "trucks" ALTER COLUMN "plate_state" DROP NOT NULL;
ALTER TABLE "trucks" ALTER COLUMN "color" DROP NOT NULL;
ALTER TABLE "trucks" ALTER COLUMN "home_terminal" DROP NOT NULL;
ALTER TABLE "trucks" ALTER COLUMN "in_service_date" DROP NOT NULL;
UPDATE "trucks" SET "plate" = NULL WHERE "plate" = '';
UPDATE "trucks" SET "plate_state" = NULL WHERE "plate_state" = '';
UPDATE "trucks" SET "color" = NULL WHERE "color" = '';
UPDATE "trucks" SET "home_terminal" = NULL WHERE "home_terminal" = '';
