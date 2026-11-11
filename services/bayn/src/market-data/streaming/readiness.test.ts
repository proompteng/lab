import { expect, test } from 'bun:test'
import { Deferred, Effect, Exit, Fiber, Queue } from 'effect'
import { TestClock } from 'effect/testing'

import type { PendingMarketReady } from '../../db/market-ready-postgres'
import { NativeArrivalCaptureError } from './native-arrival'
import { serveMarketReadyOutbox } from './readiness'

const pending = (sequence: number): PendingMarketReady => ({
  position: String(sequence),
  event: {
    schemaVersion: 'bayn.execution-wakeup.v1',
    _tag: 'MarketReady',
    sourceRevision: 'a'.repeat(40),
    eventId: String(sequence).padStart(64, '0'),
    captureId: 'b'.repeat(64),
    sourceEpoch: 'epoch',
    consumerSequence: sequence,
    projectionSequence: sequence,
    originalAvailableAt: '2026-11-11T17:00:00.001Z',
    readyAt: '2026-11-11T17:00:00.100Z',
  },
})

test('a blocked handoff holds one slot while a quote burst coalesces to the latest durable frontier', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const changed = yield* Queue.dropping<void>(1)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const completed = yield* Deferred.make<void>()
        let frontier: PendingMarketReady | undefined = pending(1)
        const delivered: number[] = []
        const acknowledged: number[] = []
        const publisher = yield* serveMarketReadyOutbox(
          {
            next: Effect.sync(() => frontier),
            acknowledge: (item) =>
              Effect.sync(() => {
                acknowledged.push(item.event.consumerSequence)
                if (frontier?.position === item.position) frontier = undefined
                if (item.event.consumerSequence === 1000) Deferred.doneUnsafe(completed, Exit.void)
              }),
          },
          changed,
          (event) =>
            Effect.gen(function* () {
              delivered.push(event.consumerSequence)
              if (event.consumerSequence === 1) {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
              }
            }),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        for (let sequence = 2; sequence <= 1000; sequence++) {
          frontier = pending(sequence)
          Queue.offerUnsafe(changed, undefined)
        }
        expect(delivered).toEqual([1])
        expect(acknowledged).toEqual([])
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(completed)
        expect(delivered).toEqual([1, 1000])
        expect(acknowledged).toEqual([1, 1000])
        yield* Fiber.interrupt(publisher)
      }),
    ),
  )
})

test('crash before acknowledgement replays identical bytes and scoped cancellation stops delivery', async () => {
  const item = pending(5)
  const delivered: unknown[] = []
  let acknowledgements = 0
  let cancelled = 0
  const outbox = {
    next: Effect.sync(() => (acknowledgements === 0 ? item : undefined)),
    acknowledge: () =>
      Effect.sync(() => {
        acknowledgements++
      }),
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const changed = yield* Queue.dropping<void>(1)
        yield* serveMarketReadyOutbox(outbox, changed, (event) =>
          Effect.gen(function* () {
            delivered.push(event)
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                cancelled++
              }),
            ),
          ),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
      }),
    ),
  )
  expect(acknowledgements).toBe(0)
  expect(cancelled).toBe(1)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const changed = yield* Queue.dropping<void>(1)
        const done = yield* Deferred.make<void>()
        yield* serveMarketReadyOutbox(
          {
            ...outbox,
            acknowledge: () =>
              outbox.acknowledge().pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.asVoid),
          },
          changed,
          (event) =>
            Effect.sync(() => {
              delivered.push(event)
            }),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(done)
      }),
    ),
  )
  expect(delivered).toEqual([item.event, item.event])
  expect(acknowledgements).toBe(1)
})

test('unknown acknowledgement failure retries retained identity, without a normal discovery timer', async () => {
  let attempts = 0
  const deliveries: unknown[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const changed = yield* Queue.dropping<void>(1)
        const done = yield* Deferred.make<void>()
        yield* serveMarketReadyOutbox(
          {
            next: Effect.sync(() => (attempts < 2 ? pending(7) : undefined)),
            acknowledge: () =>
              Effect.suspend(() =>
                ++attempts === 1
                  ? Effect.fail(new NativeArrivalCaptureError({ message: 'lost database acknowledgement' }))
                  : Deferred.succeed(done, undefined).pipe(Effect.asVoid),
              ),
          },
          changed,
          (event) =>
            Effect.sync(() => {
              deliveries.push(event)
            }),
        ).pipe(Effect.forkScoped)
        yield* TestClock.adjust('1 second')
        yield* Deferred.await(done)
        yield* TestClock.adjust('1 hour')
        expect(deliveries).toEqual([pending(7).event])
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test('two-minute ingress and database outages recover the same handoff while the source coalesces new quotes', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const changed = yield* Queue.dropping<void>(1)
        const began = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()
        let frontier: PendingMarketReady | undefined = pending(1)
        let ingressAvailable = false
        let databaseAvailable = false
        const attempted: unknown[] = []
        const acknowledged: string[] = []
        yield* serveMarketReadyOutbox(
          {
            next: Effect.sync(() => frontier),
            acknowledge: (item) =>
              Effect.suspend(() => {
                if (!databaseAvailable)
                  return Effect.fail(new NativeArrivalCaptureError({ message: 'database unavailable' }))
                acknowledged.push(item.position)
                if (frontier?.position === item.position) frontier = undefined
                return item.position === '1000'
                  ? Deferred.succeed(finished, undefined).pipe(Effect.asVoid)
                  : Effect.void
              }),
          },
          changed,
          (event) =>
            Effect.gen(function* () {
              attempted.push(event)
              yield* Deferred.succeed(began, undefined)
              if (!ingressAvailable) return yield* new NativeArrivalCaptureError({ message: 'ingress unavailable' })
            }),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(began)
        for (let sequence = 2; sequence <= 1000; sequence++) {
          frontier = pending(sequence)
          Queue.offerUnsafe(changed, undefined)
        }
        yield* TestClock.adjust('2 minutes')
        expect(attempted.length).toBeLessThan(12)
        expect(attempted).toEqual(Array.from({ length: attempted.length }, () => pending(1).event))
        expect(acknowledged).toEqual([])
        ingressAvailable = true
        yield* TestClock.adjust('30 seconds')
        const ingressAttempts = attempted.length
        yield* TestClock.adjust('2 minutes')
        expect(attempted).toHaveLength(ingressAttempts)
        expect(acknowledged).toEqual([])
        databaseAvailable = true
        yield* TestClock.adjust('30 seconds')
        yield* Deferred.await(finished)
        expect(acknowledged).toEqual(['1', '1000'])
        expect(attempted.at(-1)).toEqual(pending(1000).event)
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})
