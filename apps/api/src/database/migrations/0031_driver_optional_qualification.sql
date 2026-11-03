-- A driver file may be incomplete, and say so, rather than carry a date nobody can stand behind.
--
-- Ditat has no medical-card column at all: the certificate exists only as a PDF in the driver's
-- qualification folder, and a date read off a filename is not a medical card. Pay is the same
-- story - the rate lives in a pay plan this import cannot yet walk. So both become nullable, the
-- status columns keep saying `missing`, and the compliance screens go on treating a missing
-- certificate as missing. Nothing here loosens a qualification rule; it only stops the database
-- demanding a number that does not exist.
ALTER TABLE "drivers" ALTER COLUMN "medical_card_expires_on" DROP NOT NULL;
ALTER TABLE "drivers" ALTER COLUMN "pay_plan_rate" DROP NOT NULL;
