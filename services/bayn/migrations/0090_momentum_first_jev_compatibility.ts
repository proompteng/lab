import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Permit new immutable evidence without rewriting old rows or granting authority.
  yield* sql`
    ALTER TABLE jev_batch_plans
      DROP CONSTRAINT jev_batch_plans_check,
      ADD CONSTRAINT jev_batch_plans_check CHECK (
        jsonb_typeof(payload) = 'object'
        AND (payload->>'schemaVersion' IN ('bayn.jev-batch-plan.v1', 'bayn.jev-batch-plan.v2',
          'bayn.jev-batch-plan.v3', 'bayn.jev-batch-plan.v4')) IS TRUE
        AND payload->>'batchId' IS NOT DISTINCT FROM batch_id
        AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
        AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
        AND payload->>'observationHash' IS NOT DISTINCT FROM observation_hash
      )
  `
  yield* sql`
    ALTER TABLE authority_generations
      DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check,
      DROP CONSTRAINT authority_generations_strategy_contract_check,
      ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
        strategy_parameter_schema_version IN ('bayn.risk-balanced-trend.protocol.v3', 'bayn.risk-balanced-trend.protocol.v4',
          'bayn.opening-drive.protocol.v2', 'bayn.intraday-momentum.protocol.v1', 'bayn.intraday-momentum.protocol.v2',
          'bayn.intraday-momentum.protocol.v3', 'bayn.jev.protocol.v1', 'bayn.jev.protocol.v2')
      ),
      ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
        (strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
        OR (strategy_name = 'risk-balanced-trend' AND strategy_parameter_schema_version IN ('bayn.risk-balanced-trend.protocol.v3', 'bayn.risk-balanced-trend.protocol.v4'))
        OR (strategy_name = 'opening-drive-momentum' AND strategy_parameter_schema_version = 'bayn.opening-drive.protocol.v2')
        OR (strategy_name = 'intraday-momentum' AND strategy_parameter_schema_version IN ('bayn.intraday-momentum.protocol.v1', 'bayn.intraday-momentum.protocol.v2', 'bayn.intraday-momentum.protocol.v3'))
        OR (strategy_name = 'jev' AND strategy_parameter_schema_version IN ('bayn.jev.protocol.v1', 'bayn.jev.protocol.v2'))
      )
  `
})
