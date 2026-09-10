import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE autonomous_cycles
      DROP CONSTRAINT IF EXISTS autonomous_cycles_schema_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_identity_schema_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_strategy_name_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_execution_policy_schema_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_window_schema_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_contract_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_publication_deadline_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_execution_window_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_submission_cutoff_offset_check
  `

  yield* sql`
    DO $migration$
    DECLARE
      old_constraint text;
      constraint_definition text;
    BEGIN
      FOR old_constraint, constraint_definition IN
        SELECT conname, pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE conrelid = 'autonomous_cycles'::regclass
          AND contype = 'c'
      LOOP
        IF (
          constraint_definition LIKE '%publication_deadline_at%'
          AND constraint_definition LIKE '%submission_open_at%'
        ) OR (
          constraint_definition LIKE '%submission_cutoff_at%'
          AND constraint_definition LIKE '%execution_open_at%'
          AND constraint_definition NOT LIKE '%submission_open_at%'
        ) THEN
          EXECUTE format('ALTER TABLE autonomous_cycles DROP CONSTRAINT %I', old_constraint);
        END IF;
      END LOOP;
    END
    $migration$
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
      ADD CONSTRAINT autonomous_cycles_schema_version_check
        CHECK (schema_version IN ('bayn.autonomous-cycle.v1', 'bayn.autonomous-cycle.v2')) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_identity_schema_version_check
        CHECK (
          identity_schema_version IN (
            'bayn.autonomous-cycle-identity.v1',
            'bayn.autonomous-cycle-identity.v2'
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_strategy_name_check
        CHECK (strategy_name IN ('risk-balanced-trend', 'opening-drive-momentum')) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_execution_policy_schema_version_check
        CHECK (
          execution_policy_schema_version IN (
            'bayn.autonomous-cycle-execution-policy.v1',
            'bayn.autonomous-cycle-execution-policy.v2'
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_window_schema_version_check
        CHECK (
          window_schema_version IN (
            'bayn.autonomous-cycle-window.v1',
            'bayn.autonomous-cycle-window.v2'
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_contract_version_check
        CHECK (
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
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_publication_deadline_check
        CHECK (
          (
            window_schema_version = 'bayn.autonomous-cycle-window.v1'
            AND publication_deadline_at = submission_open_at
          )
          OR (
            window_schema_version = 'bayn.autonomous-cycle-window.v2'
            AND publication_deadline_at = execution_open_at
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_execution_window_check
        CHECK (
          (
            window_schema_version = 'bayn.autonomous-cycle-window.v1'
            AND submission_cutoff_at < execution_open_at
          )
          OR (
            window_schema_version = 'bayn.autonomous-cycle-window.v2'
            AND execution_open_at < submission_open_at
            AND submission_cutoff_at < execution_close_at
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_submission_cutoff_offset_check
        CHECK (
          (
            execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v1'
            AND execution_open_at =
              submission_cutoff_at + submission_cutoff_before_open_ms * interval '1 millisecond'
          )
          OR (
            execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v2'
            AND submission_cutoff_at =
              execution_open_at + submission_cutoff_before_open_ms * interval '1 millisecond'
          )
        ) NOT VALID
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
      VALIDATE CONSTRAINT autonomous_cycles_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_identity_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_strategy_name_check,
      VALIDATE CONSTRAINT autonomous_cycles_execution_policy_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_window_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_contract_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_publication_deadline_check,
      VALIDATE CONSTRAINT autonomous_cycles_execution_window_check,
      VALIDATE CONSTRAINT autonomous_cycles_submission_cutoff_offset_check
  `
})
