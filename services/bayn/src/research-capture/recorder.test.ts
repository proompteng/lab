import { expect, test } from 'bun:test'
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import {
  CaptureInvalidation,
  ResearchCaptureFailure,
  verifyResearchCapture,
  type ResearchCaptureBytes,
  type ResearchCaptureSeal,
} from './capture'
import { makeResearchCaptureRecorder, type ResearchCaptureStore } from './recorder'
import { captureEvent, marketEvent } from './capture.test-support'

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
      expect(Result.getOrThrow(verifyResearchCapture(saved.chunks, saved.seals[0])).complete).toBe(true)
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
