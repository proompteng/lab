\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';

SELECT clock_timestamp() AS checked_at, current_database() AS database,
       pg_database_size(current_database()) AS database_bytes;

SELECT relname AS table_name, n_live_tup AS estimated_live_rows, n_dead_tup AS estimated_dead_rows,
       pg_total_relation_size(relid) AS total_bytes,
       pg_indexes_size(relid) AS index_bytes, last_analyze, last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(relid) DESC;

SELECT format('SELECT %L AS table_name, count(*) AS exact_rows FROM %I.%I;',
              tablename, schemaname, tablename)
FROM pg_tables
WHERE schemaname = 'public' AND tablename IN (
  'broker_errors', 'rate_limits',
  'opening_drive_qualification_locks', 'opening_drive_qualification_replay_versions',
  'opening_drive_qualification_results', 'opening_drive_qualification_session_replays',
  'lifecycle_commands', 'intraday_archive_availability', 'research_capture_chunks', 'research_capture_seals',
  'evaluation_runs', 'evaluation_artifacts', 'evaluation_events', 'gate_outcomes',
  'qualification_trials', 'status_history', 'simulated_broker_checkpoints'
)
ORDER BY tablename
\gexec

SELECT relname AS table_name, indexrelname AS index_name, idx_scan AS scans_since_stats_reset,
       pg_relation_size(indexrelid) AS index_bytes
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC;

SELECT migration_id, name FROM schema_migrations ORDER BY migration_id DESC LIMIT 5;
COMMIT;
