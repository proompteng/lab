import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Deferred, Effect, Exit, Fiber, Result, Schedule, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import type { MarketReadyWakeup } from '../../execution/events'

import { KafkaBootstrapTimestampPolicy } from './bootstrap'
import { nativeArrivalEpochFixture } from './native-arrival.test-support'
import { makeThreadedKafkaProjection, type ProjectionWorkerOptions } from './worker'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { constructStreamingSnapshot } from './snapshot'
import { persistIntradayRecordRows } from '../intraday/verification'
import { reproduceStreamingSnapshot } from './replay'

let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(import.meta.dir, '.worker-test-'))
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'worker.test-support.ts')],
    outdir: directory,
    target: 'node',
    external: ['@platformatic/kafka'],
  })
  if (!built.success) throw new AggregateError(built.logs, 'Projection worker fixture could not build')
})
afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
})

const options: ProjectionWorkerOptions = {
  controllerKey: 'a'.repeat(64),
  kafka: {
    brokers: ['unused:9092'],
    username: 'test',
    password: 'unused',
    groupPrefix: 'test',
    operationTimeoutMs: 500,
    bootstrapTimeoutMs: 5000,
    timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
  },
  database: { postgres: { url: 'postgres://unused/unused', tls: false, caPath: '' }, operationTimeoutMs: 500 },
  build: nativeArrivalEpochFixture.build,
  sources: nativeArrivalEpochFixture.sources,
}
const setup = (mode: 'consume' | 'hang' | 'fail' | 'fixture' | 'readiness' | 'malformed-readiness' = 'consume') => {
  const shared = new SharedArrayBuffer(64)
  const signals = new Int32Array(shared)
  const times = new BigInt64Array(shared, 32)
  let worker: Worker | undefined
  return {
    signals,
    times,
    get worker() {
      return worker
    },
    projection: makeThreadedKafkaProjection(options, () => {
      worker = new Worker(join(directory, 'worker.test-support.js'), { workerData: { signals: shared, mode } })
      return worker
    }),
  }
}

const query = streamingFixture().query

test('an invalid readiness IPC timestamp fails closed before starting the publisher', async () => {
  const fixture = setup('malformed-readiness')
  const result = await Effect.runPromise(Effect.scoped(fixture.projection).pipe(Effect.result))
  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'KafkaMarketFailure', message: 'Kafka projection returned an invalid market readiness event' },
  })
  expect(fixture.worker?.threadId).toBe(-1)
}, 10_000)

test('a two-minute scheduling outage keeps source reads healthy and retries exact bytes after cancellable deadlines', async () => {
  const fixture = setup('readiness')
  const events: MarketReadyWakeup[] = []
  let available = false
  let cancellations = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        yield* Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const ack = yield* Effect.callback<void>((resume) => {
            const received = (reply: unknown) => {
              if (Schema.is(Schema.TaggedStruct('MarketReadyAcknowledged', {}))(reply)) resume(Effect.void)
            }
            fixture.worker?.on('message', received)
            return Effect.sync(() => {
              fixture.worker?.off('message', received)
            })
          }).pipe(Effect.forkScoped)
          yield* projection.startWakeups((event) =>
            Effect.gen(function* () {
              events.push(event)
              yield* Deferred.succeed(started, undefined)
              if (!available)
                return yield* Effect.never.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      cancellations++
                    }),
                  ),
                )
            }),
          )
          yield* Deferred.await(started)
          yield* TestClock.adjust('2 minutes')
          expect(cancellations).toBeGreaterThan(0)
          expect(events.length).toBeLessThan(12)
          expect(Atomics.load(fixture.signals, 0)).toBe(0)
          expect((yield* projection.status).ready).toBe(true)
          available = true
          yield* TestClock.adjust('30 seconds')
          yield* Fiber.join(ack)
          expect(events).toEqual(Array.from({ length: events.length }, () => events[0]))
          expect(Atomics.load(fixture.signals, 0)).toBe(1)
        }).pipe(Effect.provide(TestClock.layer()))
      }),
    ),
  )
}, 10_000)

test('market handoff crosses the isolated worker and acknowledges only completed durable scheduling', async () => {
  const fixture = setup('readiness')
  const events: MarketReadyWakeup[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        const started = yield* Deferred.make<void>()
        const complete = yield* Deferred.make<void>()
        yield* projection.startWakeups((event) =>
          Effect.gen(function* () {
            events.push(event)
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(complete)
          }),
        )
        yield* Deferred.await(started)
        expect(Atomics.load(fixture.signals, 0)).toBe(0)
        yield* Deferred.succeed(complete, undefined)
        yield* Effect.sync(() => Atomics.load(fixture.signals, 0)).pipe(
          Effect.repeat({ until: (value) => value === 1, schedule: Schedule.spaced('1 millis') }),
          Effect.timeout('1 second'),
        )
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          originalAvailableAt: '2026-11-11T17:00:00.001Z',
          readyAt: '2026-11-11T17:00:00.100Z',
          consumerSequence: 5,
          projectionSequence: 4,
        })
      }),
    ),
  )
}, 10_000)
const cancelled = (signals: Int32Array) =>
  Effect.sync(() => Atomics.load(signals, 5)).pipe(
    Effect.repeat({ until: (value) => value === 1, schedule: Schedule.spaced('1 millis') }),
    Effect.timeout('1 second'),
  )

test('a query-owned native cut reproduces the same snapshot and complete source rows', async () => {
  const fixture = setup('fixture')
  const expected = streamingFixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        const cut = yield* projection.read(expected.query)
        const snapshot = Result.getOrThrow(constructStreamingSnapshot(cut, expected.query))
        expect(snapshot.manifest).toEqual(expected.snapshot.manifest)
        const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
        expect(rows).toEqual(Result.getOrThrow(persistIntradayRecordRows(expected.snapshot)))
        expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows))).toEqual(snapshot)
        expect([...cut.projection.quoteHistory.values()].every((history) => history.length <= 1)).toBe(true)
        const copiedBars = cut.projection.bars
        if (!(copiedBars instanceof Map)) throw new Error('Transferred projection must retain native Maps')
        copiedBars.clear()
        const next = yield* projection.read(expected.query)
        expect(Result.getOrThrow(constructStreamingSnapshot(next, expected.query)).manifest).toEqual(
          expected.snapshot.manifest,
        )
      }),
    ),
  )
}, 10_000)

test('rejected queries retain their snapshot reason and facts across the worker boundary', async () => {
  const fixture = setup('fixture')
  const expected = streamingFixture()
  const request = {
    ...expected.query,
    rangeStartAt: new Date(Date.parse(expected.query.rangeStartAt) - 60_000).toISOString(),
  }
  const rejected = constructStreamingSnapshot(expected.cut, request)
  if (Result.isSuccess(rejected)) throw new Error('Earlier source window must fail the fixture')
  expect(rejected.failure.facts).toBeDefined()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        const actual = yield* projection.read(request).pipe(Effect.result)
        if (Result.isSuccess(actual)) throw new Error('Incomplete source window must be rejected by the owner')
        expect(actual.failure).toMatchObject({
          _tag: 'IntradaySnapshotFailure',
          reason: rejected.failure.reason,
          message: rejected.failure.message,
          facts: rejected.failure.facts,
        })
      }),
    ),
  )
}, 10_000)

test('native Webull ingestion advances while the controller event loop is blocked and seals its evidence', async () => {
  const fixture = setup()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        Atomics.store(fixture.signals, 0, 1)
        // Only an independent ingestion thread can acknowledge arrival while this event loop is blocked.
        expect(Atomics.wait(fixture.signals, 1, 0, 1500)).not.toBe('timed-out')
        expect(Atomics.load(fixture.signals, 6)).toBe(1)
        expect(Atomics.load(fixture.signals, 7)).toBe(1)
        const sent = Number(Atomics.load(fixture.times, 0))
        const available = Number(Atomics.load(fixture.times, 1))
        expect(available).toBeGreaterThanOrEqual(sent)
        expect(available - sent).toBeLessThan(500)
        yield* projection.status.pipe(
          Effect.repeat({ until: (value) => value.ready, schedule: Schedule.spaced('10 millis') }),
        )
        yield* projection.check
        const rejected = yield* projection.read(query).pipe(Effect.result)
        expect(Result.isFailure(rejected)).toBe(true)
      }),
    ),
  )
  expect(Atomics.load(fixture.signals, 2)).toBe(1)
  expect(Atomics.load(fixture.signals, 3)).toBe(1)
  expect(Atomics.load(fixture.signals, 4)).toBe(1)
}, 10_000)

test('interruption cancels the remote read while keeping the projection available', async () => {
  const fixture = setup('hang')
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        const reading = yield* projection.read(query).pipe(Effect.forkChild)
        yield* Effect.sleep('30 millis')
        yield* Fiber.interrupt(reading)
        yield* cancelled(fixture.signals)
        expect((yield* projection.status).failure).toBeUndefined()
      }),
    ),
  )
}, 10_000)

test('a request deadline cancels remote work and reports a failure', async () => {
  const fixture = setup('hang')
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        expect(Exit.isFailure(yield* Effect.exit(projection.read(query)))).toBe(true)
        yield* cancelled(fixture.signals)
        expect((yield* projection.status).failure).toBeUndefined()
      }),
    ),
  )
}, 10_000)

test('thread failure invalidates reads and retains the last real source identity and deadline', async () => {
  const fixture = setup('fixture')
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        const initial = yield* projection.status
        const before = yield* projection.read(query)
        expect(before.projection.sequence).toBeGreaterThan(initial.sequence)
        yield* Effect.promise(() => fixture.worker?.terminate() ?? Promise.resolve(0))
        expect(Exit.isFailure(yield* Effect.exit(projection.read(query)))).toBe(true)
        expect(yield* projection.status).toEqual({
          epoch: before.projection.epoch,
          sequence: before.projection.sequence,
          bootstrapDeadlineAtMs: null,
          ready: false,
          failure: 'Kafka projection thread exited before shutdown was acknowledged',
        })
      }),
    ),
  )
}, 10_000)

test('startup failure propagates and releases the worker', async () => {
  const fixture = setup('fail')
  expect(Exit.isFailure(await Effect.runPromiseExit(Effect.scoped(fixture.projection)))).toBe(true)
  expect(fixture.worker?.threadId).toBe(-1)
}, 10_000)
