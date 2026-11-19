import { PgClient } from '@effect/sql-pg'
import { Cause, Context, Data, Effect, Exit, Layer, Option, Schema, Semaphore } from 'effect'
import type { Connection } from 'effect/sql/SqlConnection'
import { withObservedStage } from '../telemetry'

const LOCK_NAMESPACE = 1_111_578_958 // ASCII "BAYN"
const WRITER_LEASE = 1

const AcquireRows = Schema.Tuple([Schema.Tuple([Schema.Boolean])])
const HeldRows = Schema.Tuple([Schema.Tuple([Schema.Boolean])])

export class WriterFenceError extends Data.TaggedError('WriterFenceError')<{
  readonly failure: 'busy' | 'decode' | 'unavailable'
  readonly operation: 'acquire' | 'check' | 'transaction'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface WriterFenceService {
  readonly check: Effect.Effect<void, WriterFenceError>
  readonly transaction: WriterFenceTransaction
}

export type WriterFenceTransaction = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  /** An owned optional finalizer: failures roll back to its savepoint, commit preparation, then surface the cause. */
  finalize?: (prepared: A) => Effect.Effect<A, E, R> | undefined,
) => Effect.Effect<A, E | WriterFenceError, R>

export class WriterFence extends Context.Service<WriterFence, WriterFenceService>()(
  '@proompteng/bayn/execution/writer-fence/WriterFence',
) {}

/**
 * Explicitly crosses the WriterFence interpreter boundary for callers that do not already hold the service value.
 */
export const withWriterFence = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | WriterFenceError, R | WriterFence> =>
  Effect.flatMap(WriterFence, (fence) => fence.transaction(effect))

const unavailable = (operation: 'acquire' | 'check' | 'transaction', cause: unknown) =>
  new WriterFenceError({
    failure: 'unavailable',
    operation,
    message: `PostgreSQL writer fence ${operation} failed`,
    cause,
  })

const decodeFailure = (operation: 'acquire' | 'check' | 'transaction', cause: unknown) =>
  new WriterFenceError({
    failure: 'decode',
    operation,
    message: `PostgreSQL writer fence ${operation} returned an invalid result`,
    cause,
  })

const acquire = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const transactionPermit = yield* Semaphore.make(1)
  let activeConnection: Connection | undefined
  const acquireTransactionLease = (connection: Connection, operation: 'check' | 'transaction') =>
    Effect.gen(function* () {
      const rows = yield* connection
        .executeValues('SELECT pg_try_advisory_xact_lock($1::integer, $2::integer)', [LOCK_NAMESPACE, WRITER_LEASE])
        .pipe(Effect.mapError((cause) => unavailable(operation, cause)))
      const [[acquired]] = yield* Schema.decodeUnknownEffect(AcquireRows)(rows).pipe(
        Effect.mapError((cause) => decodeFailure(operation, cause)),
      )
      if (!acquired) {
        return yield* new WriterFenceError({
          failure: 'busy',
          operation,
          message: 'another PostgreSQL transaction owns the execution writer fence',
        })
      }
    }).pipe(withObservedStage('bayn.postgres.writer-lease.acquire', { dependency: 'postgresql', operation }))

  const checkHeld = (connection: Connection, operation: 'check' | 'transaction') =>
    Effect.gen(function* () {
      const heldRows = yield* connection
        .executeValues(
          `SELECT EXISTS (
          SELECT 1
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND pid = pg_backend_pid()
            AND classid = $1::integer::oid
            AND objid = $2::integer::oid
            AND objsubid = 2
            AND mode = 'ExclusiveLock'
            AND granted
        )`,
          [LOCK_NAMESPACE, WRITER_LEASE],
        )
        .pipe(Effect.mapError((cause) => unavailable(operation, cause)))
      const [[held]] = yield* Schema.decodeUnknownEffect(HeldRows)(heldRows).pipe(
        Effect.mapError((cause) => decodeFailure(operation, cause)),
      )
      if (!held) {
        return yield* new WriterFenceError({
          failure: 'unavailable',
          operation,
          message: 'PostgreSQL execution writer fence is no longer held',
        })
      }
    }).pipe(withObservedStage('bayn.postgres.writer-lease.check', { dependency: 'postgresql', operation }))

  const runTransaction = <A, E, R>(
    operation: 'check' | 'transaction',
    effect: Effect.Effect<A, E, R>,
    finalize?: (prepared: A) => Effect.Effect<A, E, R> | undefined,
  ): Effect.Effect<A, E | WriterFenceError, R> =>
    transactionPermit
      .withPermit(
        Effect.scoped(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const connection = yield* restore(
                sql.reserve.pipe(
                  Effect.mapError((cause) => unavailable('acquire', cause)),
                  withObservedStage('bayn.postgres.connection-acquire', { dependency: 'postgresql' }),
                ),
              )
              activeConnection = connection
              const transactionSemaphore = Semaphore.makeUnsafe(1)
              const inTransaction = <B, E3, R3>(work: Effect.Effect<B, E3, R3>) =>
                work.pipe(
                  Effect.provideService(sql.transactionService, [connection, 0]),
                  Effect.provideService(sql.transactionSemaphoreService, transactionSemaphore),
                )
              let exit: Exit.Exit<A, E | WriterFenceError> = yield* Effect.exit(
                restore(
                  connection.executeUnprepared('BEGIN', [], undefined).pipe(
                    Effect.mapError((cause) => unavailable('transaction', cause)),
                    withObservedStage('bayn.postgres.begin', { dependency: 'postgresql' }),
                    Effect.andThen(acquireTransactionLease(connection, operation)),
                    Effect.andThen(checkHeld(connection, operation)),
                    Effect.andThen(effect),
                    inTransaction,
                  ),
                ),
              )
              let commit = Exit.isSuccess(exit)
              if (Exit.isSuccess(exit) && finalize !== undefined) {
                const prepared = exit.value
                const selected = yield* Effect.exit(Effect.sync(() => finalize(prepared)))
                if (Exit.isFailure(selected)) exit = Exit.failCause(selected.cause)
                else if (selected.value !== undefined) {
                  const savepoint = yield* Effect.exit(
                    connection
                      .executeUnprepared('SAVEPOINT bayn_finalization', [], undefined)
                      .pipe(Effect.mapError((cause) => unavailable('transaction', cause))),
                  )
                  if (Exit.isFailure(savepoint)) {
                    exit = Exit.failCause(savepoint.cause)
                    commit = false
                  } else {
                    // The transaction owner captures cancellation before restoring interruptibility again.
                    // A failed finalizer rolls back only its writes; the prepared evidence still commits.
                    exit = yield* Effect.exit(restore(inTransaction(selected.value)))
                    const restored = yield* Effect.exit(
                      (Exit.isFailure(exit)
                        ? connection.executeUnprepared('ROLLBACK TO SAVEPOINT bayn_finalization', [], undefined)
                        : Effect.void
                      ).pipe(
                        Effect.andThen(
                          connection.executeUnprepared('RELEASE SAVEPOINT bayn_finalization', [], undefined),
                        ),
                        Effect.mapError((cause) => unavailable('transaction', cause)),
                      ),
                    )
                    if (Exit.isFailure(restored)) {
                      exit = Exit.failCause(
                        Exit.isFailure(exit) ? Cause.combine(exit.cause, restored.cause) : restored.cause,
                      )
                      commit = false
                    }
                  }
                }
              }
              // BEGIN can succeed before its acknowledgment is lost. Roll back interrupted startup too.
              const finalized = yield* Effect.exit(
                connection.executeUnprepared(commit ? 'COMMIT' : 'ROLLBACK', [], undefined).pipe(
                  Effect.mapError((cause) => unavailable('transaction', cause)),
                  withObservedStage(commit ? 'bayn.postgres.commit' : 'bayn.postgres.rollback', {
                    dependency: 'postgresql',
                  }),
                ),
              )
              if (Exit.isFailure(finalized)) {
                return yield* Effect.failCause(
                  Exit.isFailure(exit) ? Cause.combine(exit.cause, finalized.cause) : finalized.cause,
                )
              }
              return yield* exit
            }),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeConnection = undefined
              }),
            ),
          ),
        ),
      )
      .pipe(
        withObservedStage('bayn.postgres.writer-fence', { dependency: 'postgresql' }),
        Effect.annotateLogs({ operation }),
      )

  const check = runTransaction('check', Effect.void)
  const transaction: WriterFenceTransaction = (effect, finalize) =>
    Effect.serviceOption(sql.transactionService).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => runTransaction('transaction', effect, finalize),
          onSome: ([transactionConnection]) =>
            finalize !== undefined
              ? Effect.fail(
                  new WriterFenceError({
                    failure: 'unavailable',
                    operation: 'transaction',
                    message: 'Prepared finalization requires an independently owned writer transaction',
                  }),
                )
              : transactionConnection === activeConnection
                ? checkHeld(transactionConnection, 'transaction').pipe(Effect.andThen(effect))
                : runTransaction('transaction', effect),
        }),
      ),
    )

  return { check, transaction } satisfies WriterFenceService
})

export const WriterFenceLive = Layer.effect(WriterFence, acquire)
