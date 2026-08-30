import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Exit, Layer, Option, Schema, Semaphore } from 'effect'

const LOCK_NAMESPACE = 1_111_578_958 // ASCII "BAYN"
const WRITER_LEASE = 1

const BackendRows = Schema.Tuple([Schema.Tuple([Schema.Int])])
const AcquireRows = Schema.Tuple([Schema.Tuple([Schema.Boolean])])
const HeldRows = Schema.Tuple([Schema.Tuple([Schema.Boolean])])

export class WriterFenceError extends Data.TaggedError('WriterFenceError')<{
  readonly failure: 'busy' | 'decode' | 'unavailable'
  readonly operation: 'acquire' | 'check' | 'transaction'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface WriterFenceService {
  readonly backendPid: number
  readonly check: Effect.Effect<void, WriterFenceError>
  readonly transaction: WriterFenceTransaction
}

export type WriterFenceTransaction = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
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
  const connection = yield* sql.reserve.pipe(Effect.mapError((cause) => unavailable('acquire', cause)))
  const backendRows = yield* connection
    .executeValues('SELECT pg_backend_pid()', [])
    .pipe(Effect.mapError((cause) => unavailable('acquire', cause)))
  const [[backendPid]] = yield* Schema.decodeUnknownEffect(BackendRows)(backendRows).pipe(
    Effect.mapError((cause) => decodeFailure('acquire', cause)),
  )

  const transactionPermit = yield* Semaphore.make(1)
  const acquireTransactionLease = (operation: 'check' | 'transaction') =>
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
    })

  const checkHeld = (operation: 'check' | 'transaction') =>
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
    })

  const runTransaction = <A, E, R>(
    operation: 'check' | 'transaction',
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | WriterFenceError, R> =>
    transactionPermit.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* connection
            .executeUnprepared('BEGIN', [], undefined)
            .pipe(Effect.mapError((cause) => unavailable('transaction', cause)))
          const exit = yield* Effect.exit(
            acquireTransactionLease(operation).pipe(
              Effect.andThen(checkHeld(operation)),
              Effect.andThen(restore(effect)),
              Effect.provideService(sql.transactionService, [connection, 0]),
            ),
          )
          yield* connection
            .executeUnprepared(Exit.isSuccess(exit) ? 'COMMIT' : 'ROLLBACK', [], undefined)
            .pipe(Effect.mapError((cause) => unavailable('transaction', cause)))
          return yield* exit
        }),
      ),
    )

  const check = runTransaction('check', Effect.void)
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | WriterFenceError, R> =>
    Effect.serviceOption(sql.transactionService).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => runTransaction('transaction', effect),
          onSome: ([transactionConnection]) =>
            transactionConnection === connection
              ? checkHeld('transaction').pipe(Effect.andThen(effect))
              : runTransaction('transaction', effect),
        }),
      ),
    )

  return { backendPid, check, transaction } satisfies WriterFenceService
})

export const WriterFenceLive = Layer.effect(WriterFence, acquire)
