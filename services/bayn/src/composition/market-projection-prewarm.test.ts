import { expect, test } from 'bun:test'
import { Context, Deferred, Effect, Fiber, Layer, ManagedRuntime, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { provideTestLayer } from '../effect-test-support'

import { KafkaMarketFailure, KafkaMarketProjection } from '../market-data/streaming/kafka'
import { awaitNativeMarketProjectionReady, prewarmNativeMarketProjection } from './native-execution-runtime'

class TradingKernel extends Context.Service<TradingKernel, { readonly market: typeof KafkaMarketProjection.Service }>()(
  'test/prewarm/TradingKernel',
) {}

const fixture = () => {
  const calls = { acquire: 0, close: 0, read: 0, driver: 0, broker: 0, model: 0, grant: 0 }
  const unavailable = new KafkaMarketFailure({
    operation: 'read',
    message: 'Kafka projection is rebuilding required history',
  })
  const market = {
    startWakeups: () => Effect.void,
    check: Effect.suspend(() => {
      calls.read += 1
      return Effect.fail(unavailable)
    }),
    read: () => Effect.die('Prewarm must not request snapshot evidence'),
    status: Effect.succeed({ epoch: 'test-epoch', ready: false, sequence: 0, bootstrapDeadlineAtMs: null }),
  }
  const projection = Layer.effect(
    KafkaMarketProjection,
    Effect.acquireRelease(
      Effect.sync(() => {
        calls.acquire += 1
        return market
      }),
      () =>
        Effect.sync(() => {
          calls.close += 1
        }),
    ),
  )
  const kernel = Layer.effect(
    TradingKernel,
    Effect.gen(function* () {
      calls.driver += 1
      calls.broker += 1
      calls.model += 1
      calls.grant += 1
      return { market: yield* KafkaMarketProjection }
    }),
  )
  return { calls, market, projection, kernel }
}

test('prewarm shares one read-only projection with concurrent lazy kernels and a replacement runtime', async () => {
  const f = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const { layer: prewarmed } = yield* prewarmNativeMarketProjection(f.projection)
      expect(f.calls).toEqual({ acquire: 1, close: 0, read: 0, driver: 0, broker: 0, model: 0, grant: 0 })
      const layer = f.kernel.pipe(Layer.provide(prewarmed))
      const first = ManagedRuntime.make(layer)
      const second = ManagedRuntime.make(layer)
      expect(f.calls.driver).toBe(0)
      const values = yield* Effect.promise(() =>
        Promise.all([
          first.runPromise(TradingKernel),
          first.runPromise(TradingKernel),
          second.runPromise(TradingKernel),
        ]),
      )
      expect(values.every((value) => value.market === f.market)).toBe(true)
      expect(f.calls.acquire).toBe(1)
      expect(f.calls.driver).toBe(2)
      yield* Effect.promise(() => Promise.all([first.dispose(), second.dispose()]))
      expect(f.calls.close).toBe(0)
      const replacement = ManagedRuntime.make(layer)
      expect((yield* Effect.promise(() => replacement.runPromise(TradingKernel))).market).toBe(f.market)
      yield* Effect.promise(() => replacement.dispose())
      expect(f.calls.acquire).toBe(1)
      expect(f.calls.close).toBe(0)
    }).pipe(Effect.scoped),
  )
  expect(f.calls.close).toBe(1)
})

test('prewarm does not label rebuilding signal history as ready or read a signal cut', async () => {
  const f = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const { layer: prewarmed } = yield* prewarmNativeMarketProjection(f.projection)
      const market = yield* KafkaMarketProjection.pipe(Effect.provide(prewarmed))
      expect(yield* market.status).toEqual({
        epoch: 'test-epoch',
        ready: false,
        sequence: 0,
        bootstrapDeadlineAtMs: null,
      })
      expect(f.calls.read).toBe(0)
      const cut = yield* market.check.pipe(Effect.result)
      expect(Result.isFailure(cut)).toBe(true)
      if (Result.isFailure(cut)) expect(cut.failure.message).toContain('rebuilding required history')
      expect(f.calls.driver).toBe(0)
    }).pipe(Effect.scoped),
  )
  expect(f.calls.close).toBe(1)
})

test('a later endpoint startup failure releases the prewarmed projection exactly once', async () => {
  const f = fixture()
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* prewarmNativeMarketProjection(f.projection)
      return yield* Effect.fail('endpoint startup failed')
    }).pipe(Effect.scoped, Effect.result),
  )
  expect(Result.isFailure(result)).toBe(true)
  expect(f.calls).toEqual({ acquire: 1, close: 1, read: 0, driver: 0, broker: 0, model: 0, grant: 0 })
})

test('a typed projection acquisition failure is retained and releases its partial resource', async () => {
  const f = fixture()
  const failed = Layer.effect(
    KafkaMarketProjection,
    Effect.acquireRelease(
      Effect.sync(() => {
        f.calls.acquire += 1
        return f.market
      }),
      () =>
        Effect.sync(() => {
          f.calls.close += 1
        }),
    ).pipe(Effect.andThen(Effect.fail('projection acquisition failed'))),
  )
  const result = await Effect.runPromise(prewarmNativeMarketProjection(failed).pipe(Effect.scoped, Effect.result))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      operation: 'initialize',
      cause: 'projection acquisition failed',
    })
  expect(f.calls).toEqual({ acquire: 1, close: 1, read: 0, driver: 0, broker: 0, model: 0, grant: 0 })
})

test('interrupted projection acquisition releases resources without creating a trading kernel', async () => {
  const f = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const blocked = Layer.effect(
        KafkaMarketProjection,
        Effect.acquireRelease(
          Effect.sync(() => {
            f.calls.acquire += 1
            return f.market
          }),
          () =>
            Effect.sync(() => {
              f.calls.close += 1
            }),
        ).pipe(
          Effect.tap(() => Deferred.succeed(entered, undefined)),
          Effect.andThen(Effect.never),
        ),
      )
      const worker = yield* prewarmNativeMarketProjection(blocked).pipe(Effect.scoped, Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(worker)
      expect(f.calls).toEqual({ acquire: 1, close: 1, read: 0, driver: 0, broker: 0, model: 0, grant: 0 })
    }).pipe(Effect.scoped),
  )
})

test('handoff waits for the shared history without acquiring trading resources or restarting its clock', async () => {
  const f = fixture()
  let ready = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>()
      const market = {
        ...f.market,
        status: Effect.sync(() => ({ epoch: 'warmup', ready, sequence: 0, bootstrapDeadlineAtMs: 5000 })),
      }
      const waiting = yield* awaitNativeMarketProjectionReady(market).pipe(
        Effect.andThen(Deferred.succeed(completed, undefined)),
        Effect.forkChild,
      )
      yield* TestClock.adjust(2000)
      expect(yield* Deferred.isDone(completed)).toBe(false)
      expect(f.calls).toEqual({ acquire: 0, close: 0, read: 0, driver: 0, broker: 0, model: 0, grant: 0 })
      ready = true
      yield* TestClock.adjust(1000)
      yield* Fiber.join(waiting)
      expect(yield* Deferred.isDone(completed)).toBe(true)
    }).pipe((effect) => provideTestLayer(effect, TestClock.layer())),
  )
})

test('a late handoff attempt retains the original bootstrap deadline and interruption cancels its wait', async () => {
  const f = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.adjust(4000)
      const market = {
        ...f.market,
        status: Effect.succeed({ epoch: 'warmup', ready: false, sequence: 0, bootstrapDeadlineAtMs: 5000 }),
      }
      const waiting = yield* awaitNativeMarketProjectionReady(market).pipe(Effect.result, Effect.forkChild)
      yield* TestClock.adjust(1001)
      const result = yield* Fiber.join(waiting)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result))
        expect(result.failure.cause).toMatchObject({ readiness: 'EXPIRED', bootstrapDeadlineAtMs: 5000 })
      const interrupted = yield* awaitNativeMarketProjectionReady({
        ...f.market,
        status: Effect.succeed({ epoch: 'next', ready: false, sequence: 0, bootstrapDeadlineAtMs: 10000 }),
      }).pipe(Effect.forkChild)
      yield* Fiber.interrupt(interrupted)
      expect(f.calls.driver).toBe(0)
    }).pipe((effect) => provideTestLayer(effect, TestClock.layer())),
  )
})

test('a failed or invalidated history cannot hand off even if a previous ready flag was true', async () => {
  const f = fixture()
  const result = await Effect.runPromise(
    awaitNativeMarketProjectionReady({
      ...f.market,
      status: Effect.succeed({
        epoch: 'failed',
        ready: true,
        sequence: 1,
        bootstrapDeadlineAtMs: null,
        failure: 'assignment invalidated',
      }),
    }).pipe(Effect.result),
  )
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure.cause).toMatchObject({ readiness: 'FAILED', failure: 'assignment invalidated' })
  expect(f.calls.driver).toBe(0)
})
