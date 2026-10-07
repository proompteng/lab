import { expect, test } from 'bun:test'
import { Context, Deferred, Effect, Fiber, Layer, ManagedRuntime, Result } from 'effect'

import { KafkaMarketFailure, KafkaMarketProjection } from '../market-data/streaming/kafka'
import type { ResearchCaptureSession } from '../research-capture/session'
import { prewarmNativeMarketProjection } from './native-execution-runtime'

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
    read: Effect.suspend(() => {
      calls.read += 1
      return Effect.fail(unavailable)
    }),
    readForLiquidation: Effect.die('Prewarm must not request liquidation evidence'),
    status: Effect.succeed({ epoch: 'test-epoch', ready: false, sequence: 0 }),
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
      const prewarmed = yield* prewarmNativeMarketProjection(undefined, f.projection)
      if (prewarmed === null) throw new Error('Expected read-only prewarm')
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
      const prewarmed = yield* prewarmNativeMarketProjection(undefined, f.projection)
      if (prewarmed === null) throw new Error('Expected read-only prewarm')
      const market = yield* KafkaMarketProjection.pipe(Effect.provide(prewarmed))
      expect(yield* market.status).toEqual({ epoch: 'test-epoch', ready: false, sequence: 0 })
      expect(f.calls.read).toBe(0)
      const cut = yield* market.read.pipe(Effect.result)
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
      yield* prewarmNativeMarketProjection(undefined, f.projection)
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
  const result = await Effect.runPromise(
    prewarmNativeMarketProjection(undefined, failed).pipe(Effect.scoped, Effect.result),
  )
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
      const worker = yield* prewarmNativeMarketProjection(undefined, blocked).pipe(Effect.scoped, Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(worker)
      expect(f.calls).toEqual({ acquire: 1, close: 1, read: 0, driver: 0, broker: 0, model: 0, grant: 0 })
    }).pipe(Effect.scoped),
  )
})

test('configured research capture keeps its lazy recorder and consumer ownership', async () => {
  const f = fixture()
  const capture: ResearchCaptureSession = {
    observer: {
      rawValues: true,
      record: () => {
        throw new Error('Unexpected capture')
      },
      invalidate: () => {},
    },
    workerObserver: undefined,
    status: Effect.succeed({ phase: 'waiting' }),
    start: () => Effect.die('Prewarm must not start SQL/S3 recording'),
    bind: () => {
      throw new Error('Prewarm must not bind a capture consumer')
    },
  }
  expect(await Effect.runPromise(prewarmNativeMarketProjection(capture, f.projection).pipe(Effect.scoped))).toBeNull()
  expect(f.calls).toEqual({ acquire: 0, close: 0, read: 0, driver: 0, broker: 0, model: 0, grant: 0 })
})
