-- Reversing this needs every row to carry both values again; the dates are filled with a date in
-- the past so the rows remain visibly out of qualification rather than silently valid.
UPDATE "drivers" SET "medical_card_expires_on" = DATE '1900-01-01' WHERE "medical_card_expires_on" IS NULL;
UPDATE "drivers" SET "pay_plan_rate" = 0 WHERE "pay_plan_rate" IS NULL;
ALTER TABLE "drivers" ALTER COLUMN "medical_card_expires_on" SET NOT NULL;
ALTER TABLE "drivers" ALTER COLUMN "pay_plan_rate" SET NOT NULL;
