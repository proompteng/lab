import { expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Result, type Scope } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import { CaptureInvalidation, ResearchCaptureFailure, captureKafkaTransport } from './capture'
import { captureEvent, marketEvent } from './capture.test-support'
import { decodeResearchCaptureExportEnvelope, type ResearchCaptureObject } from './export'
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

test('cumulative counters include each complete envelope, seal and manifest plus every SQL payload', () =>
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
      expect(saved.objects).toHaveLength(5)
      for (const [ordinal, object] of saved.objects.slice(0, 3).entries()) {
        const envelope = Result.getOrThrow(decodeResearchCaptureExportEnvelope(object))
        expect(envelope.metadata).toEqual(saved.chunks[ordinal])
        expect(envelope.raw).toEqual(Buffer.from('é'))
      }
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
      const attempted: ResearchCaptureObject[] = []
      const recorder = yield* makeResearchCaptureRecorder(
        saved.store,
        { ...options, maximumObjectBytes: 4096, maximumSqlBytes: 4096 },
        {
          putVerified: (object) =>
            Effect.gen(function* () {
              attempted.push(object)
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
      expect(attempted).toHaveLength(1)
      const envelope = attempted[0]
      if (envelope === undefined) throw new Error('Expected attempted envelope')
      expect(Result.getOrThrow(decodeResearchCaptureExportEnvelope(envelope)).raw).toEqual(Buffer.from('é'))
      expect((yield* recorder.status).attemptedObjectBytes).toBe(envelope.payload.byteLength)
      const concurrentFinish = yield* recorder.finish.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(attempted).toHaveLength(1)
      yield* Deferred.succeed(release, undefined)
      const one = yield* Fiber.join(finishing)
      expect(yield* Fiber.join(concurrentFinish)).toEqual(one)
      expect(yield* recorder.finish).toEqual(one)
      const status = yield* recorder.status
      expect(attempted).toHaveLength(2)
      expect(status.attemptedObjectBytes).toBe(attempted.reduce((sum, object) => sum + object.payload.byteLength, 0))
      expect(status.attemptedSqlBytes).toBe(0)
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
