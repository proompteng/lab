import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Schema } from 'effect'

import { WriterFence } from '../execution/writer-fence'
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
