import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Schema } from 'effect'

import { WriterFence } from '../execution/writer-fence'
import {
  decodeForwardPerformanceReceiptEnvelopeResult,
  ForwardPerformanceReceiptStore,
  ForwardPerformanceReceiptStoreError,
  type ForwardPerformanceReceiptEnvelope,
  type ForwardPerformanceReceiptStoreShape,
} from './forward-performance-receipt'

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1)))

const storeError = (
  operation: ForwardPerformanceReceiptStoreError['operation'],
  failure: ForwardPerformanceReceiptStoreError['failure'],
  message: string,
  cause?: unknown,
): ForwardPerformanceReceiptStoreError =>
  new ForwardPerformanceReceiptStoreError({ operation, failure, message, cause })

const readByGeneration = (
  sql: PgClient.PgClient,
  authorityGenerationHash: string,
): Effect.Effect<Option.Option<ForwardPerformanceReceiptEnvelope>, ForwardPerformanceReceiptStoreError> =>
  sql<Record<string, unknown>>`
    SELECT document
    FROM autonomous_forward_performance_receipts
    WHERE authority_generation_hash = ${authorityGenerationHash}
  `.pipe(
    Effect.flatMap((rows) => decodeRows(rows)),
    Effect.flatMap((rows) => {
      const row = rows[0]
      if (row === undefined) return Effect.succeed(Option.none())
      if (typeof row !== 'object' || row === null || !('document' in row)) {
        return Effect.fail(storeError('read', 'decode', 'forward-performance receipt row is missing its document'))
      }
      const decoded = decodeForwardPerformanceReceiptEnvelopeResult(row.document)
      return decoded._tag === 'Failure'
        ? Effect.fail(
            storeError(
              'read',
              'decode',
              'forward-performance receipt envelope failed schema validation',
              decoded.failure,
            ),
          )
        : Effect.succeed(Option.some(decoded.success))
    }),
    Effect.mapError((cause) =>
      cause instanceof ForwardPerformanceReceiptStoreError
        ? cause
        : storeError('read', 'query', 'forward-performance receipt read failed', cause),
    ),
  )

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const fence = yield* WriterFence
  const store: ForwardPerformanceReceiptStoreShape = {
    read: (authorityGenerationHash) => readByGeneration(sql, authorityGenerationHash),
    bind: (envelope) =>
      fence
        .transaction(
          Effect.gen(function* () {
            yield* sql`
            INSERT INTO autonomous_forward_performance_receipts (
              authority_generation_hash,
              cycle_id,
              document,
              created_at
            ) VALUES (
              ${envelope.authorityGenerationHash},
              ${envelope.cycleId},
              ${sql.json(envelope)},
              ${envelope.createdAt}
            )
            ON CONFLICT (authority_generation_hash) DO NOTHING
          `
            const stored = yield* readByGeneration(sql, envelope.authorityGenerationHash)
            if (Option.isNone(stored)) {
              return yield* Effect.fail(
                storeError('bind', 'invariant', 'forward-performance receipt disappeared after its immutable bind'),
              )
            }
            if (stored.value.contentHash !== envelope.contentHash) {
              return yield* Effect.fail(
                storeError(
                  'bind',
                  'conflict',
                  'forward-performance receipt generation was reused with different immutable content',
                ),
              )
            }
            return stored.value
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof ForwardPerformanceReceiptStoreError
              ? cause
              : storeError('bind', 'query', 'forward-performance receipt bind failed', cause),
          ),
        ),
  }
  return store
})

export const ForwardPerformanceReceiptStoreLive = Layer.effect(ForwardPerformanceReceiptStore, makeStore)
