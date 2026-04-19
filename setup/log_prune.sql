-- Prune pipeline_log to the last 30 days of rows.
-- Run nightly via cron — pipeline_log would otherwise grow unbounded
-- (~100 rows per domain pipeline run + ~1 row/sec heartbeat during migration).
--
-- Install (as the ssr user):
--   echo "30 3 * * * sqlite3 /opt/ssr/data/ssr.db < /opt/ssr/setup/log_prune.sql" | crontab -
--
-- The VACUUM at the end reclaims disk space from the deleted rows.
-- SQLite's WAL checkpoint happens automatically; VACUUM here is belt-and-braces.

DELETE FROM pipeline_log
 WHERE created_at < datetime('now', '-30 days');

-- step_tracker: keep only rows whose domain still exists (orphans can
-- accumulate from deleted domains).
DELETE FROM step_tracker
 WHERE domain NOT IN (SELECT domain FROM domains);

VACUUM;
