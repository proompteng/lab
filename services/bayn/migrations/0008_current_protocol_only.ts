import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

const truncateGuards = [
  ['protocol_locks', 'protocol_locks_reject_truncate'],
  ['snapshot_references', 'snapshot_references_reject_truncate'],
  ['evaluation_runs', 'evaluation_runs_reject_truncate'],
  ['evaluation_artifacts', 'evaluation_artifacts_reject_truncate'],
  ['evaluation_events', 'evaluation_events_reject_truncate'],
  ['gate_outcomes', 'gate_outcomes_reject_truncate'],
  ['status_history', 'status_history_reject_truncate'],
  ['qualification_trials', 'qualification_trials_reject_truncate'],
  ['qualification_locks', 'qualification_locks_reject_truncate'],
  ['qualification_results', 'qualification_results_reject_truncate'],
] as const

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    DO $block$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM protocol_locks
        WHERE strategy_name <> 'tsmom'
          OR schema_version NOT IN ('bayn.tsmom.protocol.v1', 'bayn.tsmom.protocol.v2')
      ) THEN
        RAISE EXCEPTION 'hard migration requires an empty database or legacy TSMOM-only evidence'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM qualification_locks
        WHERE schema_version <> 'bayn.qualification-lock.v2'
      ) THEN
        RAISE EXCEPTION 'hard migration refuses to erase non-legacy qualification locks'
          USING ERRCODE = '55000';
      END IF;
    END
    $block$
  `

  for (const [table, trigger] of truncateGuards) {
    yield* sql`ALTER TABLE ${sql(table)} DISABLE TRIGGER ${sql(trigger)}`
  }

  yield* sql`
    TRUNCATE TABLE
      qualification_results,
      qualification_locks,
      qualification_trials,
      status_history,
      gate_outcomes,
      evaluation_events,
      evaluation_artifacts,
      evaluation_runs,
      snapshot_references,
      protocol_locks
    RESTART IDENTITY
  `

  yield* sql`DROP SCHEMA IF EXISTS restore_probe CASCADE`
  yield* sql`ALTER SEQUENCE bayn_status_history_sequence_seq RENAME TO status_history_sequence_seq`

  for (const [table, trigger] of truncateGuards) {
    yield* sql`ALTER TABLE ${sql(table)} ENABLE TRIGGER ${sql(trigger)}`
  }

  yield* sql`
    ALTER TABLE protocol_locks
      DROP CONSTRAINT protocol_locks_schema_version_check,
      DROP CONSTRAINT protocol_locks_strategy_name_check,
      ADD CONSTRAINT protocol_locks_schema_version_check
        CHECK (schema_version = 'bayn.risk-balanced-trend.protocol.v2'),
      ADD CONSTRAINT protocol_locks_strategy_name_check
        CHECK (strategy_name = 'risk-balanced-trend')
  `

  yield* sql`
    ALTER TABLE snapshot_references
      DROP CONSTRAINT snapshot_references_schema_version_check,
      DROP CONSTRAINT snapshot_references_database_name_check,
      DROP CONSTRAINT snapshot_references_table_name_check,
      DROP CONSTRAINT snapshot_references_dataset_version_check,
      DROP CONSTRAINT snapshot_references_source_check,
      DROP CONSTRAINT snapshot_references_source_feed_check,
      DROP CONSTRAINT snapshot_references_adjustment_check,
      ADD CONSTRAINT snapshot_references_schema_version_check
        CHECK (schema_version = 'bayn.finalized-snapshot.v3'),
      ADD CONSTRAINT snapshot_references_database_name_check
        CHECK (database_name = 'signal'),
      ADD CONSTRAINT snapshot_references_table_name_check
        CHECK (table_name = 'adjusted_daily_bars_v2'),
      ADD CONSTRAINT snapshot_references_dataset_version_check
        CHECK (dataset_version = 'signal.adjusted-daily-snapshot.v2'),
      ADD CONSTRAINT snapshot_references_source_check
        CHECK (source = 'alpaca'),
      ADD CONSTRAINT snapshot_references_source_feed_check
        CHECK (source_feed = 'sip'),
      ADD CONSTRAINT snapshot_references_adjustment_check
        CHECK (adjustment = 'all')
  `

  yield* sql`
    ALTER TABLE evaluation_runs
      DROP CONSTRAINT evaluation_runs_evaluation_schema_version_check,
      DROP CONSTRAINT evaluation_runs_strategy_name_check,
      ADD CONSTRAINT evaluation_runs_evaluation_schema_version_check
        CHECK (evaluation_schema_version = 'bayn.evaluation.v6'),
      ADD CONSTRAINT evaluation_runs_strategy_name_check
        CHECK (strategy_name = 'risk-balanced-trend')
  `

  yield* sql`
    ALTER TABLE qualification_locks
      DROP CONSTRAINT qualification_locks_schema_version_check,
      ADD CONSTRAINT qualification_locks_schema_version_check
        CHECK (schema_version = 'bayn.qualification-lock.v3')
  `
})
