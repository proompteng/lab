import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import {
  ExecutionControllerOutcome,
  ExecutionControllerStatusSchema,
  ExecutionControllerStatusStore,
  ExecutionControllerStatusStoreError,
  executionControllerStatusHasCompletion,
  type ExecutionControllerStatus,
  type ExecutionControllerStatusProjection,
  type ExecutionControllerStatusStoreShape,
} from '../execution/controller-status'
import { ExecutionControllerKeySchema } from '../execution/controller-key'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'

const StatusRow = Schema.Struct({
  controller_key: ExecutionControllerKeySchema,
  plan_hash: Sha256Schema,
  active: Schema.Boolean,
  epoch: Schema.BigIntFromString,
  next_sequence: Schema.BigIntFromString,
  last_sequence: Schema.NullOr(Schema.BigIntFromString),
  last_outcome: Schema.NullOr(Schema.Enum(ExecutionControllerOutcome)),
  last_receipt_hash: Schema.NullOr(Sha256Schema),
  completed_at: Schema.NullOr(UtcInstantSchema),
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
  const nextSequence = Number(row.next_sequence)
  const noCompletion =
    row.last_sequence === null &&
    row.last_outcome === null &&
    row.last_receipt_hash === null &&
    row.completed_at === null &&
    row.next_due_at === null
  const completeEvidence =
    row.last_sequence !== null &&
    row.last_outcome !== null &&
    row.last_receipt_hash !== null &&
    row.completed_at !== null
  if (!noCompletion && !completeEvidence) {
    return Effect.fail(storeError('read', 'invariant', 'controller status row contains partial completion evidence'))
  }
  return Schema.decodeUnknownEffect(
    ExecutionControllerStatusSchema,
    strictParseOptions,
  )({
    schemaVersion: 1,
    controllerKey: row.controller_key,
    planHash: row.plan_hash,
    active: row.active,
    epoch,
    nextSequence,
    ...(noCompletion
      ? {}
      : {
          lastSequence: Number(row.last_sequence),
          lastOutcome: row.last_outcome,
          lastReceiptHash: row.last_receipt_hash,
          completedAt: row.completed_at,
          ...(row.next_due_at === null ? {} : { nextDueAt: row.next_due_at }),
        }),
  }).pipe(Effect.mapError((cause) => storeError('read', 'decode', 'controller status row failed decoding', cause)))
}

const selectStatus = (sql: PgClient.PgClient, controllerKey: string) =>
  sql<Record<string, unknown>>`
    SELECT
      controller_key,
      plan_hash,
      active,
      epoch,
      next_sequence,
      last_sequence,
      last_outcome,
      last_receipt_hash,
      CASE
        WHEN completed_at IS NULL THEN NULL
        ELSE to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS completed_at,
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
  left.nextSequence === right.nextSequence &&
  (executionControllerStatusHasCompletion(left)
    ? executionControllerStatusHasCompletion(right) &&
      left.lastSequence === right.lastSequence &&
      left.lastOutcome === right.lastOutcome &&
      left.lastReceiptHash === right.lastReceiptHash &&
      left.completedAt === right.completedAt &&
      left.nextDueAt === right.nextDueAt
    : !executionControllerStatusHasCompletion(right))

const statusIsNewer = (left: ExecutionControllerStatus, right: ExecutionControllerStatus): boolean =>
  left.epoch > right.epoch ||
  (left.epoch === right.epoch &&
    (left.nextSequence > right.nextSequence ||
      (left.nextSequence === right.nextSequence && left.active && !right.active)))

const project = (
  sql: PgClient.PgClient,
  candidate: ExecutionControllerStatus,
): Effect.Effect<ExecutionControllerStatusProjection, ExecutionControllerStatusStoreError> =>
  Schema.decodeUnknownEffect(
    ExecutionControllerStatusSchema,
    strictParseOptions,
  )(candidate).pipe(
    Effect.flatMap((status) => {
      const completion = executionControllerStatusHasCompletion(status) ? status : undefined
      return sql<Record<string, unknown>>`
        INSERT INTO execution_controller_status (
          controller_key,
          plan_hash,
          active,
          epoch,
          next_sequence,
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
          ${status.nextSequence},
          ${completion?.lastSequence ?? null},
          ${completion?.lastOutcome ?? null},
          ${completion?.lastReceiptHash ?? null},
          ${completion?.completedAt ?? null},
          ${completion?.nextDueAt ?? null}
        )
        ON CONFLICT (controller_key) DO UPDATE SET
          active = EXCLUDED.active,
          plan_hash = EXCLUDED.plan_hash,
          epoch = EXCLUDED.epoch,
          next_sequence = EXCLUDED.next_sequence,
          last_sequence = EXCLUDED.last_sequence,
          last_outcome = EXCLUDED.last_outcome,
          last_receipt_hash = EXCLUDED.last_receipt_hash,
          completed_at = EXCLUDED.completed_at,
          next_due_at = EXCLUDED.next_due_at,
          updated_at = clock_timestamp()
        WHERE EXCLUDED.epoch > execution_controller_status.epoch
           OR (
             EXCLUDED.epoch = execution_controller_status.epoch
             AND EXCLUDED.next_sequence > execution_controller_status.next_sequence
           )
           OR (
             EXCLUDED.epoch = execution_controller_status.epoch
             AND EXCLUDED.next_sequence = execution_controller_status.next_sequence
             AND execution_controller_status.active = false
             AND EXCLUDED.active = true
           )
           OR (
             EXCLUDED.epoch = execution_controller_status.epoch
             AND EXCLUDED.next_sequence = execution_controller_status.next_sequence
             AND execution_controller_status.plan_hash = repeat('0', 64)
             AND EXCLUDED.plan_hash <> execution_controller_status.plan_hash
             AND execution_controller_status.active = true
             AND EXCLUDED.active = true
             AND EXCLUDED.last_sequence IS NOT DISTINCT FROM execution_controller_status.last_sequence
             AND EXCLUDED.last_outcome IS NOT DISTINCT FROM execution_controller_status.last_outcome
             AND EXCLUDED.last_receipt_hash IS NOT DISTINCT FROM execution_controller_status.last_receipt_hash
             AND EXCLUDED.completed_at IS NOT DISTINCT FROM execution_controller_status.completed_at
             AND EXCLUDED.next_due_at IS NOT DISTINCT FROM execution_controller_status.next_due_at
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
              if (statusIsNewer(stored, status)) {
                return Effect.succeed<ExecutionControllerStatusProjection>({ _tag: 'Stale', status: stored })
              }
              return Effect.fail(
                storeError('project', 'conflict', 'controller epoch and sequence were reused with different evidence'),
              )
            }),
          )
        }),
      )
    }),
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
