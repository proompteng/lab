import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE autonomous_cycles
      DROP CONSTRAINT autonomous_cycles_contract_material_check,
      DROP CONSTRAINT autonomous_cycles_execution_window_check,
      ADD CONSTRAINT autonomous_cycles_contract_material_check
        CHECK (
          (
            schema_version IN ('bayn.autonomous-cycle.v1', 'bayn.autonomous-cycle.v2')
            AND signal_session_date IS NOT NULL
            AND signal_calendar_version IS NOT NULL
            AND signal_close_at IS NOT NULL
            AND publication_deadline_at IS NOT NULL
            AND submission_cutoff_before_open_ms IS NOT NULL
            AND submission_cutoff_before_open_ms BETWEEN 1 AND 86400000
            AND submission_cutoff_after_open_ms IS NULL
            AND warmup_after_open_ms IS NULL
            AND submission_cutoff_before_close_ms IS NULL
            AND signal_session_date < execution_session_date
            AND signal_close_at < submission_open_at
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v3'
            AND signal_session_date IS NULL
            AND signal_calendar_version IS NULL
            AND signal_close_at IS NULL
            AND publication_deadline_at IS NULL
            AND submission_cutoff_before_open_ms IS NULL
            AND (
              (
                execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v2'
                AND submission_cutoff_after_open_ms IS NOT NULL
                AND submission_cutoff_after_open_ms BETWEEN 1 AND 86400000
                AND warmup_after_open_ms IS NULL
                AND submission_cutoff_before_close_ms IS NULL
              )
              OR (
                execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v3'
                AND submission_cutoff_after_open_ms IS NULL
                AND warmup_after_open_ms IS NOT NULL
                AND warmup_after_open_ms BETWEEN 0 AND 86400000
                AND submission_cutoff_before_close_ms IS NOT NULL
                AND submission_cutoff_before_close_ms BETWEEN 0 AND 86400000
              )
            )
          )
        ),
      ADD CONSTRAINT autonomous_cycles_execution_window_check
        CHECK (
          submission_open_at < submission_cutoff_at
          AND execution_open_at < execution_close_at
          AND (
            (schema_version = 'bayn.autonomous-cycle.v1' AND submission_cutoff_at < execution_open_at)
            OR (
              schema_version = 'bayn.autonomous-cycle.v2'
              AND execution_open_at < submission_open_at
              AND submission_cutoff_at < execution_close_at
            )
            OR (
              schema_version = 'bayn.autonomous-cycle.v3'
              AND execution_open_at <= submission_open_at
              AND submission_cutoff_at <= execution_close_at
            )
          )
        )
  `
})
