import { expect, test } from 'bun:test'
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import {
  CaptureInvalidation,
  CaptureQualification,
  ResearchCaptureFailure,
  decodeResearchCaptureChunk,
  encodeResearchCapture,
  maximumResearchCaptureChunkBytes,
  verifyResearchCapture,
  type ResearchCaptureBytes,
  type ResearchCaptureSeal,
} from './capture'
import { makeResearchCaptureRecorder, type ResearchCaptureStore } from './recorder'
import { captureEvent, fullCaptureBufferEvents, marketEvent } from './capture.test-support'

const options = {
  captureId: 'capture-1',
  sourceRevision: 'a'.repeat(40),
  maximumQueuedReceipts: 16,
  maximumQueuedBytes: 16_384,
  maximumReceiptBytes: 4096,
  flushIntervalMs: 10,
  writeTimeoutMs: 50,
}
const memory = () => {
  const chunks: ResearchCaptureBytes[] = []
  const seals: ResearchCaptureBytes[] = []
  const store: ResearchCaptureStore = {
    append: (value) =>
      Effect.sync(() => {
        chunks.push(value)
      }),
    seal: (value) =>
      Effect.sync(() => {
        seals.push(value)
      }),
  }
  return { chunks, seals, store }
}
const run = <A, E>(effect: Effect.Effect<A, E, import('effect').Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(provideTestLayer(TestClock.layer())))

const requireSeal = (seal: ResearchCaptureSeal | undefined): ResearchCaptureSeal => {
  if (seal === undefined) throw new Error('Expected a constructed capture seal')
  return seal
}

test.each(['automatic', 'explicit', 'cancelled'] as const)(
  'a clock defect during %s finalization creates no invented seal and cannot change owner outcome',
  async (mode) => {
    const saved = memory()
    let samples = 0
    const result = await run(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock
        const entered = yield* Deferred.make<void>()
        const body = Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* makeResearchCaptureRecorder(saved.store, options)
            recorder.record(captureEvent('STARTED'))
            recorder.record(captureEvent('STOPPED'))
            if (mode === 'explicit') {
              expect(yield* recorder.finish).toBeUndefined()
              expect(yield* recorder.finish).toBeUndefined()
              expect((yield* recorder.status).invalidations).toContain(CaptureInvalidation.Finalization)
            }
            if (mode === 'cancelled') {
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never
            }
            return 'trading result'
          }),
        ).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillisUnsafe: () => {
              if (++samples > 2) throw new Error('capture clock failed during sealing')
              return 100
            },
          }),
        )
        if (mode !== 'cancelled') return yield* body
        const owner = yield* body.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(owner)
        const exit = yield* Fiber.await(owner)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        return 'owner interruption preserved'
      }),
    )
    expect(result).toBe(mode === 'cancelled' ? 'owner interruption preserved' : 'trading result')
    expect(samples).toBe(3)
    expect(saved.seals).toHaveLength(0)
    expect(Result.isFailure(verifyResearchCapture(saved.chunks, saved.seals[0]))).toBe(true)
  },
)

test.each(['append', 'seal'] as const)(
  'synchronous adapter defects and self-interruption in %s cannot change the owning result',
  async (operation) => {
    for (const failure of ['throw', 'defect', 'interrupt'] as const) {
      const saved = memory()
      const adapter = () => {
        if (failure === 'throw') throw new Error('synchronous persistence defect')
        return failure === 'defect' ? Effect.die(new Error('persistence defect')) : Effect.interrupt
      }
      const result = await run(
        Effect.gen(function* () {
          yield* TestClock.setTime(100)
          const recorder = yield* makeResearchCaptureRecorder({ ...saved.store, [operation]: adapter }, options)
          recorder.record(captureEvent('STARTED'), 100)
          recorder.record(captureEvent('STOPPED'), 100)
          return 'trading result'
        }),
      )
      expect(result).toBe('trading result')
      expect(saved.seals.length).toBe(operation === 'seal' ? 0 : 1)
    }
  },
)

test.each(['empty', 'idle', 'flushed'] as const)('finalization never waits for a receipt in an %s queue', (mode) =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const recorder = yield* makeResearchCaptureRecorder(saved.store, options)
      if (mode === 'flushed') {
        recorder.record(captureEvent('STARTED'), 100)
        recorder.record(captureEvent('STOPPED'), 100)
      }
      if (mode !== 'empty') yield* TestClock.adjust(options.flushIntervalMs * 2)
      const seal = requireSeal(yield* recorder.finish)
      expect(yield* recorder.finish).toEqual(seal)
      expect(saved.seals).toHaveLength(1)
      expect(seal.persistedReceipts).toBe(mode === 'flushed' ? 2 : 0)
      expect(seal.invalidations).toEqual([])
    }),
  ),
)

test('capture admission is synchronous, immutable, and finalized exactly once', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const recorder = yield* makeResearchCaptureRecorder(saved.store, options)
      expect(recorder.record(captureEvent('STARTED'), 100)).toBeUndefined()
      const mutable = { ...marketEvent }
      recorder.record(mutable, 100)
      mutable.topic = 'changed-after-admission'
      recorder.record(captureEvent('STOPPED'), 100)
      expect(saved.chunks).toHaveLength(0)
      const seal = requireSeal(yield* recorder.finish)
      expect(yield* recorder.finish).toEqual(seal)
      expect(saved.seals).toHaveLength(1)
      expect(saved.chunks[0]?.payload).not.toContain('changed-after-admission')
      const verified = Result.getOrThrow(verifyResearchCapture(saved.chunks, saved.seals[0]))
      expect(verified.structurallyClosed).toBe(true)
      expect(verified.complete).toBe(false)
      expect(verified.seal.qualification).toBe(CaptureQualification.Unqualified)
    }),
  ))

test.each(['candidate', 'serialized'] as const)(
  'receipt admission preserves the %s validation boundary',
  async (boundary) => {
    const saved = memory()
    let serializations = 0
    const event = { ...marketEvent, ...(boundary === 'candidate' ? { unexpected: true } : {}) }
    Object.setPrototypeOf(event, {
      toJSON: () => {
        serializations++
        return boundary === 'candidate' ? marketEvent : { ...marketEvent, consumerSequence: -1 }
      },
    })
    const result = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(100)
        const recorder = yield* makeResearchCaptureRecorder(saved.store, options)
        expect(recorder.record(event, 100)).toBeUndefined()
        const status = yield* recorder.status
        expect(status.invalidations).toEqual([CaptureInvalidation.InvalidEvent])
        expect(status.retainedReceipts).toBe(0)
        expect(status.retainedPayloadBytes).toBe(0)
        const seal = requireSeal(yield* recorder.finish)
        expect(seal.persistedReceipts).toBe(0)
        expect(yield* recorder.finish).toEqual(seal)
        return 'trading result'
      }),
    )
    expect(result).toBe('trading result')
    expect(serializations).toBe(boundary === 'candidate' ? 0 : 1)
    expect(saved.chunks).toHaveLength(0)
    expect(saved.seals).toHaveLength(1)
  },
)

test.each(['throw', 'timeout'] as const)(
  'committed seals with a lost %s acknowledgement stay durably unqualified',
  (mode) =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(100)
        const saved = memory()
        const entered = yield* Deferred.make<void>()
        let attempts = 0
        const recorder = yield* makeResearchCaptureRecorder(
          {
            ...saved.store,
            seal: (bytes) =>
              Effect.gen(function* () {
                attempts++
                yield* saved.store.seal(bytes)
                yield* Deferred.succeed(entered, undefined)
                if (mode === 'timeout') return yield* Effect.never
                return yield* Effect.sync(() => {
                  throw new Error('seal committed; acknowledgement lost')
                })
              }),
          },
          options,
        )
        recorder.record(captureEvent('STARTED'), 100)
        recorder.record(captureEvent('STOPPED'), 100)
        const owner = yield* recorder.finish.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        if (mode === 'timeout') yield* TestClock.adjust(options.writeTimeoutMs)
        const finished = requireSeal(yield* Fiber.join(owner))
        expect(finished.invalidations).toContain(CaptureInvalidation.Persistence)
        const durable = Result.getOrThrow(verifyResearchCapture(saved.chunks, saved.seals[0]))
        expect(durable.seal.qualification).toBe(CaptureQualification.Unqualified)
        expect(durable.seal.invalidations).toEqual([])
        expect(durable.structurallyClosed).toBe(true)
        expect(durable.complete).toBe(false)
        expect(yield* recorder.finish).toEqual(finished)
        expect(attempts).toBe(1)
      }),
    ),
)

test('a full 4MiB UTF8 queue splits below the exact chunk envelope limit', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const attemptedSizes: number[] = []
      const recorder = yield* makeResearchCaptureRecorder(
        {
          ...saved.store,
          append: (bytes) =>
            Effect.gen(function* () {
              attemptedSizes.push(Buffer.byteLength(bytes.payload, 'utf8'))
              if (Buffer.byteLength(bytes.payload, 'utf8') > maximumResearchCaptureChunkBytes)
                return yield* new ResearchCaptureFailure({ message: 'oversized SQL attempt' })
              yield* saved.store.append(bytes)
            }),
        },
        {
          ...options,
          captureId: '\\"é'.repeat(170),
          maximumQueuedReceipts: 64,
          maximumQueuedBytes: maximumResearchCaptureChunkBytes,
          maximumReceiptBytes: 64 * 1024,
        },
      )
      for (const event of fullCaptureBufferEvents()) recorder.record(event, 100)
      const seal = requireSeal(yield* recorder.finish)
      expect(seal.invalidations).toEqual([])
      expect(attemptedSizes).toHaveLength(2)
      expect(attemptedSizes.every((size) => size <= maximumResearchCaptureChunkBytes)).toBe(true)
      expect(saved.chunks.map((bytes) => Result.getOrThrow(decodeResearchCaptureChunk(bytes)).receipts.length)).toEqual(
        [63, 1],
      )
      const verified = Result.getOrThrow(verifyResearchCapture(saved.chunks, saved.seals[0]))
      expect(verified.structurallyClosed).toBe(true)
      expect(verified.complete).toBe(false)
    }),
  ))

test.each([0, 1])('exact chunk limit plus %s bytes includes its envelope and comma separators', (extraByte) =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const envelope = encodeResearchCapture({
        schemaVersion: 'bayn.research-capture-chunk.v1',
        captureId: options.captureId,
        sourceRevision: options.sourceRevision,
        chunkOrdinal: 0,
        previousContentHash: null,
        receipts: [],
      })
      const lastReceiptBytes = 64 * 1024 - Buffer.byteLength(envelope.payload, 'utf8') - 63 + extraByte
      const recorder = yield* makeResearchCaptureRecorder(saved.store, {
        ...options,
        maximumQueuedReceipts: 64,
        maximumQueuedBytes: maximumResearchCaptureChunkBytes,
        maximumReceiptBytes: 64 * 1024,
      })
      for (const event of fullCaptureBufferEvents(lastReceiptBytes)) recorder.record(event, 100)
      const seal = requireSeal(yield* recorder.finish)
      expect(seal.invalidations).toEqual([])
      expect(saved.chunks).toHaveLength(extraByte === 0 ? 1 : 2)
      if (extraByte === 0)
        expect(Buffer.byteLength(saved.chunks[0]?.payload ?? '', 'utf8')).toBe(maximumResearchCaptureChunkBytes)
      expect(
        saved.chunks.every((bytes) => Buffer.byteLength(bytes.payload, 'utf8') <= maximumResearchCaptureChunkBytes),
      ).toBe(true)
      expect(Result.getOrThrow(verifyResearchCapture(saved.chunks, saved.seals[0])).structurallyClosed).toBe(true)
    }),
  ),
)

test('a single oversized serialized receipt never reaches append', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const event = { ...captureEvent('STARTED'), reason: 'x' }
      const baseSize = Buffer.byteLength(JSON.stringify({ sequence: 1, observedAtMs: 100, event }), 'utf8')
      const oversized = { ...event, reason: 'x'.repeat(1 + options.maximumReceiptBytes + 1 - baseSize) }
      expect(Buffer.byteLength(JSON.stringify({ sequence: 1, observedAtMs: 100, event: oversized }), 'utf8')).toBe(
        options.maximumReceiptBytes + 1,
      )
      const recorder = yield* makeResearchCaptureRecorder(saved.store, options)
      recorder.record(oversized, 100)
      const seal = requireSeal(yield* recorder.finish)
      expect(seal.invalidations).toContain(CaptureInvalidation.Overflow)
      expect(saved.chunks).toHaveLength(0)
      expect(seal.persistedReceipts).toBe(0)
    }),
  ))

test.each([false, true])(
  'a failed second split write never advances its acknowledged frontier (committed=%s)',
  (committed) =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(100)
        const saved = memory()
        let attempts = 0
        const recorder = yield* makeResearchCaptureRecorder(
          {
            ...saved.store,
            append: (bytes) =>
              Effect.gen(function* () {
                attempts++
                if (attempts === 1 || committed) yield* saved.store.append(bytes)
                if (attempts === 2)
                  return yield* new ResearchCaptureFailure({ message: 'second split outcome unknown' })
              }),
          },
          {
            ...options,
            maximumQueuedReceipts: 64,
            maximumQueuedBytes: maximumResearchCaptureChunkBytes,
            maximumReceiptBytes: 64 * 1024,
          },
        )
        for (const event of fullCaptureBufferEvents()) recorder.record(event, 100)
        const seal = requireSeal(yield* recorder.finish)
        expect(seal.persistedChunks).toBe(1)
        expect(seal.persistedReceipts).toBe(63)
        expect(seal.lastContentHash).toBe(saved.chunks[0]?.contentHash ?? '')
        expect(seal.invalidations).toContain(CaptureInvalidation.Persistence)
        expect(attempts).toBe(2)
        expect(yield* recorder.finish).toEqual(seal)
        const durable = verifyResearchCapture(saved.chunks, saved.seals[0])
        if (committed) expect(Result.isFailure(durable)).toBe(true)
        else expect(Result.getOrThrow(durable).structurallyClosed).toBe(false)
      }),
    ),
)

test('capture IDs above the database metadata bound fail before persistence', () =>
  run(
    Effect.gen(function* () {
      const saved = memory()
      expect(
        Exit.isFailure(
          yield* Effect.exit(makeResearchCaptureRecorder(saved.store, { ...options, captureId: 'x'.repeat(513) })),
        ),
      ).toBe(true)
      expect(saved.chunks).toHaveLength(0)
      expect(saved.seals).toHaveLength(0)
    }),
  ))

test('overflow admits only a bounded prefix and cannot seal an omitted tail as complete', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const recorder = yield* makeResearchCaptureRecorder(saved.store, { ...options, maximumQueuedReceipts: 2 })
      recorder.record(captureEvent('STARTED'), 100)
      recorder.record(marketEvent, 100)
      recorder.record(captureEvent('STOPPED'), 100)
      const seal = requireSeal(yield* recorder.finish)
      expect(seal.observedReceipts).toBe(3)
      expect(seal.persistedReceipts).toBe(2)
      expect(seal.invalidations).toEqual([CaptureInvalidation.Overflow])
      expect(Result.getOrThrow(verifyResearchCapture(saved.chunks, saved.seals[0])).complete).toBe(false)
    }),
  ))

test('write timeout cancels persistence and cannot stall capture admission', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const entered = yield* Deferred.make<void>()
      let cancelled = false
      const recorder = yield* makeResearchCaptureRecorder(
        {
          ...saved.store,
          append: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  cancelled = true
                }),
              ),
            ),
        },
        options,
      )
      recorder.record(captureEvent('STARTED'), 100)
      yield* TestClock.adjust(10)
      yield* Deferred.await(entered)
      expect(recorder.record(marketEvent, 110)).toBeUndefined()
      yield* TestClock.adjust(50)
      const seal = requireSeal(yield* recorder.finish)
      expect(cancelled).toBe(true)
      expect(seal.invalidations).toContain(CaptureInvalidation.Persistence)
      expect(seal.persistedReceipts).toBe(0)
    }),
  ))

test('lost acknowledgements are never retried into an assumed complete seal', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      let attempts = 0
      const recorder = yield* makeResearchCaptureRecorder(
        {
          ...saved.store,
          append: (bytes) =>
            Effect.gen(function* () {
              attempts++
              yield* saved.store.append(bytes)
              return yield* new ResearchCaptureFailure({ message: 'acknowledgement lost' })
            }),
        },
        options,
      )
      recorder.record(captureEvent('STARTED'), 100)
      recorder.record(marketEvent, 100)
      recorder.record(captureEvent('STOPPED'), 100)
      const seal = requireSeal(yield* recorder.finish)
      expect(attempts).toBe(1)
      expect(seal.invalidations).toContain(CaptureInvalidation.Persistence)
      expect(Result.isFailure(verifyResearchCapture(saved.chunks, saved.seals[0]))).toBe(true)
    }),
  ))

test('scope interruption leaves an explicitly incomplete terminal receipt', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const entered = yield* Deferred.make<void>()
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const recorder = yield* makeResearchCaptureRecorder(saved.store, options)
          recorder.record(captureEvent('STARTED'), 100)
          yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        }),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(saved.seals).toHaveLength(1)
      expect(Result.getOrThrow(verifyResearchCapture(saved.chunks, saved.seals[0])).complete).toBe(false)
    }),
  ))
