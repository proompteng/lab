import { describe, expect, test } from 'bun:test'
import { NodeRedis } from '@effect/platform-node'
import { Effect, Fiber, Layer, Logger, Metric, References, Result } from 'effect'
import { PrometheusMetrics } from 'effect/observability'
import { TestClock } from 'effect/testing'

import { makeValkeyCache, ValkeyCache, ValkeyCacheError, ValkeyFailureCategory } from './valkey-cache'
import { ExecutionStageTimings, type ExecutionStageTiming } from './telemetry'

const phaseCount = (metrics: string, stage: string, outcome: string) =>
  metrics.match(
    new RegExp(
      `bayn_operation_duration_seconds_count\\{(?=[^\\n]*stage="bayn.valkey.${stage}")(?=[^\\n]*outcome="${outcome}")(?=[^\\n]*operation="put")[^\\n]*\\} (\\d+)`,
    ),
  )?.[1]

describe('Valkey pre-command phase diagnostics', () => {
  test('connect and SET share the original one-second budget', async () => {
    const connecting = Promise.withResolvers<void>()
    const connected = Promise.withResolvers<void>()
    const writing = Promise.withResolvers<void>()
    let open = false
    let waits = 0
    const client = {
      get isOpen() {
        return open
      },
      connect: async () => {
        connecting.resolve()
        await connected.promise
        open = true
      },
      destroy: () => {
        open = false
      },
      withAbortSignal: () => ({
        set: () => {
          writing.resolve()
          return new Promise<never>(() => {})
        },
        wait: async () => {
          waits++
          return 1
        },
      }),
    } as unknown as NodeRedis.NodeRedis['Service']['client']
    await Effect.gen(function* () {
      const cache = yield* ValkeyCache
      const fiber = yield* cache
        .put({ key: 'bayn:budget', value: 'private', ttlMs: 5000 })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() => connecting.promise)
      yield* TestClock.adjust('600 millis')
      connected.resolve()
      yield* Effect.promise(() => writing.promise)
      yield* TestClock.adjust('400 millis')
      const result = yield* Fiber.join(fiber)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result) && result.failure instanceof ValkeyCacheError)
        expect(result.failure.category).toBe(ValkeyFailureCategory.OperationDeadline)
      expect(waits).toBe(0)
      const metrics = yield* PrometheusMetrics.format()
      expect(metrics).toMatch(/bayn_operation_duration_seconds_sum\{[^\n]*stage="bayn.valkey.connect"[^\n]*\} 0.6/)
      expect(metrics).toMatch(/bayn_operation_duration_seconds_sum\{[^\n]*stage="bayn.valkey.set"[^\n]*\} 0.4/)
    }).pipe(
      Effect.provide(
        Layer.effect(ValkeyCache, makeValkeyCache).pipe(
          Layer.provide(Layer.succeed(NodeRedis.NodeRedis, { client, use: () => Effect.die('unused') })),
        ),
      ),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.runPromise,
    )
  })
  test('diagnostic defects after acquisition preserve native failures, success and permit reuse', async () => {
    const original = new Error('private connection failure')
    let open = false
    let connects = 0
    let writes = 0
    let loggerFailures = 0
    let timingFailures = 0
    const client = {
      get isOpen() {
        return open
      },
      connect: async () => {
        if (++connects === 1) throw original
        open = true
      },
      destroy: () => {
        open = false
      },
      withAbortSignal: () => ({
        set: async () => {
          writes++
          return 'OK'
        },
        wait: async () => 1,
      }),
    } as unknown as NodeRedis.NodeRedis['Service']['client']
    await Effect.gen(function* () {
      const cache = yield* ValkeyCache
      const result = yield* cache.put({ key: 'bayn:first', value: 'private', ttlMs: 5000 }).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result) && result.failure instanceof ValkeyCacheError)
        expect(result.failure.cause).toBe(original)
      yield* cache.put({ key: 'bayn:second', value: 'private', ttlMs: 5000 })
      yield* cache.put({ key: 'bayn:third', value: 'private', ttlMs: 5000 })
      expect(writes).toBe(2)
      expect(connects).toBe(2)
    }).pipe(
      Effect.provide(
        Layer.effect(ValkeyCache, makeValkeyCache).pipe(
          Layer.provide(Layer.succeed(NodeRedis.NodeRedis, { client, use: () => Effect.die('unused') })),
        ),
      ),
      Effect.provideService(
        ExecutionStageTimings,
        new (class extends Map<string, ExecutionStageTiming> {
          override set(key: string, value: ExecutionStageTiming) {
            if (key.startsWith('bayn.valkey.queue:')) {
              timingFailures++
              throw new Error('queue timing failed')
            }
            return super.set(key, value)
          }
        })(),
      ),
      Effect.provide(
        Logger.layer([
          Logger.make(({ fiber }) => {
            if (fiber.getRef(References.CurrentLogAnnotations)['stage'] === 'bayn.valkey.connect') {
              loggerFailures++
              throw new Error('connect logger failed')
            }
          }),
        ]),
      ),
      Effect.runPromise,
    )
    expect(timingFailures).toBe(3)
    expect(loggerFailures).toBe(1)
  })
  test.each(['deadline', 'interrupt'] as const)(
    'a queued %s cannot touch the active connection or strand the permit',
    async (mode) => {
      const started = Promise.withResolvers<void>()
      let open = true
      let gets = 0
      let writes = 0
      let destroys = 0
      const client = {
        get isOpen() {
          return open
        },
        connect: async () => {
          open = true
        },
        destroy: () => {
          open = false
          destroys++
        },
        withAbortSignal: () => ({
          get: () => {
            gets++
            started.resolve()
            return new Promise<never>(() => {})
          },
          set: async () => {
            writes++
            return 'OK'
          },
          wait: async () => 1,
        }),
      } as unknown as NodeRedis.NodeRedis['Service']['client']
      await Effect.gen(function* () {
        const cache = yield* ValkeyCache
        const holder = yield* cache.get('bayn:holder').pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
        yield* Effect.promise(() => started.promise)
        const queued = yield* cache.put({ key: 'bayn:queued', value: 'private', ttlMs: 5000 }).pipe(
          // A caller's shorter remaining budget can expire while another command owns the connection.
          mode === 'deadline' ? Effect.timeout('500 millis') : (effect) => effect,
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        )
        if (mode === 'interrupt') {
          yield* Fiber.interrupt(queued)
          expect(destroys).toBe(0)
          yield* Fiber.interrupt(holder)
        } else {
          yield* TestClock.adjust('500 millis')
          const result = yield* Fiber.join(queued)
          expect(Result.isFailure(result)).toBe(true)
          expect(destroys).toBe(0)
          yield* Fiber.interrupt(holder)
        }
        expect(writes).toBe(0)
        expect(gets).toBe(1)
        const metrics = yield* PrometheusMetrics.format()
        expect(phaseCount(metrics, 'queue', 'interrupted')).toBe('1')
        expect(phaseCount(metrics, 'connect', 'succeeded')).toBeUndefined()
        yield* cache.put({ key: 'bayn:after', value: 'private', ttlMs: 5000 })
        expect(writes).toBe(1)
      }).pipe(
        Effect.provide(
          Layer.effect(ValkeyCache, makeValkeyCache).pipe(
            Layer.provide(Layer.succeed(NodeRedis.NodeRedis, { client, use: () => Effect.die('unused') })),
          ),
        ),
        Effect.provide(TestClock.layer()),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provide(
          Logger.layer([
            Logger.make(({ fiber }) => {
              if (fiber.getRef(References.CurrentLogAnnotations)['stage'] === 'bayn.valkey.queue')
                throw new Error('queue observer failed')
            }),
          ]),
        ),
        Effect.runPromise,
      )
    },
  )
  test.each(['connect', 'set', 'replica-ack'] as const)(
    'attributes the unchanged total deadline to %s',
    async (blocked) => {
      const started = Promise.withResolvers<void>()
      let open = blocked !== 'connect'
      let writes = 0
      let waits = 0
      let destroyed = 0
      const hold = () => {
        started.resolve()
        return new Promise<never>(() => {})
      }
      const client = {
        get isOpen() {
          return open
        },
        connect: () => hold(),
        destroy: () => {
          open = false
          destroyed++
        },
        withAbortSignal: () => ({
          set: async () => {
            writes++
            return blocked === 'set' ? hold() : 'OK'
          },
          wait: async () => {
            waits++
            return hold()
          },
        }),
      } as unknown as NodeRedis.NodeRedis['Service']['client']
      const metrics = await Effect.gen(function* () {
        const cache = yield* ValkeyCache
        const fiber = yield* cache
          .put({ key: 'bayn:private', value: 'private', ttlMs: 5000 })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
        yield* Effect.promise(() => started.promise)
        yield* TestClock.adjust('999 millis')
        expect(writes).toBe(blocked === 'connect' ? 0 : 1)
        yield* TestClock.adjust('1 millis')
        const result = yield* Fiber.join(fiber)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(ValkeyCacheError)
          if (result.failure instanceof ValkeyCacheError) {
            expect(result.failure.category).toBe(ValkeyFailureCategory.OperationDeadline)
            expect(result.failure.causeCategory).toBeUndefined()
          }
        }
        return yield* PrometheusMetrics.format()
      }).pipe(
        Effect.provide(
          Layer.effect(ValkeyCache, makeValkeyCache).pipe(
            Layer.provide(Layer.succeed(NodeRedis.NodeRedis, { client, use: () => Effect.die('unused') })),
          ),
        ),
        Effect.provide(TestClock.layer()),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.runPromise,
      )
      expect(phaseCount(metrics, 'queue', 'succeeded')).toBe('1')
      expect(phaseCount(metrics, 'connect', blocked === 'connect' ? 'interrupted' : 'succeeded')).toBe('1')
      if (blocked === 'connect') expect(metrics).not.toContain('stage="bayn.valkey.set"')
      expect(waits).toBe(blocked === 'replica-ack' ? 1 : 0)
      expect(destroyed).toBe(blocked === 'connect' ? 0 : 1)
      expect(metrics).not.toContain('bayn:private')
    },
  )
})
