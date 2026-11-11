import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Fiber, Result, Stream } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'

import { canonicalJsonV1Result } from '../hash'
import {
  makeNativeArrivalChunk,
  nativeArrival,
  NativeArrivalCaptureError,
} from '../market-data/streaming/native-arrival'
import {
  nativeArrivalEpochFixture as epoch,
  nativeArrivalObservationFixture as observation,
} from '../market-data/streaming/native-arrival.test-support'
import { makeNativeArrivalStore, streamNativeArrivalChunkPage } from './native-arrival-postgres'
import { nativeArrivalPostgresFailure } from './native-arrival-postgres.test-support'

test.each([
  ['57P03', 'failure', 'UnknownError', true],
  ['57P03', 'defect', 'UnknownError', true],
  ['57P03', 'wrapped', 'UnknownError', true],
  ['57P03', 'mixed', 'UnknownError', false],
  ['57P03', 'interruption', 'UnknownError', false],
  ['08006', 'failure', 'ConnectionError', true],
  ['57014', 'failure', 'StatementTimeoutError', true],
  ['57P01', 'failure', 'UnknownError', false],
  ['XX000', 'failure', 'UnknownError', false],
  ['42501', 'failure', 'AuthorizationError', false],
  ['42501', 'wrapped', 'AuthorizationError', false],
  ['28P01', 'failure', 'AuthenticationError', false],
  ['23505', 'failure', 'UniqueViolation', false],
] as const)(
  'driver SQLSTATE %s %s preserves cancellable append recovery',
  async (code, termination, reason, retryable) => {
    const refused = await Effect.runPromise(nativeArrivalPostgresFailure(code))
    expect(refused.reason._tag).toBe(reason)
    expect(refused.reason.cause).toMatchObject({ code })
    const unrelated = new Error('unrelated archive defect')
    let attempts = 0
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* SqlClient.make({
            acquirer: Effect.die('The refusal fixture never connects to PostgreSQL'),
            compiler: PgClient.makeCompiler(undefined, false),
            spanAttributes: [],
          })
          const sql = new Proxy(client, {
            get(target, property, receiver) {
              if (property !== 'withTransaction') return Reflect.get(target, property, receiver)
              return () =>
                Effect.suspend(() => {
                  attempts++
                  return termination === 'defect'
                    ? Effect.die(refused)
                    : termination === 'wrapped'
                      ? Effect.fail(
                          new NativeArrivalCaptureError({ message: 'readiness write failed', cause: refused }),
                        )
                      : termination === 'mixed'
                        ? Effect.failCause(
                            Cause.fromReasons([Cause.makeDieReason(refused), Cause.makeDieReason(unrelated)]),
                          )
                        : termination === 'interruption'
                          ? Effect.interrupt
                          : Effect.fail(refused)
                })
            },
          }) as PgClient.PgClient
          const chunk = Result.getOrThrow(
            makeNativeArrivalChunk(epoch, 0, null, [nativeArrival(epoch, observation(1))]),
          )
          const append = yield* makeNativeArrivalStore(sql).append([chunk]).pipe(Effect.forkChild)
          yield* TestClock.adjust('2 minutes')
          if (retryable) {
            expect(append.pollUnsafe()).toBeUndefined()
            yield* Fiber.interrupt(append)
          }
          return yield* Fiber.await(append)
        }),
      ).pipe(Effect.provide(Reactivity.layer), Effect.provide(TestClock.layer())),
    )
    if (retryable) {
      expect(attempts).toBeGreaterThan(1)
      expect(attempts).toBeLessThan(12)
    } else expect(attempts).toBe(1)
    if (Exit.isSuccess(exit)) throw new Error('The refused append unexpectedly succeeded')
    if (retryable || termination === 'interruption') expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    else if (termination === 'mixed')
      expect(exit.cause.reasons.map((reason) => (reason._tag === 'Die' ? reason.defect : undefined))).toEqual([
        refused,
        unrelated,
      ])
    else
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: 'NativeArrivalCaptureError',
        cause: termination === 'wrapped' ? { _tag: 'NativeArrivalCaptureError', cause: refused } : refused,
      })
  },
)

test('native pages decode only consumed chunks and reject corruption when reached', async () => {
  const first = Result.getOrThrow(makeNativeArrivalChunk(epoch, 0, null, [nativeArrival(epoch, observation(1))]))
  const second = Result.getOrThrow(
    makeNativeArrivalChunk(epoch, 1, first.contentHash, [nativeArrival(epoch, observation(2))]),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* SqlClient.make({
          acquirer: Effect.die('Native page tests never connect to PostgreSQL'),
          compiler: PgClient.makeCompiler(undefined, false),
          spanAttributes: [],
        })
        const sql = new Proxy(client, {
          apply() {
            return Effect.succeed(
              [first, second].map((chunk, index) => ({
                content_hash: chunk.contentHash,
                header: Result.getOrThrow(canonicalJsonV1Result(chunk.header)),
                compressed: index === 0 ? chunk.compressed : Uint8Array.of(0),
              })),
            )
          },
        }) as PgClient.PgClient
        const page = streamNativeArrivalChunkPage(sql, epoch, -1)
        const consumed = yield* page.pipe(Stream.take(1), Stream.runCollect)
        expect(consumed).toEqual([{ ...first, records: [nativeArrival(epoch, observation(1))] }])
        expect(Result.isFailure(yield* page.pipe(Stream.runCollect, Effect.result))).toBe(true)
        const wrongEpoch = { ...epoch, bootstrap: { ...epoch.bootstrap, epoch: 'different-consumer' } }
        expect(
          Result.isFailure(
            yield* streamNativeArrivalChunkPage(sql, wrongEpoch, -1).pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.result,
            ),
          ),
        ).toBe(true)
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  )
})
