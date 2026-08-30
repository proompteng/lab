import { Effect, Result } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

import { makeStrategyProtocolHashResult } from '../src/contracts'
import { canonicalHashV1OrThrow } from '../src/hash'
import { intradayMomentumBehaviorHash } from '../src/strategy/intraday-momentum/decision'
import { defaultIntradayMomentumProtocolDocument } from '../src/strategy/intraday-momentum/protocol'

const currentStrategyProtocolHash = Result.getOrThrow(
  makeStrategyProtocolHashResult({
    name: 'intraday-momentum',
    behaviorHash: intradayMomentumBehaviorHash,
    parameterHash: canonicalHashV1OrThrow(defaultIntradayMomentumProtocolDocument),
    parameterSchemaVersion: 'bayn.intraday-momentum.protocol.v2',
  }),
)

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
          'bayn.intraday-momentum.protocol.v2'
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
            'bayn.intraday-momentum.protocol.v2'
          )
        )
      )
  `

  const [unfinishedRetiredCycle] = yield* sql<{ readonly present: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM autonomous_cycles AS cycle
      WHERE (
          cycle.strategy_name <> 'intraday-momentum'
          OR cycle.strategy_protocol_hash IS DISTINCT FROM ${currentStrategyProtocolHash}
        )
        AND cycle.state IN ('PENDING', 'ACTIVE')
        AND (
          cycle.decision_hash IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM autonomous_cycle_shadow_decisions AS decision
            WHERE decision.cycle_id = cycle.cycle_id
          )
          OR EXISTS (
            SELECT 1
            FROM intents AS intent
            WHERE intent.cycle_id = cycle.cycle_id
          )
        )
    ) AS present
  `
  if (unfinishedRetiredCycle?.present !== false) {
    return yield* Effect.die(new Error('intraday cutover found unfinished retired-strategy mutation evidence'))
  }

  yield* sql`
    UPDATE autonomous_cycles
    SET
      state = 'BLOCKED',
      terminal_reason = 'BLOCKED_KILL_ACTIVE',
      state_version = state_version + 1,
      updated_at = GREATEST(updated_at, transaction_timestamp()),
      terminal_at = GREATEST(updated_at, transaction_timestamp())
    WHERE (
        strategy_name <> 'intraday-momentum'
        OR strategy_protocol_hash IS DISTINCT FROM ${currentStrategyProtocolHash}
      )
      AND state IN ('PENDING', 'ACTIVE')
  `
})
