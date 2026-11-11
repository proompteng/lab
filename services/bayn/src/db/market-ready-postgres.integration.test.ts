import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Clock, Deferred, Effect, Fiber, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import type { SqlError } from 'effect/sql/SqlError'

import { canonicalJsonV1Result } from '../hash'
import {
  makeNativeArrivalChunk,
  nativeArrival,
  NativeArrivalCaptureError,
} from '../market-data/streaming/native-arrival'
import { makeNativeArrivalJournal } from '../market-data/streaming/native-arrival-journal'
import {
  nativeArrivalEpochFixture as epoch,
  nativeArrivalObservationFixture as observation,
} from '../market-data/streaming/native-arrival.test-support'
import { CaptureDisposition } from '../market-data/streaming/transport-evidence'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { makeMarketReadyStore } from './market-ready-postgres'
import { makeNativeArrivalStore } from './native-arrival-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import { nativeArrivalPostgresFailure } from './native-arrival-postgres.test-support'
import { provideTestLayer } from '../effect-test-support'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const controllerKey = 'a'.repeat(64)
const makeRuntime = (url: string) =>
  ManagedRuntime.make(
    PostgresClientLive({
      operationTimeoutMs: 5000,
      postgres: { url: Redacted.make(url), tls: false, caPath: '' },
    }).pipe(Layer.provideMerge(NodeServices.layer)),
  )
const chunk = (sequence = 1, previousHash: string | null = null) =>
  Result.getOrThrow(
    makeNativeArrivalChunk(epoch, sequence - 1, previousHash, [nativeArrival(epoch, observation(sequence))]),
  )
const counts = (sql: PgClient.PgClient) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.Struct({ chunks: Schema.Number, events: Schema.Number })]),
    )(
      yield* sql`SELECT (SELECT count(*)::int FROM native_arrival_chunks) AS chunks,
      (SELECT count(*)::int FROM market_ready_events) AS events`,
    )
  })

describePostgres('durable market readiness', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    if (baynTestPostgresUrl === undefined) throw new Error('Missing local test PostgreSQL URL')
    const target = new URL(baynTestPostgresUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_test'))
      throw new Error('Market readiness integration requires an isolated local _test database')
    runtime = makeRuntime(baynTestPostgresUrl)
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
      }),
    )
  })
  afterAll(async () => {
    await runtime?.dispose()
  })

  test('a handoff failure rolls back its native append, and retry commits both exactly once', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const outbox = makeMarketReadyStore(sql, controllerKey, epoch.build.sourceRevision)
        const source = makeNativeArrivalStore(sql, () =>
          Effect.fail(new NativeArrivalCaptureError({ message: 'simulated handoff failure' })),
        )
        yield* source.begin(epoch)
        expect(Result.isFailure(yield* source.append([chunk()]).pipe(Effect.result))).toBe(true)
        expect(yield* counts(sql)).toEqual([{ chunks: 0, events: 0 }])
        const live = makeNativeArrivalStore(sql, (chunks) => outbox.retain(epoch, chunks))
        yield* live.append([chunk()])
        yield* live.append([chunk()])
        expect(yield* counts(sql)).toEqual([{ chunks: 1, events: 1 }])
        const pending = yield* outbox.next
        expect(pending?.event).toMatchObject({
          captureId: epoch.captureId,
          sourceEpoch: epoch.bootstrap.epoch,
          consumerSequence: 1,
          projectionSequence: 1,
          originalAvailableAt: '1970-01-01T00:00:01.001Z',
        })
      }),
    )
  })

  test('restart and lost acknowledgement retain the first readiness clock and immutable original arrival', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const first = makeMarketReadyStore(sql, controllerKey, epoch.build.sourceRevision)
        const source = makeNativeArrivalStore(sql, (chunks) => first.retain(epoch, chunks))
        yield* source.begin(epoch)
        yield* source.append([chunk()])
        const pending = yield* first.next
        if (pending === undefined) throw new Error('Expected committed readiness')
        const oldClock = yield* Clock.Clock
        const later = new Proxy(oldClock, {
          get(target, property, receiver) {
            if (property === 'currentTimeMillis')
              return oldClock.currentTimeMillis.pipe(Effect.map((now) => now + 60_000))
            return property === 'currentTimeMillisUnsafe'
              ? () => oldClock.currentTimeMillisUnsafe() + 60_000
              : Reflect.get(target, property, receiver)
          },
        })
        yield* source.append([chunk()]).pipe(Effect.provideService(Clock.Clock, later))
        const restarted = makeMarketReadyStore(sql, controllerKey, epoch.build.sourceRevision)
        expect(yield* restarted.next).toEqual(pending)
        yield* restarted.acknowledge(pending)
        yield* restarted.acknowledge(pending)
        expect(yield* restarted.next).toBeUndefined()
        expect(Result.isFailure(yield* sql`UPDATE market_ready_events SET payload='{}'`.pipe(Effect.result))).toBe(true)
        const changed = { ...chunk(), contentHash: 'b'.repeat(64) }
        expect(Result.isFailure(yield* source.append([changed]).pipe(Effect.result))).toBe(true)
        expect(yield* counts(sql)).toEqual([{ chunks: 1, events: 1 }])
        const second = chunk(2, chunk().contentHash)
        yield* source.append([second])
        const newer = yield* restarted.next
        if (newer === undefined) throw new Error('Expected newer retained frontier')
        yield* restarted.acknowledge(pending)
        expect(yield* restarted.next).toEqual(newer)
        yield* restarted.acknowledge(newer)
        yield* restarted.acknowledge(pending)
        expect(yield* restarted.next).toBeUndefined()
      }),
    )
  })

  test('a thousand quote-sized arrivals retain journal batching and one latest pending frontier', async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const outbox = makeMarketReadyStore(sql, controllerKey, epoch.build.sourceRevision)
          const source = makeNativeArrivalStore(sql, (chunks) => outbox.retain(epoch, chunks))
          const journal = yield* makeNativeArrivalJournal(epoch, source)
          for (let sequence = 1; sequence <= 1000; sequence++) yield* journal.observe(observation(sequence))
          yield* journal.flush
          // Journal finalization drains the scoped writer; it never emits a per-record transaction.
        }),
      ),
    )
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const rows = yield* counts(sql)
        expect(rows[0].chunks).toBeLessThan(10)
        expect(rows[0].events).toBeGreaterThan(0)
        expect(rows[0].events).toBeLessThanOrEqual(rows[0].chunks)
        const outbox = makeMarketReadyStore(sql, controllerKey, epoch.build.sourceRevision)
        const pending = yield* outbox.next
        if (pending === undefined) throw new Error('Expected a coalesced frontier')
        expect(pending.event.consumerSequence).toBe(1000)
        yield* outbox.acknowledge(pending)
        expect(yield* outbox.next).toBeUndefined()
        expect(yield* makeMarketReadyStore(sql, 'b'.repeat(64), epoch.build.sourceRevision).next).toBeUndefined()
        expect(yield* makeMarketReadyStore(sql, controllerKey, 'b'.repeat(40)).next).toBeUndefined()
      }),
    )
  })

  test('bootstrap completion has its own idempotent wake without refreshing source availability', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const outbox = makeMarketReadyStore(sql, controllerKey, epoch.build.sourceRevision)
        const source = makeNativeArrivalStore(sql, (chunks) => outbox.retain(epoch, chunks))
        yield* source.begin(epoch)
        yield* source.append([chunk()])
        const initial = yield* outbox.next
        if (initial === undefined) throw new Error('Expected input readiness')
        yield* outbox.acknowledge(initial)
        const bootstrap = outbox.bootstrap(epoch)
        yield* bootstrap
        const ready = yield* outbox.next
        expect(ready?.event.eventId).not.toBe(initial.event.eventId)
        expect(ready?.event.originalAvailableAt).toBe(initial.event.originalAvailableAt)
        yield* bootstrap
        expect(yield* outbox.next).toEqual(ready)
        expect(yield* counts(sql)).toEqual([{ chunks: 1, events: 2 }])
        if (ready === undefined) throw new Error('Expected retained bootstrap frontier')
        const expected = yield* Effect.fromResult(canonicalJsonV1Result(ready.event))
        yield* source.append([chunk(2, chunk().contentHash)])
        yield* bootstrap
        expect(yield* counts(sql)).toEqual([{ chunks: 2, events: 3 }])
        expect(yield* sql`SELECT payload FROM market_ready_events WHERE event_id=${ready.event.eventId}`).toEqual([
          { payload: expected },
        ])
      }),
    )
  })

  test('rejected-only input cannot invent a market-ready frontier', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const outbox = makeMarketReadyStore(sql, controllerKey, epoch.build.sourceRevision)
        const source = makeNativeArrivalStore(sql, (chunks) => outbox.retain(epoch, chunks))
        yield* source.begin(epoch)
        const input = nativeArrival(epoch, { ...observation(1), disposition: CaptureDisposition.Rejected })
        const rejected = yield* Effect.fromResult(makeNativeArrivalChunk(epoch, 0, null, [input]))
        yield* source.append([rejected])
        yield* outbox.bootstrap(epoch)
        expect(yield* outbox.next).toBeUndefined()
        expect(yield* counts(sql)).toEqual([{ chunks: 1, events: 0 }])
        expect(yield* Effect.fromResult(canonicalJsonV1Result(input))).toContain('REJECTED')
      }),
    )
  })

  test('a regressed handoff clock fails without inventing a later availability timestamp', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const outbox = makeMarketReadyStore(sql, controllerKey, epoch.build.sourceRevision)
        const source = makeNativeArrivalStore(sql, (chunks) => outbox.retain(epoch, chunks))
        yield* source.begin(epoch)
        const clock = yield* Clock.Clock
        const regressed = new Proxy(clock, {
          get(target, property, receiver) {
            if (property === 'currentTimeMillis') return Effect.succeed(0)
            return property === 'currentTimeMillisUnsafe' ? () => 0 : Reflect.get(target, property, receiver)
          },
        })
        expect(
          Result.isFailure(
            yield* source.append([chunk()]).pipe(Effect.provideService(Clock.Clock, regressed), Effect.result),
          ),
        ).toBe(true)
        expect(yield* counts(sql)).toEqual([{ chunks: 0, events: 0 }])
        expect(yield* outbox.next).toBeUndefined()
      }),
    )
  })

  test('a two-minute transient append outage keeps exact bytes queued and backpressures within its byte limit', async () => {
    await runtime.runPromise(
      provideTestLayer(
        Effect.scoped(
          Effect.gen(function* () {
            yield* TestClock.setTime(2000)
            const sql = yield* PgClient.PgClient
            const unavailable = yield* nativeArrivalPostgresFailure('57P03')
            const outbox = makeMarketReadyStore(sql, controllerKey, epoch.build.sourceRevision)
            const committed = yield* Deferred.make<void>()
            let available = false
            let attempts = 0
            let commits = 0
            const reconnecting = new Proxy(sql, {
              get(target, property, receiver) {
                if (property !== 'withTransaction') return Reflect.get(target, property, receiver)
                return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  Effect.suspend<A, E | SqlError | NativeArrivalCaptureError, R>(() => {
                    attempts++
                    return available
                      ? target
                          .withTransaction(effect)
                          .pipe(
                            Effect.tap(() => (++commits === 2 ? Deferred.succeed(committed, undefined) : Effect.void)),
                          )
                      : Effect.fail(
                          new NativeArrivalCaptureError({
                            message: 'readiness database unavailable',
                            cause: unavailable,
                          }),
                        )
                  })
              },
            })
            const source = makeNativeArrivalStore(reconnecting, (chunks) => outbox.retain(epoch, chunks))
            const journal = yield* makeNativeArrivalJournal(epoch, source, { chunkBytes: 1, queueBytes: 700 })
            yield* journal.observe(observation(1))
            const next = yield* journal.observe(observation(2)).pipe(Effect.forkChild)
            yield* TestClock.adjust('2 minutes')
            expect(attempts).toBeGreaterThan(1)
            expect(attempts).toBeLessThan(12)
            expect(next.pollUnsafe()).toBeUndefined()
            expect(journal.status()).toMatchObject({
              status: 'RECORDING',
              observedConsumerSequence: 2,
              durableConsumerSequence: 0,
              failure: null,
            })
            expect(journal.status().queuedCompressedBytes).toBeLessThanOrEqual(700)
            expect(yield* counts(sql)).toEqual([{ chunks: 0, events: 0 }])
            available = true
            yield* TestClock.adjust('30 seconds')
            yield* Fiber.join(next)
            yield* Deferred.await(committed)
            yield* TestClock.adjust(0)
            expect(journal.status()).toMatchObject({
              status: 'RECORDING',
              durableConsumerSequence: 2,
              queuedCompressedBytes: 0,
              failure: null,
            })
            expect(yield* counts(sql)).toEqual([{ chunks: 2, events: 2 }])
            expect((yield* outbox.next)?.event.originalAvailableAt).toBe('1970-01-01T00:00:01.002Z')
            const rows = yield* sql`SELECT content_hash FROM native_arrival_chunks ORDER BY ordinal`
            const first = chunk()
            expect(rows).toEqual([
              { content_hash: first.contentHash },
              { content_hash: chunk(2, first.contentHash).contentHash },
            ])
          }),
        ),
        TestClock.layer(),
      ),
    )
  })

  test('a lost atomic append acknowledgement reconciles the same event and first ready clock', async () => {
    await runtime.runPromise(
      provideTestLayer(
        Effect.scoped(
          Effect.gen(function* () {
            yield* TestClock.setTime(2000)
            const sql = yield* PgClient.PgClient
            const unavailable = yield* nativeArrivalPostgresFailure('57P03')
            const outbox = makeMarketReadyStore(sql, controllerKey, epoch.build.sourceRevision)
            const committed = yield* Deferred.make<void>()
            let transactions = 0
            const uncertain = new Proxy(sql, {
              get(target, property, receiver) {
                if (property !== 'withTransaction') return Reflect.get(target, property, receiver)
                return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  target
                    .withTransaction(effect)
                    .pipe(
                      Effect.tap(() =>
                        ++transactions === 1
                          ? Deferred.succeed(committed, undefined).pipe(Effect.andThen(Effect.fail(unavailable)))
                          : Effect.void,
                      ),
                    )
              },
            })
            const source = makeNativeArrivalStore(uncertain, (chunks) => outbox.retain(epoch, chunks))
            yield* source.begin(epoch)
            const append = yield* source.append([chunk()]).pipe(Effect.forkChild)
            yield* Deferred.await(committed)
            const first = yield* outbox.next
            expect(first?.event.readyAt).toBe('1970-01-01T00:00:02.000Z')
            yield* TestClock.adjust('1 second')
            yield* Fiber.join(append)
            expect(yield* outbox.next).toEqual(first)
            expect(transactions).toBe(2)
            expect(yield* counts(sql)).toEqual([{ chunks: 1, events: 1 }])
          }),
        ),
        TestClock.layer(),
      ),
    )
  })
})
