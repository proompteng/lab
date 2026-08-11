import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import {
  AutonomousCyclePassObservationSchema,
  MonthEndCadenceDecisionSchema,
  type AutonomousCyclePassObservation,
} from '../runtime-state'
import {
  LifecycleCommandStore,
  LifecycleCommandStoreError,
  type LifecycleCommandCompletionInput,
  type LifecycleCommandCursor,
  type LifecycleCommandInput,
  type LifecycleCommandStoreShape,
} from './lifecycle-command'

const ControllerKeySchema = Schema.Trim.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/))
const SequenceSchema = Schema.Int.check(Schema.isGreaterThan(0))

const CommandInputSchema = Schema.Struct({
  controllerKey: ControllerKeySchema,
  commandId: Sha256Schema,
  sequence: SequenceSchema,
  issuedAt: UtcInstantSchema,
})

const CompletionInputSchema = Schema.Struct({
  ...CommandInputSchema.fields,
  completedAt: UtcInstantSchema,
  observation: AutonomousCyclePassObservationSchema,
})

const CommandRow = Schema.Struct({
  command_id: Sha256Schema,
  sequence: Schema.BigIntFromString,
  issued_at: UtcInstantSchema,
  status: Schema.Literals(['STARTED', 'COMPLETED']),
  result: Schema.NullOr(Schema.Literals(['SUCCESS', 'FAILURE'])),
  outcome: Schema.NullOr(Schema.NonEmptyString),
  operation: Schema.NullOr(Schema.NonEmptyString),
  failure: Schema.NullOr(Schema.NonEmptyString),
  message: Schema.NullOr(Schema.NonEmptyString),
  observed_at: Schema.NullOr(UtcInstantSchema),
  cadence_decision: Schema.NullOr(MonthEndCadenceDecisionSchema),
})

const CommandRows = Schema.Tuple([CommandRow])

const PreviousSequenceRows = Schema.Tuple([Schema.Struct({ previous_sequence: Schema.BigIntFromString })])
const CursorRows = Schema.Array(CommandRow)

const storeError = (
  failure: LifecycleCommandStoreError['failure'],
  message: string,
  cause?: unknown,
): LifecycleCommandStoreError => new LifecycleCommandStoreError({ failure, message, cause })

const classifyCause = (cause: unknown): LifecycleCommandStoreError => {
  if (cause instanceof LifecycleCommandStoreError) return cause
  if (Schema.isSchemaError(cause)) return storeError('decode', 'lifecycle command evidence failed decoding', cause)
  if (isSqlError(cause)) {
    const failure =
      cause.reason._tag === 'ConstraintError' || cause.reason._tag === 'UniqueViolation' ? 'conflict' : 'query'
    return storeError(failure, 'lifecycle command persistence failed', cause)
  }
  return storeError('query', 'lifecycle command persistence failed', cause)
}

const decodeObservation = (
  row: (typeof CommandRows.Type)[0],
): Effect.Effect<AutonomousCyclePassObservation, LifecycleCommandStoreError> => {
  if (row.result === 'SUCCESS' && row.outcome !== null && row.observed_at !== null) {
    return Schema.decodeUnknownEffect(
      AutonomousCyclePassObservationSchema,
      strictParseOptions,
    )({
      result: 'SUCCESS',
      outcome: row.outcome,
      observedAt: row.observed_at,
      ...(row.cadence_decision === null ? {} : { cadenceDecision: row.cadence_decision }),
    }).pipe(Effect.mapError((cause) => storeError('decode', 'lifecycle command observation failed decoding', cause)))
  }
  if (
    row.result === 'FAILURE' &&
    row.operation !== null &&
    row.failure !== null &&
    row.message !== null &&
    row.observed_at !== null
  ) {
    return Schema.decodeUnknownEffect(
      AutonomousCyclePassObservationSchema,
      strictParseOptions,
    )({
      result: 'FAILURE',
      operation: row.operation as never,
      failure: row.failure as never,
      message: row.message,
      observedAt: row.observed_at,
    }).pipe(Effect.mapError((cause) => storeError('decode', 'lifecycle command observation failed decoding', cause)))
  }
  return Effect.fail(storeError('invariant', 'completed lifecycle command has an invalid observation projection'))
}

const readCursor = (
  sql: PgClient.PgClient,
  controllerKey: string,
): Effect.Effect<LifecycleCommandCursor, LifecycleCommandStoreError> =>
  Schema.decodeUnknownEffect(
    ControllerKeySchema,
    strictParseOptions,
  )(controllerKey).pipe(
    Effect.flatMap((validatedControllerKey) =>
      sql<Record<string, unknown>>`
        SELECT
               command_id,
               sequence,
               to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,
               status,
               result,
               outcome,
               operation,
               failure,
               message,
               CASE
                 WHEN observed_at IS NULL THEN NULL
                 ELSE to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               END AS observed_at,
               cadence_decision
        FROM lifecycle_commands
        WHERE controller_key = ${validatedControllerKey}
        ORDER BY sequence DESC
        LIMIT 1
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CursorRows, strictParseOptions))),
    ),
    Effect.flatMap((rows) => {
      const row = rows[0]
      if (row === undefined) {
        return Effect.succeed<LifecycleCommandCursor>({ _tag: 'Next', sequence: 1 })
      }
      const next = Number(row.sequence) + 1
      if (!Number.isSafeInteger(next)) {
        return Effect.fail(storeError('invariant', 'lifecycle command sequence exhausted the safe integer range'))
      }
      return row.status === 'STARTED'
        ? Effect.succeed<LifecycleCommandCursor>({
            _tag: 'Pending',
            command: {
              controllerKey,
              commandId: row.command_id,
              sequence: Number(row.sequence),
              issuedAt: row.issued_at,
            },
          })
        : Effect.succeed<LifecycleCommandCursor>({ _tag: 'Next', sequence: next })
    }),
    Effect.mapError(classifyCause),
  )

const begin = (sql: PgClient.PgClient, candidate: LifecycleCommandInput) =>
  Schema.decodeUnknownEffect(
    CommandInputSchema,
    strictParseOptions,
  )(candidate).pipe(
    Effect.flatMap((input) =>
      Effect.gen(function* () {
        const inserted = yield* sql<Record<string, unknown>>`
          INSERT INTO lifecycle_commands (
            controller_key, command_id, sequence, issued_at, status, started_at
          ) VALUES (
            ${input.controllerKey}, ${input.commandId}, ${input.sequence}, ${input.issuedAt}, 'STARTED', clock_timestamp()
          )
          ON CONFLICT DO NOTHING
          RETURNING command_id
        `
        const rows = yield* sql<Record<string, unknown>>`
          SELECT
                 command_id,
                 sequence,
                 to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,
                 status,
                 result,
                 outcome,
                 operation,
                 failure,
                 message,
                 CASE
                   WHEN observed_at IS NULL THEN NULL
                   ELSE to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                 END AS observed_at,
                 cadence_decision
          FROM lifecycle_commands
          WHERE controller_key = ${input.controllerKey}
            AND command_id = ${input.commandId}
          FOR UPDATE
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CommandRows, strictParseOptions)))
        const [row] = rows
        if (row.sequence !== BigInt(input.sequence) || row.issued_at !== input.issuedAt) {
          return yield* storeError('conflict', 'lifecycle command identity does not match its durable command id')
        }
        if (inserted.length > 0) {
          const [previous] = yield* sql<Record<string, unknown>>`
            SELECT COALESCE(max(sequence), 0)::bigint AS previous_sequence
            FROM lifecycle_commands
            WHERE controller_key = ${input.controllerKey}
              AND command_id <> ${input.commandId}
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(PreviousSequenceRows, strictParseOptions)))
          if (BigInt(input.sequence) !== previous.previous_sequence + 1n) {
            return yield* storeError('invariant', 'lifecycle command sequence is not contiguous', {
              expectedSequence: (previous.previous_sequence + 1n).toString(),
              actualSequence: input.sequence,
            })
          }
        }
        if (row.status === 'COMPLETED') {
          return { _tag: 'Completed' as const, observation: yield* decodeObservation(row) }
        }
        return { _tag: 'Execute' as const }
      }),
    ),
    Effect.mapError(classifyCause),
  )

const complete = (sql: PgClient.PgClient, candidate: LifecycleCommandCompletionInput) =>
  Schema.decodeUnknownEffect(
    CompletionInputSchema,
    strictParseOptions,
  )(candidate).pipe(
    Effect.flatMap((input) => {
      const success = input.observation.result === 'SUCCESS'
      return sql<Record<string, unknown>>`
        UPDATE lifecycle_commands
        SET
          status = 'COMPLETED',
          result = ${input.observation.result},
          outcome = ${success ? input.observation.outcome : null},
          operation = ${success ? null : input.observation.operation},
          failure = ${success ? null : input.observation.failure},
          message = ${success ? null : input.observation.message},
          observed_at = ${input.observation.observedAt},
          cadence_decision = ${success ? (input.observation.cadenceDecision ?? null) : null},
          completed_at = greatest(${input.completedAt}, started_at)
        WHERE controller_key = ${input.controllerKey}
          AND command_id = ${input.commandId}
          AND sequence = ${input.sequence}
          AND issued_at = ${input.issuedAt}
          AND status = 'STARTED'
        RETURNING
          command_id,
          sequence,
          to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,
          status,
          result,
          outcome,
          operation,
          failure,
          message,
          CASE
            WHEN observed_at IS NULL THEN NULL
            ELSE to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS observed_at,
          cadence_decision
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CommandRows, strictParseOptions)),
        Effect.flatMap(([row]) => decodeObservation(row)),
      )
    }),
    Effect.mapError(classifyCause),
  )

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return {
    readCursor: (controllerKey) => readCursor(sql, controllerKey),
    begin: (input) => begin(sql, input),
    complete: (input) => complete(sql, input),
  } satisfies LifecycleCommandStoreShape
})

export const LifecycleCommandStoreLive = Layer.effect(LifecycleCommandStore, makeStore)
