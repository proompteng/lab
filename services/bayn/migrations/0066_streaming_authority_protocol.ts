import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE authority_generations
      DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check,
      DROP CONSTRAINT authority_generations_strategy_contract_check,
      ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
        strategy_parameter_schema_version IN (
          'bayn.risk-balanced-trend.protocol.v3',
          'bayn.risk-balanced-trend.protocol.v4',
          'bayn.opening-drive.protocol.v2',
          'bayn.intraday-momentum.protocol.v1',
          'bayn.intraday-momentum.protocol.v2',
          'bayn.intraday-momentum.protocol.v3'
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
          AND strategy_parameter_schema_version IN (
            'bayn.intraday-momentum.protocol.v1',
            'bayn.intraday-momentum.protocol.v2',
            'bayn.intraday-momentum.protocol.v3'
          )
        )
      )
  `
})
