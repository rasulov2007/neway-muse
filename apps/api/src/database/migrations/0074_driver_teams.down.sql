-- Hand-run rollback of 0074 (local/staging only; drops every recorded team pairing).
DROP TABLE IF EXISTS "driver_teams";
