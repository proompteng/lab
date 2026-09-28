import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE autonomous_cycles
      ADD COLUMN entry_attempt_ordinal integer NOT NULL DEFAULT 1,
      DROP CONSTRAINT autonomous_cycles_schema_version_check,
      DROP CONSTRAINT autonomous_cycles_identity_schema_version_check,
      DROP CONSTRAINT autonomous_cycles_contract_version_check,
      DROP CONSTRAINT autonomous_cycles_contract_material_check,
      DROP CONSTRAINT autonomous_cycles_publication_deadline_check,
      DROP CONSTRAINT autonomous_cycles_execution_window_check,
      DROP CONSTRAINT autonomous_cycles_submission_cutoff_offset_check,
      DROP CONSTRAINT autonomous_cycles_state_bindings_check
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
      ADD CONSTRAINT autonomous_cycles_schema_version_check CHECK (
        schema_version IN (
          'bayn.autonomous-cycle.v1',
          'bayn.autonomous-cycle.v2',
          'bayn.autonomous-cycle.v3',
          'bayn.autonomous-cycle.v4'
        )
      ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_identity_schema_version_check CHECK (
        identity_schema_version IN (
          'bayn.autonomous-cycle-identity.v1',
          'bayn.autonomous-cycle-identity.v2',
          'bayn.autonomous-cycle-identity.v3',
          'bayn.autonomous-cycle-identity.v4'
        )
      ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_entry_attempt_ordinal_check CHECK (
        (
          schema_version = 'bayn.autonomous-cycle.v4'
          AND identity_schema_version = 'bayn.autonomous-cycle-identity.v4'
          AND strategy_name = 'intraday-momentum'
          AND entry_attempt_ordinal BETWEEN 1 AND 2
        )
        OR (
          schema_version <> 'bayn.autonomous-cycle.v4'
          AND identity_schema_version <> 'bayn.autonomous-cycle-identity.v4'
          AND entry_attempt_ordinal = 1
        )
      ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_contract_version_check CHECK (
        (
          schema_version = 'bayn.autonomous-cycle.v1'
          AND identity_schema_version = 'bayn.autonomous-cycle-identity.v1'
          AND strategy_name = 'risk-balanced-trend'
          AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v1'
          AND window_schema_version = 'bayn.autonomous-cycle-window.v1'
        )
        OR (
          schema_version = 'bayn.autonomous-cycle.v2'
          AND identity_schema_version = 'bayn.autonomous-cycle-identity.v2'
          AND strategy_name = 'opening-drive-momentum'
          AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v2'
          AND window_schema_version = 'bayn.autonomous-cycle-window.v2'
        )
        OR (
          schema_version = 'bayn.autonomous-cycle.v3'
          AND identity_schema_version = 'bayn.autonomous-cycle-identity.v3'
          AND window_schema_version = 'bayn.autonomous-cycle-window.v3'
          AND (
            (
              strategy_name = 'opening-drive-momentum'
              AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v2'
            )
            OR (
              strategy_name = 'intraday-momentum'
              AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v3'
            )
          )
        )
        OR (
          schema_version = 'bayn.autonomous-cycle.v4'
          AND identity_schema_version = 'bayn.autonomous-cycle-identity.v4'
          AND strategy_name = 'intraday-momentum'
          AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v3'
          AND window_schema_version = 'bayn.autonomous-cycle-window.v3'
        )
      ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_contract_material_check CHECK (
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
          schema_version IN ('bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4')
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
      ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_publication_deadline_check CHECK (
        (
          schema_version = 'bayn.autonomous-cycle.v1'
          AND publication_deadline_at = submission_open_at
        )
        OR (
          schema_version = 'bayn.autonomous-cycle.v2'
          AND publication_deadline_at = execution_open_at
        )
        OR (
          schema_version IN ('bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4')
          AND publication_deadline_at IS NULL
        )
      ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_execution_window_check CHECK (
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
            schema_version IN ('bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4')
            AND execution_open_at <= submission_open_at
            AND submission_cutoff_at <= execution_close_at
          )
        )
      ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_submission_cutoff_offset_check CHECK (
        (
          schema_version = 'bayn.autonomous-cycle.v1'
          AND execution_open_at = submission_cutoff_at + submission_cutoff_before_open_ms * interval '1 millisecond'
        )
        OR (
          schema_version = 'bayn.autonomous-cycle.v2'
          AND submission_cutoff_at = execution_open_at + submission_cutoff_before_open_ms * interval '1 millisecond'
        )
        OR (
          schema_version IN ('bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4')
          AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v2'
          AND submission_cutoff_after_open_ms IS NOT NULL
          AND submission_cutoff_at = execution_open_at + submission_cutoff_after_open_ms * interval '1 millisecond'
        )
        OR (
          schema_version IN ('bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4')
          AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v3'
          AND warmup_after_open_ms IS NOT NULL
          AND submission_cutoff_before_close_ms IS NOT NULL
          AND submission_open_at = execution_open_at + warmup_after_open_ms * interval '1 millisecond'
          AND submission_cutoff_at = execution_close_at - submission_cutoff_before_close_ms * interval '1 millisecond'
        )
      ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_state_bindings_check CHECK (
        (
          state = 'PENDING'
          AND decision_hash IS NULL
          AND terminal_reason IS NULL
          AND terminal_at IS NULL
        )
        OR (
          state = 'ACTIVE'
          AND (schema_version IN ('bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4') OR snapshot_id IS NOT NULL)
          AND terminal_reason IS NULL
          AND terminal_at IS NULL
        )
        OR (
          state IN ('COMPLETED', 'NO_TRADE')
          AND snapshot_id IS NOT NULL
          AND decision_hash IS NOT NULL
          AND terminal_reason IS NULL
          AND terminal_at = updated_at
        )
        OR (
          state = 'BLOCKED'
          AND terminal_reason IS NOT NULL
          AND terminal_at = updated_at
        )
      ) NOT VALID
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
      VALIDATE CONSTRAINT autonomous_cycles_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_identity_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_entry_attempt_ordinal_check,
      VALIDATE CONSTRAINT autonomous_cycles_contract_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_contract_material_check,
      VALIDATE CONSTRAINT autonomous_cycles_publication_deadline_check,
      VALIDATE CONSTRAINT autonomous_cycles_execution_window_check,
      VALIDATE CONSTRAINT autonomous_cycles_submission_cutoff_offset_check,
      VALIDATE CONSTRAINT autonomous_cycles_state_bindings_check
  `

  yield* sql`
    DROP INDEX autonomous_cycles_intraday_authority_slot_key
  `
  yield* sql`
    CREATE UNIQUE INDEX autonomous_cycles_intraday_authority_slot_key
    ON autonomous_cycles(qualification_run_id, account_id, execution_session_date, entry_attempt_ordinal)
    WHERE schema_version IN ('bayn.autonomous-cycle.v2', 'bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4')
  `

  // Migration 46 patched the lifecycle trigger for unbound intraday cycles. Extend only those exact version guards;
  // all state, evidence, accounting and terminalization invariants remain byte-for-byte unchanged.
  yield* sql`
    DO $migration$
    DECLARE
      lifecycle_definition text := pg_get_functiondef('enforce_autonomous_cycle_lifecycle()'::regprocedure);
      old_fragment text;
      new_fragment text;
      observed_count integer;
    BEGIN
      old_fragment := 'NEW.schema_version <> ''bayn.autonomous-cycle.v3''';
      new_fragment := 'NEW.schema_version NOT IN (''bayn.autonomous-cycle.v3'', ''bayn.autonomous-cycle.v4'')';
      observed_count := (length(lifecycle_definition) - length(replace(lifecycle_definition, old_fragment, ''))) / length(old_fragment);
      IF observed_count <> 2 THEN
        RAISE EXCEPTION 'expected two NEW intraday exclusion lifecycle guards, found %', observed_count USING ERRCODE = '55000';
      END IF;
      lifecycle_definition := replace(lifecycle_definition, old_fragment, new_fragment);

      old_fragment := 'OLD.schema_version <> ''bayn.autonomous-cycle.v3''';
      new_fragment := 'OLD.schema_version NOT IN (''bayn.autonomous-cycle.v3'', ''bayn.autonomous-cycle.v4'')';
      observed_count := (length(lifecycle_definition) - length(replace(lifecycle_definition, old_fragment, ''))) / length(old_fragment);
      IF observed_count <> 2 THEN
        RAISE EXCEPTION 'expected two OLD intraday exclusion lifecycle guards, found %', observed_count USING ERRCODE = '55000';
      END IF;
      lifecycle_definition := replace(lifecycle_definition, old_fragment, new_fragment);

      old_fragment := 'OLD.schema_version = ''bayn.autonomous-cycle.v3''';
      new_fragment := 'OLD.schema_version IN (''bayn.autonomous-cycle.v3'', ''bayn.autonomous-cycle.v4'')';
      observed_count := (length(lifecycle_definition) - length(replace(lifecycle_definition, old_fragment, ''))) / length(old_fragment);
      IF observed_count <> 1 THEN
        RAISE EXCEPTION 'expected one OLD intraday inclusion lifecycle guard, found %', observed_count USING ERRCODE = '55000';
      END IF;
      lifecycle_definition := replace(lifecycle_definition, old_fragment, new_fragment);

      old_fragment := 'NEW.schema_version = ''bayn.autonomous-cycle.v3''';
      new_fragment := 'NEW.schema_version IN (''bayn.autonomous-cycle.v3'', ''bayn.autonomous-cycle.v4'')';
      observed_count := (length(lifecycle_definition) - length(replace(lifecycle_definition, old_fragment, ''))) / length(old_fragment);
      IF observed_count <> 1 THEN
        RAISE EXCEPTION 'expected one NEW intraday inclusion lifecycle guard, found %', observed_count USING ERRCODE = '55000';
      END IF;
      lifecycle_definition := replace(lifecycle_definition, old_fragment, new_fragment);
      EXECUTE lifecycle_definition;
    END
    $migration$
  `

  // Preserve untouched v4 attempts across the same transient authority-rearm paths already proven for v3.
  yield* sql`
    DO $migration$
    DECLARE
      function_definition text := pg_get_functiondef(
        'research_paper_rearm_eligible(text,bigint,timestamptz)'::regprocedure
      );
      old_fragment text;
      new_fragment text;
      observed_count integer;
    BEGIN
      old_fragment := 'cycle.schema_version = ''bayn.autonomous-cycle.v3''';
      new_fragment := 'cycle.schema_version IN (''bayn.autonomous-cycle.v3'', ''bayn.autonomous-cycle.v4'')';
      observed_count := (length(function_definition) - length(replace(function_definition, old_fragment, ''))) / length(old_fragment);
      IF observed_count <> 2 THEN
        RAISE EXCEPTION 'expected two research rearm cycle-version guards, found %', observed_count USING ERRCODE = '55000';
      END IF;
      function_definition := replace(function_definition, old_fragment, new_fragment);

      old_fragment := 'cycle.identity_schema_version = ''bayn.autonomous-cycle-identity.v3''';
      new_fragment := 'cycle.identity_schema_version IN (''bayn.autonomous-cycle-identity.v3'', ''bayn.autonomous-cycle-identity.v4'')';
      observed_count := (length(function_definition) - length(replace(function_definition, old_fragment, ''))) / length(old_fragment);
      IF observed_count <> 1 THEN
        RAISE EXCEPTION 'expected one research rearm identity-version guard, found %', observed_count USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(function_definition, old_fragment, new_fragment);
    END
    $migration$
  `
})
