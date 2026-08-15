import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import {
  ExecutionControllerKeySchema,
  ExecutionControllerOutcome,
  ExecutionControllerStatusSchema,
  ExecutionControllerStatusStore,
  ExecutionControllerStatusStoreError,
  type ExecutionControllerStatus,
  type ExecutionControllerStatusProjection,
  type ExecutionControllerStatusStoreShape,
} from '../execution/controller-status'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'

const StatusRow = Schema.Struct({
  controller_key: ExecutionControllerKeySchema,
  plan_hash: Sha256Schema,
  active: Schema.Boolean,
  epoch: Schema.BigIntFromString,
  last_sequence: Schema.BigIntFromString,
  last_outcome: Schema.Enum(ExecutionControllerOutcome),
  last_receipt_hash: Sha256Schema,
  completed_at: UtcInstantSchema,
  next_due_at: Schema.NullOr(UtcInstantSchema),
})
const StatusRows = Schema.Array(StatusRow).check(Schema.isMaxLength(1))

const storeError = (
  operation: ExecutionControllerStatusStoreError['operation'],
  failure: ExecutionControllerStatusStoreError['failure'],
  message: string,
  cause?: unknown,
): ExecutionControllerStatusStoreError =>
  new ExecutionControllerStatusStoreError({ operation, failure, message, cause })

const classifyCause = (
  operation: ExecutionControllerStatusStoreError['operation'],
  cause: unknown,
): ExecutionControllerStatusStoreError => {
  if (cause instanceof ExecutionControllerStatusStoreError) return cause
  if (Schema.isSchemaError(cause)) return storeError(operation, 'decode', 'controller status failed decoding', cause)
  if (isSqlError(cause)) {
    const failure =
      cause.reason._tag === 'ConstraintError' || cause.reason._tag === 'UniqueViolation' ? 'conflict' : 'query'
    return storeError(operation, failure, 'controller status persistence failed', cause)
  }
  return storeError(operation, 'query', 'controller status persistence failed', cause)
}

const statusFromRow = (
  row: typeof StatusRow.Type,
): Effect.Effect<ExecutionControllerStatus, ExecutionControllerStatusStoreError> => {
  const epoch = Number(row.epoch)
  const lastSequence = Number(row.last_sequence)
  return Schema.decodeUnknownEffect(
    ExecutionControllerStatusSchema,
    strictParseOptions,
  )({
    schemaVersion: 1,
    controllerKey: row.controller_key,
    planHash: row.plan_hash,
    active: row.active,
    epoch,
    lastSequence,
    lastOutcome: row.last_outcome,
    lastReceiptHash: row.last_receipt_hash,
    completedAt: row.completed_at,
    ...(row.next_due_at === null ? {} : { nextDueAt: row.next_due_at }),
  }).pipe(Effect.mapError((cause) => storeError('read', 'decode', 'controller status row failed decoding', cause)))
}

const selectStatus = (sql: PgClient.PgClient, controllerKey: string) =>
  sql<Record<string, unknown>>`
    SELECT
      controller_key,
      plan_hash,
      active,
      epoch,
      last_sequence,
      last_outcome,
      last_receipt_hash,
      to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at,
      CASE
        WHEN next_due_at IS NULL THEN NULL
        ELSE to_char(next_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS next_due_at
    FROM execution_controller_status
    WHERE controller_key = ${controllerKey}
  `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(StatusRows, strictParseOptions)))

const read = (
  sql: PgClient.PgClient,
  candidate: string,
): Effect.Effect<ExecutionControllerStatus | null, ExecutionControllerStatusStoreError> =>
  Schema.decodeUnknownEffect(
    ExecutionControllerKeySchema,
    strictParseOptions,
  )(candidate).pipe(
    Effect.flatMap((controllerKey) => selectStatus(sql, controllerKey)),
    Effect.flatMap((rows) => {
      const row = rows[0]
      return row === undefined ? Effect.succeed(null) : statusFromRow(row)
    }),
    Effect.mapError((cause) => classifyCause('read', cause)),
  )

const sameStatus = (left: ExecutionControllerStatus, right: ExecutionControllerStatus): boolean =>
  left.controllerKey === right.controllerKey &&
  left.planHash === right.planHash &&
  left.active === right.active &&
  left.epoch === right.epoch &&
  left.lastSequence === right.lastSequence &&
  left.lastOutcome === right.lastOutcome &&
  left.lastReceiptHash === right.lastReceiptHash &&
  left.completedAt === right.completedAt &&
  left.nextDueAt === right.nextDueAt

const project = (
  sql: PgClient.PgClient,
  candidate: ExecutionControllerStatus,
): Effect.Effect<ExecutionControllerStatusProjection, ExecutionControllerStatusStoreError> =>
  Schema.decodeUnknownEffect(
    ExecutionControllerStatusSchema,
    strictParseOptions,
  )(candidate).pipe(
    Effect.flatMap((status) =>
      sql<Record<string, unknown>>`
        INSERT INTO execution_controller_status (
          controller_key,
          plan_hash,
          active,
          epoch,
          last_sequence,
          last_outcome,
          last_receipt_hash,
          completed_at,
          next_due_at
        ) VALUES (
          ${status.controllerKey},
          ${status.planHash},
          ${status.active},
          ${status.epoch},
          ${status.lastSequence},
          ${status.lastOutcome},
          ${status.lastReceiptHash},
          ${status.completedAt},
          ${status.nextDueAt ?? null}
        )
        ON CONFLICT (controller_key) DO UPDATE SET
          active = EXCLUDED.active,
          plan_hash = EXCLUDED.plan_hash,
          epoch = EXCLUDED.epoch,
          last_sequence = EXCLUDED.last_sequence,
          last_outcome = EXCLUDED.last_outcome,
          last_receipt_hash = EXCLUDED.last_receipt_hash,
          completed_at = EXCLUDED.completed_at,
          next_due_at = EXCLUDED.next_due_at,
          updated_at = clock_timestamp()
        WHERE EXCLUDED.epoch > execution_controller_status.epoch
           OR (
             EXCLUDED.epoch = execution_controller_status.epoch
             AND EXCLUDED.last_sequence > execution_controller_status.last_sequence
           )
        RETURNING controller_key
      `.pipe(
        Effect.flatMap((rows) => {
          if (rows.length > 0) {
            return Effect.succeed<ExecutionControllerStatusProjection>({ _tag: 'Applied', status })
          }
          return read(sql, status.controllerKey).pipe(
            Effect.flatMap((stored) => {
              if (stored === null) {
                return Effect.fail(storeError('project', 'invariant', 'controller status disappeared after projection'))
              }
              if (sameStatus(stored, status)) {
                return Effect.succeed<ExecutionControllerStatusProjection>({ _tag: 'Replayed', status: stored })
              }
              if (
                stored.epoch > status.epoch ||
                (stored.epoch === status.epoch && stored.lastSequence > status.lastSequence)
              ) {
                return Effect.succeed<ExecutionControllerStatusProjection>({ _tag: 'Stale', status: stored })
              }
              return Effect.fail(
                storeError('project', 'conflict', 'controller epoch and sequence were reused with different evidence'),
              )
            }),
          )
        }),
      ),
    ),
    Effect.mapError((cause) => classifyCause('project', cause)),
  )

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return {
    project: (status) => project(sql, status),
    read: (controllerKey) => read(sql, controllerKey),
  } satisfies ExecutionControllerStatusStoreShape
})

export const ExecutionControllerStatusStoreLive = Layer.effect(ExecutionControllerStatusStore, makeStore)
