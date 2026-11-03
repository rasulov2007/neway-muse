-- Removes the completion pipeline rows; they are derived and are rebuilt by the backfill.
DROP TABLE IF EXISTS "acct_completions";
