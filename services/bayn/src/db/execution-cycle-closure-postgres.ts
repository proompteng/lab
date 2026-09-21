import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Schema } from 'effect'

import { WriterFence } from '../execution/writer-fence'
import { canonicalHashV1Result } from '../hash'
import { jevExitCommitDeadline, JevExitReason } from '../jev/exit'
import { currentUtcInstant } from '../time'
import { verifyJevPortfolioSources } from './jev-position-postgres'
import {
  ExecutionCycleClosureStore,
  ExecutionCycleClosureStoreError,
  decodeExecutionCycleClosureResult,
  type ExecutionCycleClosure,
  type ExecutionCycleClosureStoreShape,
} from './execution-cycle-closure'

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1)))

const storeError = (
  operation: ExecutionCycleClosureStoreError['operation'],
  failure: ExecutionCycleClosureStoreError['failure'],
  message: string,
  cause?: unknown,
): ExecutionCycleClosureStoreError => new ExecutionCycleClosureStoreError({ operation, failure, message, cause })

const readByCycleId = (
  sql: PgClient.PgClient,
  cycleId: string,
): Effect.Effect<Option.Option<ExecutionCycleClosure>, ExecutionCycleClosureStoreError> =>
  sql<Record<string, unknown>>`
    SELECT document
    FROM autonomous_cycle_paper_closures
    WHERE cycle_id = ${cycleId}
  `.pipe(
    Effect.flatMap((rows) => decodeRows(rows)),
    Effect.flatMap((rows) => {
      const row = rows[0]
      if (row === undefined) return Effect.succeed(Option.none())
      if (typeof row !== 'object' || row === null || !('document' in row)) {
        return Effect.fail(storeError('read', 'decode', 'execution closure row is missing its document'))
      }
      const decoded = decodeExecutionCycleClosureResult(row.document)
      return decoded._tag === 'Failure'
        ? Effect.fail(
            storeError('read', 'decode', 'execution closure document failed schema validation', decoded.failure),
          )
        : Effect.succeed(Option.some(decoded.success))
    }),
    Effect.mapError((cause) =>
      cause instanceof ExecutionCycleClosureStoreError
        ? cause
        : storeError('read', 'query', 'execution closure read failed', cause),
    ),
  )

const readLatestReplanByCycleId = (
  sql: PgClient.PgClient,
  cycleId: string,
): Effect.Effect<Option.Option<ExecutionCycleClosure>, ExecutionCycleClosureStoreError> =>
  sql<Record<string, unknown>>`
    SELECT document
    FROM autonomous_cycle_paper_close_replans
    WHERE cycle_id = ${cycleId}
    ORDER BY created_at DESC, content_hash COLLATE "C" DESC
    LIMIT 1
  `.pipe(
    Effect.flatMap((rows) => decodeRows(rows)),
    Effect.flatMap((rows) => {
      const row = rows[0]
      if (row === undefined) return Effect.succeed(Option.none())
      if (typeof row !== 'object' || row === null || !('document' in row)) {
        return Effect.fail(storeError('read-replan', 'decode', 'execution close replan row is missing its document'))
      }
      const decoded = decodeExecutionCycleClosureResult(row.document)
      return decoded._tag === 'Failure'
        ? Effect.fail(
            storeError('read-replan', 'decode', 'execution close replan failed schema validation', decoded.failure),
          )
        : Effect.succeed(Option.some(decoded.success))
    }),
    Effect.mapError((cause) =>
      cause instanceof ExecutionCycleClosureStoreError
        ? cause
        : storeError('read-replan', 'query', 'execution close replan read failed', cause),
    ),
  )

const readReplanByHash = (
  sql: PgClient.PgClient,
  cycleId: string,
  contentHash: string,
): Effect.Effect<Option.Option<ExecutionCycleClosure>, ExecutionCycleClosureStoreError> =>
  sql<Record<string, unknown>>`
    SELECT document
    FROM autonomous_cycle_paper_close_replans
    WHERE cycle_id = ${cycleId}
      AND content_hash = ${contentHash}
  `.pipe(
    Effect.flatMap((rows) => decodeRows(rows)),
    Effect.flatMap((rows) => {
      const row = rows[0]
      if (row === undefined) return Effect.succeed(Option.none())
      if (typeof row !== 'object' || row === null || !('document' in row)) {
        return Effect.fail(storeError('bind-replan', 'decode', 'execution close replan row is missing its document'))
      }
      const decoded = decodeExecutionCycleClosureResult(row.document)
      return decoded._tag === 'Failure'
        ? Effect.fail(
            storeError('bind-replan', 'decode', 'execution close replan failed schema validation', decoded.failure),
          )
        : Effect.succeed(Option.some(decoded.success))
    }),
    Effect.mapError((cause) =>
      cause instanceof ExecutionCycleClosureStoreError
        ? cause
        : storeError('bind-replan', 'query', 'execution close replan read failed', cause),
    ),
  )

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const fence = yield* WriterFence
  const verifyExit = (closure: ExecutionCycleClosure, original?: ExecutionCycleClosure) =>
    Effect.gen(function* () {
      const target = closure.document.strategyDecision
      if (target?.schemaVersion !== 'bayn.jev-exit-target.v1') {
        if (original?.document.strategyDecision?.schemaVersion === 'bayn.jev-exit-target.v1')
          return yield* storeError('bind-replan', 'invariant', 'A Jev close replan cannot discard its exit evidence')
        return
      }
      const binding = closure.document.bindings
      yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]))(
        yield* sql`
      SELECT EXISTS (
        SELECT 1 FROM reconciliations WHERE reconciliation_id = ${binding.reconciliationId}
          AND account_id = ${binding.accountId} AND expected_hash = ${binding.planningBrokerStateHash}
          AND observed_hash = ${binding.planningBrokerStateHash} AND content_hash = ${binding.reconciliationHash}
          AND status = 'EXACT' AND discrepancies = '[]'::jsonb AND reconciled_at <= ${closure.createdAt}::timestamptz
      ) AS matches
    `,
      )
      if (original !== undefined) {
        const first = yield* Effect.fromResult(canonicalHashV1Result(original.document.strategyDecision))
        const next = yield* Effect.fromResult(canonicalHashV1Result(target))
        const prior = closure.document.replanGenerationHash
        const latest = yield* readLatestReplanByCycleId(sql, closure.cycleId)
        const predecessor = Option.getOrElse(latest, () => original)
        if (
          first !== next ||
          closure.entryDecisionHash !== original.entryDecisionHash ||
          closure.expiresAt !== original.expiresAt ||
          prior !== predecessor.contentHash ||
          closure.createdAt <= predecessor.createdAt
        )
          return yield* storeError(
            'bind-replan',
            'invariant',
            'Jev residual close must preserve its committed trigger and exact predecessor',
          )
        return
      }
      const now = yield* currentUtcInstant
      if (
        closure.document.replanGenerationHash !== undefined ||
        now < closure.createdAt ||
        now >= jevExitCommitDeadline(target)
      )
        return yield* storeError('bind', 'invariant', 'The initial Jev exit evidence expired before durable commitment')
      yield* verifyJevPortfolioSources(sql, closure.cycleId, target.evidence.portfolio)
      const trigger = target.evidence.trigger
      if (trigger.reason === JevExitReason.Model) {
        const e = trigger.decision.evidence
        yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]))(
          yield* sql`
        SELECT EXISTS (
          SELECT 1 FROM jev_batch_plans AS plan JOIN jev_batch_results AS result USING (batch_id)
          JOIN intraday_candidate_observations AS observation ON observation.content_hash = plan.observation_hash
          WHERE plan.cycle_id = ${closure.cycleId} AND plan.batch_id = ${e.batchPlan.batchId}
            AND plan.payload = ${sql.json(e.batchPlan)} AND result.payload = ${sql.json(e.batchResult)}
            AND observation.payload = ${sql.json(e.observation)}
        ) AS matches
      `,
        )
      }
    })
  const store: ExecutionCycleClosureStoreShape = {
    read: (cycleId) => readByCycleId(sql, cycleId),
    readLatestReplan: (cycleId) => readLatestReplanByCycleId(sql, cycleId),
    containsIntent: (intentId) =>
      sql<{ readonly contains: boolean }>`
        SELECT EXISTS (
          SELECT 1
          FROM autonomous_cycle_paper_closures AS closure,
          LATERAL jsonb_array_elements_text(closure.document #> '{document,orderedIntentIds}') AS intent(value)
          WHERE intent.value = ${intentId}
        ) OR EXISTS (
          SELECT 1
          FROM autonomous_cycle_paper_close_replans AS replan,
          LATERAL jsonb_array_elements_text(replan.document #> '{document,orderedIntentIds}') AS intent(value)
          WHERE intent.value = ${intentId}
        ) AS contains
      `.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0]
          return row === undefined
            ? Effect.fail(storeError('contains-intent', 'invariant', 'execution closure intent query returned no row'))
            : Effect.succeed(row.contains)
        }),
        Effect.mapError((cause) =>
          cause instanceof ExecutionCycleClosureStoreError
            ? cause
            : storeError('contains-intent', 'query', 'execution closure intent lookup failed', cause),
        ),
      ),
    bindReplan: (closure) =>
      fence
        .transaction(
          Effect.gen(function* () {
            const replay = yield* readReplanByHash(sql, closure.cycleId, closure.contentHash)
            if (Option.isSome(replay)) return replay.value
            const original = yield* readByCycleId(sql, closure.cycleId)
            if (
              closure.document.strategyDecision?.schemaVersion === 'bayn.jev-exit-target.v1' &&
              Option.isNone(original)
            )
              return yield* storeError(
                'bind-replan',
                'invariant',
                'Jev residual close requires an initial committed exit',
              )
            yield* verifyExit(closure, Option.getOrUndefined(original))
            yield* sql`
            INSERT INTO autonomous_cycle_paper_close_replans (
              content_hash,
              cycle_id,
              document,
              created_at,
              expires_at
            ) VALUES (
              ${closure.contentHash},
              ${closure.cycleId},
              ${sql.json(closure)},
              ${closure.createdAt},
              ${closure.expiresAt}
            )
            ON CONFLICT (content_hash) DO NOTHING
          `
            const stored = yield* readReplanByHash(sql, closure.cycleId, closure.contentHash)
            if (Option.isNone(stored)) {
              return yield* storeError(
                'bind-replan',
                'invariant',
                'execution close replan disappeared after its immutable bind',
              )
            }
            if (stored.value.contentHash !== closure.contentHash) {
              return yield* storeError(
                'bind-replan',
                'conflict',
                'execution close replan identity was reused with different content',
              )
            }
            return stored.value
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof ExecutionCycleClosureStoreError
              ? cause
              : storeError('bind-replan', 'query', 'execution close replan bind failed', cause),
          ),
        ),
    bind: (closure) =>
      fence
        .transaction(
          Effect.gen(function* () {
            const existing = yield* readByCycleId(sql, closure.cycleId)
            if (Option.isSome(existing)) {
              if (existing.value.contentHash !== closure.contentHash)
                return yield* storeError(
                  'bind',
                  'conflict',
                  'Execution closure already has different immutable content',
                )
              return existing.value
            }
            yield* verifyExit(closure)
            yield* sql`
            INSERT INTO autonomous_cycle_paper_closures (
              cycle_id,
              document,
              created_at,
              expires_at
            ) VALUES (
              ${closure.cycleId},
              ${sql.json(closure)},
              ${closure.createdAt},
              ${closure.expiresAt}
            )
            ON CONFLICT (cycle_id) DO NOTHING
          `
            const stored = yield* readByCycleId(sql, closure.cycleId)
            if (Option.isNone(stored)) {
              return yield* storeError('bind', 'invariant', 'execution closure disappeared after its immutable bind')
            }
            if (stored.value.contentHash !== closure.contentHash) {
              return yield* storeError(
                'bind',
                'conflict',
                'execution closure identity was reused with different immutable content',
              )
            }
            return stored.value
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof ExecutionCycleClosureStoreError
              ? cause
              : storeError('bind', 'query', 'execution closure bind failed', cause),
          ),
        ),
  }
  return store
})

export const ExecutionCycleClosureStoreLive = Layer.effect(ExecutionCycleClosureStore, makeStore)
