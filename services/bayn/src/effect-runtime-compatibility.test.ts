import { describe, expect, test } from 'bun:test'

import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  PartitionedSemaphore,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from 'effect'
import { HttpBody, HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { OtlpExporter } from 'effect/unstable/observability'

describe('Effect beta.102 runtime compatibility', () => {
  test('keeps deeply nested JSON validation stack safe and rejects invalid dates', () => {
    let nested: unknown = null
    for (let index = 0; index < 25_000; index += 1) nested = [nested]

    expect(Schema.DateValid).toBe(Schema.Date)
    expect(Result.isSuccess(Schema.decodeUnknownResult(Schema.Json)(nested))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(Schema.Date)(new Date(Number.NaN)))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(Schema.DateValid)(new Date(Number.NaN)))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(Schema.DateFromString)('not-a-date'))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(Schema.DateFromMillis)(8_640_000_000_000_001))).toBe(true)
  })

  test('recovers permits after interrupted semaphore waiters', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(1)
        const blocked = yield* semaphore.withPermits(2)(Effect.void).pipe(Effect.forkChild)

        yield* Effect.yieldNow
        yield* Fiber.interrupt(blocked)
        expect(Option.isSome(yield* semaphore.withPermitsIfAvailable(1)(Effect.void))).toBe(true)

        const partitioned = yield* PartitionedSemaphore.make<string>({ permits: 4 })
        yield* PartitionedSemaphore.take(partitioned, 'held', 3)
        const waiter = yield* PartitionedSemaphore.take(partitioned, 'waiting', 3).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* PartitionedSemaphore.release(partitioned, 1)
        yield* Fiber.interrupt(waiter)

        expect(yield* PartitionedSemaphore.available(partitioned)).toBe(2)
        yield* PartitionedSemaphore.release(partitioned, 2)
        expect(yield* PartitionedSemaphore.available(partitioned)).toBe(4)
      }),
    )
  })

  test('interrupts an in-flight stream pull when the async iterator closes', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        let interrupted = false
        const iterator = Stream.toAsyncIterable(
          Stream.fromEffect(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true
                }),
              ),
            ),
          ),
        )[Symbol.asyncIterator]()

        const pending = iterator.next()
        yield* Deferred.await(started)
        const returned = yield* Effect.promise(() => iterator.return!(undefined))
        const pendingResult = yield* Effect.promise(() => pending)

        expect(returned).toEqual({ done: true, value: undefined })
        expect(pendingResult).toEqual({ done: true, value: undefined })
        expect(interrupted).toBe(true)
      }),
    )
  })

  test('removes Fiber.joinAll observers when the join is interrupted', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.never)
        let cleaned = 0
        const tracked = new Proxy(fiber, {
          get(target, property, receiver) {
            if (property !== 'addObserver') return Reflect.get(target, property, receiver)
            return (observer: Parameters<typeof target.addObserver>[0]) => {
              const cancel = target.addObserver(observer)
              return () => {
                cleaned += 1
                cancel()
              }
            }
          },
        })
        const joining = yield* Fiber.joinAll([tracked]).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Fiber.interrupt(joining)
        expect(cleaned).toBe(1)
      }),
    )
  })

  test('waits for in-flight telemetry during scoped exporter shutdown', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const client = HttpClient.make((request) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(HttpClientResponse.fromWeb(request, new Response())),
          ),
        )
        const exporter = yield* OtlpExporter.make({
          label: 'BaynEffectCompatibility',
          url: 'http://localhost:4318/v1/logs',
          headers: undefined,
          exportInterval: '1 hour',
          maxBatchSize: 1,
          body: () => HttpBody.empty,
          shutdownTimeout: '1 second',
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(OtlpExporter.layerFlusher),
          Scope.provide(scope),
        )

        exporter.push({ message: 'flush-before-close' })
        yield* Deferred.await(started)
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow

        expect(closing.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(closing)
      }),
    )
  })

  test('disposes scoped managed runtimes through Symbol.asyncDispose', async () => {
    let finalized = 0
    const runtime = ManagedRuntime.make(
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized += 1
          }),
        ),
      ),
    )

    await runtime.runPromise(Effect.void)
    expect(finalized).toBe(0)
    await runtime[Symbol.asyncDispose]()
    expect(finalized).toBe(1)
  })
})
