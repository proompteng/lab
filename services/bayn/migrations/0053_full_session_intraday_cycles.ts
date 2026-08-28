import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE authority_generations
      DROP CONSTRAINT authority_generations_strategy_name_check,
      DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check,
      DROP CONSTRAINT authority_generations_strategy_contract_check,
      ADD CONSTRAINT authority_generations_strategy_name_check CHECK (
        strategy_name IN ('risk-balanced-trend', 'opening-drive-momentum', 'intraday-momentum')
      ),
      ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
        strategy_parameter_schema_version IN (
          'bayn.risk-balanced-trend.protocol.v3',
          'bayn.risk-balanced-trend.protocol.v4',
          'bayn.opening-drive.protocol.v2',
          'bayn.intraday-momentum.protocol.v1'
        )
      ),
      ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
        (strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
        OR (
          strategy_name = 'risk-balanced-trend'
          AND strategy_parameter_schema_version IN (
            'bayn.risk-balanced-trend.protocol.v3',
            'bayn.risk-balanced-trend.protocol.v4'
          )
        )
        OR (
          strategy_name = 'opening-drive-momentum'
          AND strategy_parameter_schema_version = 'bayn.opening-drive.protocol.v2'
        )
        OR (
          strategy_name = 'intraday-momentum'
          AND strategy_parameter_schema_version = 'bayn.intraday-momentum.protocol.v1'
        )
      )
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
      ADD COLUMN warmup_after_open_ms integer,
      ADD COLUMN submission_cutoff_before_close_ms integer,
      DROP CONSTRAINT autonomous_cycles_strategy_name_check,
      DROP CONSTRAINT autonomous_cycles_execution_policy_schema_version_check,
      DROP CONSTRAINT autonomous_cycles_contract_version_check,
      DROP CONSTRAINT autonomous_cycles_contract_material_check,
      DROP CONSTRAINT autonomous_cycles_submission_cutoff_offset_check
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
      ADD CONSTRAINT autonomous_cycles_strategy_name_check
        CHECK (strategy_name IN ('risk-balanced-trend', 'opening-drive-momentum', 'intraday-momentum')) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_execution_policy_schema_version_check
        CHECK (
          execution_policy_schema_version IN (
            'bayn.autonomous-cycle-execution-policy.v1',
            'bayn.autonomous-cycle-execution-policy.v2',
            'bayn.autonomous-cycle-execution-policy.v3'
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
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_contract_material_check
        CHECK (
          (
            schema_version IN ('bayn.autonomous-cycle.v1', 'bayn.autonomous-cycle.v2')
            AND signal_session_date IS NOT NULL
            AND signal_calendar_version IS NOT NULL
            AND signal_close_at IS NOT NULL
            AND publication_deadline_at IS NOT NULL
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
                AND submission_cutoff_after_open_ms BETWEEN 1 AND 86400000
                AND warmup_after_open_ms IS NULL
                AND submission_cutoff_before_close_ms IS NULL
              )
              OR (
                execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v3'
                AND submission_cutoff_after_open_ms IS NULL
                AND warmup_after_open_ms BETWEEN 1 AND 86400000
                AND submission_cutoff_before_close_ms BETWEEN 1 AND 86400000
              )
            )
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_submission_cutoff_offset_check
        CHECK (
          (
            schema_version = 'bayn.autonomous-cycle.v1'
            AND execution_open_at =
              submission_cutoff_at + submission_cutoff_before_open_ms * interval '1 millisecond'
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v2'
            AND submission_cutoff_at =
              execution_open_at + submission_cutoff_before_open_ms * interval '1 millisecond'
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v3'
            AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v2'
            AND submission_cutoff_at =
              execution_open_at + submission_cutoff_after_open_ms * interval '1 millisecond'
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v3'
            AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v3'
            AND submission_open_at = execution_open_at + warmup_after_open_ms * interval '1 millisecond'
            AND submission_cutoff_at =
              execution_close_at - submission_cutoff_before_close_ms * interval '1 millisecond'
          )
        ) NOT VALID
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
      VALIDATE CONSTRAINT autonomous_cycles_strategy_name_check,
      VALIDATE CONSTRAINT autonomous_cycles_execution_policy_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_contract_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_contract_material_check,
      VALIDATE CONSTRAINT autonomous_cycles_submission_cutoff_offset_check
  `
})
