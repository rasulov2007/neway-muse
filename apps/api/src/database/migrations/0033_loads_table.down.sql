-- Rolls the loads table back. The ws2-loads snapshot row was never touched, so reads can be
-- pointed back at it after this runs (see the cutover report for the two-line switch).
DROP TABLE IF EXISTS "loads";
