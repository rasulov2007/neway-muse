-- Reverses 0018_fleet_work_orders.sql.
--
-- Drops only what that file created, in the order the foreign keys allow. The workspace blob in
-- `app_state` was never modified, so the data these tables were filled from is still there and the
-- product returns to reading it.
--
-- Run it the same way as the up migration:
--   docker compose -f infra/docker-compose.prod.yml -p neway-tms exec -T postgres \
--     psql -U neway -d neway -f /dev/stdin < apps/api/src/database/migrations/0018_fleet_work_orders.down.sql

DROP TABLE IF EXISTS "work_order_actions";
DROP TABLE IF EXISTS "work_orders";
DROP TABLE IF EXISTS "unit_maintenance_settings";
DROP TABLE IF EXISTS "trailers";
