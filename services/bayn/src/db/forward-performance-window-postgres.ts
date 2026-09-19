import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { WriterFence } from '../execution/writer-fence'
import { Sha256Schema } from '../schemas'
import {
  ForwardPerformanceWindowError,
  ForwardPerformanceWindowSchema,
  type ForwardPerformanceWindow,
} from './forward-performance-window'

const GenerationRows = Schema.Array(Schema.Struct({ generation_hash: Sha256Schema })).check(Schema.isMaxLength(1))
const PublishedRows = Schema.Tuple([
  Schema.Struct({ document: ForwardPerformanceWindowSchema, recorded_at: Schema.Date }),
])

export const publishForwardPerformanceWindow = (accountId: string, window: ForwardPerformanceWindow) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const fence = yield* WriterFence
    const { receipt } = window
    const strategy = receipt.bindings.strategy
    if (strategy === null)
      return yield* new ForwardPerformanceWindowError({
        operation: 'publish',
        failure: 'binding',
        message: 'performance window lacks a strategy binding',
      })
    return yield* fence.transaction(
      Effect.gen(function* () {
        const bindings = yield* sql`
          SELECT generation.generation_hash
          FROM authority_generations AS generation
          JOIN autonomous_cycles AS first_cycle ON first_cycle.cycle_id = ${receipt.window.firstCycleId}
          JOIN autonomous_cycles AS last_cycle ON last_cycle.cycle_id = ${receipt.window.lastCycleId}
          JOIN reconciliations AS reconciliation ON reconciliation.reconciliation_id = ${receipt.window.reconciliationId}
          WHERE generation.generation_hash = ${window.authorityGenerationHash}
            AND generation.account_id = ${accountId}
            AND generation.broker_identity_hash = ${receipt.bindings.account.accountReferenceHash}
            AND generation.broker_provider = ${receipt.bindings.account.provider}
            AND generation.broker_environment = ${receipt.bindings.account.environment}
            AND generation.strategy_name = ${strategy.strategyName}
            AND coalesce(generation.strategy_protocol_hash, generation.protocol_hash) = ${strategy.strategyProtocolHash}
            AND generation.strategy_behavior_hash = ${strategy.strategyBehaviorHash}
            AND generation.strategy_parameter_hash = ${strategy.strategyParameterHash}
            AND generation.strategy_parameter_schema_version = ${strategy.strategyParameterSchemaVersion}
            AND coalesce(generation.qualification_run_id, generation.research_plan_hash) = ${strategy.qualificationRunId}
            AND first_cycle.account_id = generation.account_id
            AND last_cycle.account_id = generation.account_id
            AND first_cycle.qualification_run_id = ${strategy.qualificationRunId}
            AND last_cycle.qualification_run_id = ${strategy.qualificationRunId}
            AND first_cycle.strategy_protocol_hash = ${strategy.strategyProtocolHash}
            AND last_cycle.strategy_protocol_hash = ${strategy.strategyProtocolHash}
            AND first_cycle.state IN ('COMPLETED', 'NO_TRADE')
            AND last_cycle.state IN ('COMPLETED', 'NO_TRADE')
            AND first_cycle.terminal_at <= ${receipt.window.closedAt}::timestamptz
            AND last_cycle.terminal_at <= ${receipt.window.closedAt}::timestamptz
            AND reconciliation.account_id = generation.account_id
            AND reconciliation.content_hash = ${receipt.window.reconciliationContentHash}
            AND reconciliation.reconciled_at = ${receipt.window.closedAt}::timestamptz
            AND reconciliation.reconciled_at <= CURRENT_TIMESTAMP
        `
        const generations = yield* Schema.decodeUnknownEffect(GenerationRows)(bindings)
        if (generations.length !== 1)
          return yield* new ForwardPerformanceWindowError({
            operation: 'publish',
            failure: 'binding',
            message:
              'performance window does not match the durable account, generation, terminal cycles and reconciliation',
          })
        yield* sql`
          INSERT INTO forward_performance_windows (
            window_id, authority_generation_hash, first_cycle_id, last_cycle_id,
            reconciliation_id, evidence_cutoff_at, document
          ) VALUES (
            ${window.windowId}, ${window.authorityGenerationHash}, ${receipt.window.firstCycleId}, ${receipt.window.lastCycleId},
            ${receipt.window.reconciliationId}, ${receipt.window.closedAt}, ${sql.json(window)}
          ) ON CONFLICT (window_id) DO NOTHING
        `
        const rows = yield* sql`
          SELECT document, recorded_at FROM forward_performance_windows WHERE window_id = ${window.windowId}
        `
        const [stored] = yield* Schema.decodeUnknownEffect(PublishedRows)(rows)
        if (stored.document.contentHash !== window.contentHash)
          return yield* new ForwardPerformanceWindowError({
            operation: 'publish',
            failure: 'conflict',
            message: 'performance window cut already has different immutable content',
          })
        return { window: stored.document, recordedAt: stored.recorded_at.toISOString() }
      }),
    )
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ForwardPerformanceWindowError
        ? cause
        : new ForwardPerformanceWindowError({
            operation: 'publish',
            failure: 'query',
            message: 'performance window publication failed',
            cause,
          }),
    ),
  )
