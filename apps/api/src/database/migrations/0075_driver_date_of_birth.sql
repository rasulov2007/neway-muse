-- Date of birth on the driver file (owner, 2026-10-25). Additive only: one nullable calendar date.
-- Null means "not recorded": drivers already on the roster arrive without one, and the honest
-- record of that is an empty column, not an invented date. Personal data: it is masked with the
-- licence group (drivers.view_licence) once the authorisation branch lands.
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "date_of_birth" date;
