-- Assigning a driver to a truck, from the truck page (owner's ask, 2026-09-21).
--
-- `trucks.current_driver_id` says who is in the unit now; this table says since when, what was
-- handed over with it (tablet, GPS, and whatever else) and who did the assigning. A row is closed
-- (`ended_on`) when the driver leaves the unit or is replaced, never deleted, so "who had this
-- truck in March, and did the tablet go with them?" has an answer.
CREATE TABLE IF NOT EXISTS "truck_driver_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
  "truck_id" text NOT NULL,
  "driver_id" text NOT NULL,
  "assigned_on" date NOT NULL,
  "ended_on" date,
  -- [{ "item": "tablet", "label": "Tablet", "detail": "Samsung A9 · #4471", "handedOver": true }]
  "equipment" jsonb NOT NULL DEFAULT '[]',
  "note" text,
  "version" integer NOT NULL DEFAULT 1,
  "created_by" text NOT NULL DEFAULT '',
  "created_by_name" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ended_by" text,
  "end_reason" text
);
CREATE INDEX IF NOT EXISTS "truck_driver_assignments_truck_idx"
  ON "truck_driver_assignments" ("company_id", "truck_id", "ended_on");
CREATE INDEX IF NOT EXISTS "truck_driver_assignments_driver_idx"
  ON "truck_driver_assignments" ("company_id", "driver_id", "ended_on");
