import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Effect, Exit, Fiber, Result, Schedule } from 'effect'

import { KafkaBootstrapTimestampPolicy } from './bootstrap'
import { nativeArrivalEpochFixture } from './native-arrival.test-support'
import { decodeWebullCapture, WebullCaptureKind } from './webull-capture'
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
  kafka: {
    brokers: ['unused:9092'],
    username: 'test',
    password: 'unused',
    groupPrefix: 'test',
    operationTimeoutMs: 500,
    bootstrapTimeoutMs: 5000,
    timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
  },
  archive: { postgres: { url: 'postgres://unused/unused', tls: false, caPath: '' }, operationTimeoutMs: 500 },
  build: nativeArrivalEpochFixture.build,
  sources: nativeArrivalEpochFixture.sources,
}
const setup = (mode: 'consume' | 'hang' | 'fail' | 'fixture' = 'consume') => {
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

test('a transferred native cut reproduces the same snapshot and complete source rows', async () => {
  const fixture = setup('fixture')
  const expected = streamingFixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        const snapshot = Result.getOrThrow(constructStreamingSnapshot(yield* projection.read, expected.query))
        expect(snapshot.manifest).toEqual(expected.snapshot.manifest)
        const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
        expect(rows).toEqual(Result.getOrThrow(persistIntradayRecordRows(expected.snapshot)))
        expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows))).toEqual(snapshot)
      }),
    ),
  )
}, 10_000)

test('native Webull ingestion advances while the controller event loop is blocked and seals the same evidence', async () => {
  const fixture = setup()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        Atomics.store(fixture.signals, 0, 1)
        // Waiting blocks this event loop. Only an independent ingestion thread can acknowledge the native arrival.
        expect(Atomics.wait(fixture.signals, 1, 0, 1500)).not.toBe('timed-out')
        expect(Atomics.load(fixture.signals, 1)).toBe(1)
        const sent = Number(Atomics.load(fixture.times, 0))
        const available = Number(Atomics.load(fixture.times, 1))
        expect(available).toBeGreaterThanOrEqual(sent)
        expect(available - sent).toBeLessThan(500)
        const cut = yield* projection.readForLiquidation
        const bar = cut.projection.webull.bars.get('AAPL')?.[0]
        expect(bar?.delivery.availableAtMs).toBe(available)
        if (bar === undefined) throw new Error('Webull native bar was not incorporated')
        expect(Result.getOrThrow(decodeWebullCapture(bar.delivery.record)).kind).toBe(WebullCaptureKind.Bars)
        expect(cut.consumerSequence).toBe(1)
        expect(bar.delivery.record.offset).toBe('0')
        expect(cut.deliveredPositions.find((p) => p.topic === 'webull')?.offset).toBe('1')
        const copiedBars = cut.projection.webull.bars
        if (!(copiedBars instanceof Map)) throw new Error('Transferred projection must retain native Maps')
        copiedBars.clear()
        expect((yield* projection.readForLiquidation).projection.webull.bars.has('AAPL')).toBe(true)
        const status = yield* projection.status.pipe(
          Effect.repeat({ until: (value) => value.ready, schedule: Schedule.spaced('10 millis') }),
        )
        expect(status.epoch).toBe(cut.projection.epoch)
        expect((yield* projection.read).projection.sequence).toBe(1)
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
        const reading = yield* projection.read.pipe(Effect.forkChild)
        yield* Effect.sleep('30 millis')
        yield* Fiber.interrupt(reading)
        const status = yield* projection.status
        expect(status.failure).toBeUndefined()
        expect(Atomics.load(fixture.signals, 5)).toBe(1)
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
        const result = yield* Effect.exit(projection.read)
        expect(Exit.isFailure(result)).toBe(true)
        yield* projection.status
        expect(Atomics.load(fixture.signals, 5)).toBe(1)
      }),
    ),
  )
}, 10_000)

test('thread failure invalidates reads and retains the last real source identity', async () => {
  const fixture = setup()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* fixture.projection
        Atomics.store(fixture.signals, 0, 1)
        expect(Atomics.wait(fixture.signals, 1, 0, 1500)).not.toBe('timed-out')
        const before = yield* projection.readForLiquidation
        yield* Effect.promise(() => fixture.worker?.terminate() ?? Promise.resolve(0))
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        expect(yield* projection.status).toEqual({
          epoch: before.projection.epoch,
          sequence: before.projection.sequence,
          ready: false,
          failure: 'Kafka projection thread exited before shutdown was acknowledged',
        })
      }),
    ),
  )
}, 10_000)

test('startup failure propagates and releases the worker', async () => {
  const fixture = setup('fail')
  const result = await Effect.runPromiseExit(Effect.scoped(fixture.projection))
  expect(Exit.isFailure(result)).toBe(true)
  expect(fixture.worker?.threadId).toBe(-1)
}, 10_000)
