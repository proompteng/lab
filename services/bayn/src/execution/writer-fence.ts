import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Exit, Layer, Schema, Semaphore } from 'effect'

const LOCK_NAMESPACE = 1_111_578_958 // ASCII "BAYN"
const WRITER_LEASE = 1

const AcquireRows = Schema.Tuple([Schema.Tuple([Schema.Boolean, Schema.Int])])
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
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | WriterFenceError, R>
}

export class WriterFence extends Context.Service<WriterFence, WriterFenceService>()('bayn/WriterFence') {}

const unavailable = (operation: 'acquire' | 'check' | 'transaction', cause: unknown) =>
  new WriterFenceError({
    failure: 'unavailable',
    operation,
    message: `PostgreSQL writer fence ${operation} failed`,
    cause,
  })

const decodeFailure = (operation: 'acquire' | 'check', cause: unknown) =>
  new WriterFenceError({
    failure: 'decode',
    operation,
    message: `PostgreSQL writer fence ${operation} returned an invalid result`,
    cause,
  })

const acquire = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const connection = yield* sql.reserve.pipe(Effect.mapError((cause) => unavailable('acquire', cause)))
  const rows = yield* connection
    .executeValues('SELECT pg_try_advisory_lock($1::integer, $2::integer), pg_backend_pid()', [
      LOCK_NAMESPACE,
      WRITER_LEASE,
    ])
    .pipe(Effect.mapError((cause) => unavailable('acquire', cause)))
  const [[acquired, backendPid]] = yield* Schema.decodeUnknownEffect(AcquireRows)(rows).pipe(
    Effect.mapError((cause) => decodeFailure('acquire', cause)),
  )
  if (!acquired) {
    return yield* Effect.fail(
      new WriterFenceError({
        failure: 'busy',
        operation: 'acquire',
        message: 'another PostgreSQL session owns the paper writer fence',
      }),
    )
  }

  yield* Effect.addFinalizer(() =>
    connection
      .executeValues('SELECT pg_advisory_unlock($1::integer, $2::integer)', [LOCK_NAMESPACE, WRITER_LEASE])
      .pipe(Effect.ignore),
  )

  const transactionPermit = yield* Semaphore.make(1)
  const checkHeld = Effect.gen(function* () {
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
      .pipe(Effect.mapError((cause) => unavailable('check', cause)))
    const [[held]] = yield* Schema.decodeUnknownEffect(HeldRows)(heldRows).pipe(
      Effect.mapError((cause) => decodeFailure('check', cause)),
    )
    if (!held) {
      return yield* Effect.fail(
        new WriterFenceError({
          failure: 'unavailable',
          operation: 'check',
          message: 'PostgreSQL paper writer fence is no longer held',
        }),
      )
    }
  })
  const check = transactionPermit.withPermit(checkHeld)

  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | WriterFenceError, R> =>
    transactionPermit.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* connection
            .executeUnprepared('BEGIN', [], undefined)
            .pipe(Effect.mapError((cause) => unavailable('transaction', cause)))
          const exit = yield* Effect.exit(
            restore(checkHeld.pipe(Effect.andThen(effect))).pipe(
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

  yield* check
  return { backendPid, check, transaction } satisfies WriterFenceService
})

export const WriterFenceLive = Layer.effect(WriterFence, acquire)
