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
        strategy_name IN ('risk-balanced-trend', 'opening-drive-momentum', 'intraday-momentum', 'jev')
      ),
      ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
        strategy_parameter_schema_version IN ('bayn.risk-balanced-trend.protocol.v3', 'bayn.risk-balanced-trend.protocol.v4',
          'bayn.opening-drive.protocol.v2', 'bayn.intraday-momentum.protocol.v1', 'bayn.intraday-momentum.protocol.v2',
          'bayn.intraday-momentum.protocol.v3', 'bayn.jev.protocol.v1')
      ),
      ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
        (strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
        OR (strategy_name = 'risk-balanced-trend' AND strategy_parameter_schema_version IN ('bayn.risk-balanced-trend.protocol.v3', 'bayn.risk-balanced-trend.protocol.v4'))
        OR (strategy_name = 'opening-drive-momentum' AND strategy_parameter_schema_version = 'bayn.opening-drive.protocol.v2')
        OR (strategy_name = 'intraday-momentum' AND strategy_parameter_schema_version IN ('bayn.intraday-momentum.protocol.v1', 'bayn.intraday-momentum.protocol.v2', 'bayn.intraday-momentum.protocol.v3'))
        OR (strategy_name = 'jev' AND strategy_parameter_schema_version = 'bayn.jev.protocol.v1')
      )
  `
  yield* sql`
    ALTER TABLE autonomous_cycles
      DROP CONSTRAINT autonomous_cycles_strategy_name_check,
      DROP CONSTRAINT autonomous_cycles_contract_version_check,
      DROP CONSTRAINT autonomous_cycles_entry_attempt_ordinal_check,
      ADD CONSTRAINT autonomous_cycles_strategy_name_check CHECK (
        strategy_name IN ('risk-balanced-trend', 'opening-drive-momentum', 'intraday-momentum', 'jev')
      ),
      ADD CONSTRAINT autonomous_cycles_contract_version_check CHECK (
        (schema_version = 'bayn.autonomous-cycle.v1' AND identity_schema_version = 'bayn.autonomous-cycle-identity.v1'
          AND strategy_name = 'risk-balanced-trend' AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v1' AND window_schema_version = 'bayn.autonomous-cycle-window.v1')
        OR (schema_version = 'bayn.autonomous-cycle.v2' AND identity_schema_version = 'bayn.autonomous-cycle-identity.v2'
          AND strategy_name = 'opening-drive-momentum' AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v2' AND window_schema_version = 'bayn.autonomous-cycle-window.v2')
        OR (schema_version = 'bayn.autonomous-cycle.v3' AND identity_schema_version = 'bayn.autonomous-cycle-identity.v3' AND window_schema_version = 'bayn.autonomous-cycle-window.v3'
          AND ((strategy_name = 'opening-drive-momentum' AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v2')
            OR (strategy_name = 'intraday-momentum' AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v3')))
        OR (schema_version = 'bayn.autonomous-cycle.v4' AND identity_schema_version = 'bayn.autonomous-cycle-identity.v4'
          AND strategy_name IN ('intraday-momentum', 'jev') AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v3' AND window_schema_version = 'bayn.autonomous-cycle-window.v3')
      ),
      ADD CONSTRAINT autonomous_cycles_entry_attempt_ordinal_check CHECK (
        (schema_version = 'bayn.autonomous-cycle.v4' AND identity_schema_version = 'bayn.autonomous-cycle-identity.v4'
          AND strategy_name IN ('intraday-momentum', 'jev') AND entry_attempt_ordinal > 0)
        OR (schema_version <> 'bayn.autonomous-cycle.v4' AND identity_schema_version <> 'bayn.autonomous-cycle-identity.v4' AND entry_attempt_ordinal = 1)
      )
  `
  yield* sql`
    ALTER TABLE intraday_candidate_observations
      DROP CONSTRAINT intraday_candidate_observations_check,
      ADD CONSTRAINT intraday_candidate_observations_check CHECK (
        jsonb_typeof(payload) = 'object'
        AND payload->>'schemaVersion' IS NOT NULL
        AND payload->>'schemaVersion' IN ('bayn.intraday-candidate-observation.v2', 'bayn.jev-observation.v1')
        AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
        AND payload->>'observedAt' IS NOT NULL
        AND (payload->>'observedAt')::timestamptz = observed_at
      )
  `
})
