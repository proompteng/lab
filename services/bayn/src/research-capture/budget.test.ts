import { expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, type Scope } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import { sha256 } from '../hash'
import { CaptureInvalidation, ResearchCaptureFailure, captureKafkaTransport } from './capture'
import { captureEvent, marketEvent } from './capture.test-support'
import { makeResearchCaptureRecorder } from './recorder'
import { sessionMemory } from './session.test-support'

const options = {
  captureId: 'byte-budget',
  sourceRevision: 'a'.repeat(40),
  maximumQueuedReceipts: 1024,
  maximumQueuedBytes: 4 * 1024 * 1024,
  maximumReceiptBytes: 64 * 1024,
  flushIntervalMs: 50,
  writeTimeoutMs: 1000,
}
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(provideTestLayer(TestClock.layer())))

test('a native-cadence burst drains before the periodic flush without expanding its retained limits', () =>
  run(
    Effect.gen(function* () {
      const saved = sessionMemory()
      const recorder = yield* makeResearchCaptureRecorder(saved.store, options, saved.objectStore)
      recorder.record(captureEvent('STARTED'))
      yield* TestClock.adjust(50)
      const raw = Buffer.alloc(450, 120)
      const rawValueSha256 = sha256(raw)
      let now = 0
      let maximumRetainedReceipts = 0
      let maximumRetainedBytes = 0
      for (let sequence = 1; sequence <= 4439; sequence++) {
        const atMs = Math.floor(((sequence - 1) * 50) / 4439)
        if (atMs > now) {
          yield* TestClock.adjust(atMs - now)
          now = atMs
        }
        if (sequence % 256 === 0) yield* Effect.yieldNow
        recorder.record(
          {
            ...marketEvent,
            consumerSequence: sequence,
            originalTransport: captureKafkaTransport(0),
            rawByteLength: raw.byteLength,
            rawValueSha256,
          },
          undefined,
          raw,
        )
        const status = yield* recorder.status
        maximumRetainedReceipts = Math.max(maximumRetainedReceipts, status.retainedReceipts)
        maximumRetainedBytes = Math.max(maximumRetainedBytes, status.retainedPayloadBytes)
      }
      yield* recorder.finish
      const status = yield* recorder.status
      expect(status.invalidations).toEqual([])
      expect(status.observedReceipts).toBe(4440)
      expect(status.persistedReceipts).toBe(4440)
      expect(maximumRetainedReceipts <= 1024).toBe(true)
      expect(maximumRetainedBytes <= 4 * 1024 * 1024).toBe(true)
      expect(status.retainedReceipts).toBe(0)
    }),
  ))

test('cumulative counters include raw, metadata, index, seal and manifest bytes plus every SQL payload', () =>
  run(
    Effect.gen(function* () {
      const saved = sessionMemory()
      const recorder = yield* makeResearchCaptureRecorder(
        saved.store,
        { ...options, maximumObjectBytes: 1_000_000, maximumSqlBytes: 1_000_000 },
        saved.objectStore,
      )
      recorder.record(captureEvent('STARTED'))
      for (let sequence = 1; sequence <= 3; sequence++) {
        recorder.record(
          { ...marketEvent, consumerSequence: sequence, originalTransport: captureKafkaTransport(0) },
          undefined,
          Buffer.from('é'),
        )
        yield* TestClock.adjust(50)
      }
      const seal = yield* recorder.finish
      expect(seal?.persistedChunks).toBe(3)
      expect(seal?.persistedReceipts).toBe(4)
      expect(saved.objects).toHaveLength(11)
      const status = yield* recorder.status
      expect(status.attemptedObjectBytes).toBe(
        saved.objects.reduce((sum, object) => sum + object.payload.byteLength, 0),
      )
      expect(status.attemptedSqlBytes).toBe(
        [...saved.chunks, ...saved.seals].reduce((sum, bytes) => sum + Buffer.byteLength(bytes.payload, 'utf8'), 0),
      )
      expect(status.invalidations).toEqual([])
    }),
  ))

test.each(['object', 'sql'] as const)(
  '%s cumulative ceilings apply across drained chunks and never charge an oversized write',
  (kind) =>
    run(
      Effect.gen(function* () {
        const saved = sessionMemory()
        const recorder = yield* makeResearchCaptureRecorder(
          saved.store,
          {
            ...options,
            maximumObjectBytes: kind === 'object' ? 2500 : 1_000_000,
            maximumSqlBytes: kind === 'sql' ? 1000 : 1_000_000,
          },
          saved.objectStore,
        )
        recorder.record(captureEvent('STARTED'))
        yield* TestClock.adjust(50)
        const initial = yield* recorder.status
        expect(initial.persistedReceipts).toBe(1)
        for (let sequence = 1; sequence <= 8; sequence++) {
          recorder.record(
            { ...marketEvent, consumerSequence: sequence, originalTransport: captureKafkaTransport(0) },
            undefined,
            Buffer.from('é'),
          )
          yield* TestClock.adjust(50)
        }
        yield* recorder.finish
        const status = yield* recorder.status
        expect(status.invalidations).toContain(CaptureInvalidation.ByteLimit)
        expect(kind === 'object' ? status.attemptedObjectBytes <= 2500 : status.attemptedSqlBytes <= 1000).toBe(true)
        expect(status.accepting).toBe(false)
        expect(status.retainedReceipts).toBe(0)
      }),
    ),
)

test('unknown acknowledgements keep their logical byte charge and concurrent finish calls do not repeat a write', () =>
  run(
    Effect.gen(function* () {
      const saved = sessionMemory()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let attempted = 0
      const recorder = yield* makeResearchCaptureRecorder(
        saved.store,
        { ...options, maximumObjectBytes: 4096, maximumSqlBytes: 4096 },
        {
          putVerified: (object) =>
            Effect.gen(function* () {
              attempted += object.payload.byteLength
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return yield* new ResearchCaptureFailure({ message: 'acknowledgement unknown' })
            }),
        },
      )
      recorder.record(captureEvent('STARTED'))
      recorder.record({ ...marketEvent, originalTransport: captureKafkaTransport(0) }, undefined, Buffer.from('é'))
      const finishing = yield* recorder.finish.pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      expect((yield* recorder.status).attemptedObjectBytes).toBe(2)
      yield* Deferred.succeed(release, undefined)
      const one = yield* Fiber.join(finishing)
      expect(yield* recorder.finish).toEqual(one)
      const status = yield* recorder.status
      expect(status.attemptedObjectBytes).toBe(attempted)
      expect(status.invalidations).toContain(CaptureInvalidation.Persistence)
      expect(saved.chunks).toEqual([])
      expect(status.retainedReceipts).toBe(0)
    }),
  ))

test('an offline burst saturates the bounded reservation without waiting for its stalled sink', () =>
  run(
    Effect.gen(function* () {
      const saved = sessionMemory()
      const recorder = yield* makeResearchCaptureRecorder(
        saved.store,
        { ...options, maximumObjectBytes: 1_000_000, maximumSqlBytes: 1_000_000 },
        { putVerified: () => Effect.never },
      )
      recorder.record(captureEvent('STARTED'))
      for (let sequence = 1; sequence <= 10_000; sequence++)
        recorder.record(
          {
            ...marketEvent,
            consumerSequence: sequence,
            originalTransport: captureKafkaTransport(0),
          },
          undefined,
          Buffer.from('é'),
        )
      const status = yield* recorder.status
      expect(status.observedReceipts).toBe(10_001)
      expect(status.invalidations).toEqual([CaptureInvalidation.Overflow])
      expect(status.retainedReceipts).toBe(1024)
      expect(status.retainedPayloadBytes <= 4 * 1024 * 1024).toBe(true)
      const finishing = yield* recorder.finish.pipe(Effect.forkChild)
      yield* TestClock.adjust(2000)
      yield* Fiber.join(finishing)
      expect((yield* recorder.status).retainedReceipts).toBe(0)
    }),
  ))
