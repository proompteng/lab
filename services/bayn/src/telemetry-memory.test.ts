import { expect, test } from 'bun:test'
import { Worker } from 'node:worker_threads'
import { Clock, Effect, Exit, Logger, Metric } from 'effect'
import { PrometheusMetrics } from 'effect/observability'
import { TestClock } from 'effect/testing'
import {
  observeWorkerMemory,
  recordProcessMemory,
  RuntimeIsolate,
  sampleRuntimeMemory,
  type RuntimeMemorySample,
} from './telemetry-memory'

const sample = {
  observedAtSeconds: 1234,
  heapUsed: 1024,
  heapTotal: 2048,
  external: 512,
  arrayBuffers: 256,
  heapLimit: 4096,
}

test('exports worker samples with their original clock and clears replaced or closed workers', async () => {
  const metrics = await Effect.runPromise(
    Effect.gen(function* () {
      const active = yield* Effect.scoped(
        Effect.gen(function* () {
          const observer = yield* observeWorkerMemory(RuntimeIsolate.MarketProjection)
          observer.receive(sample)
          yield* TestClock.adjust('15 seconds')
          const first = yield* PrometheusMetrics.format()
          yield* TestClock.adjust('60 seconds')
          const idle = yield* PrometheusMetrics.format()
          observer.clear()
          yield* observer.record
          const replaced = yield* PrometheusMetrics.format()
          observer.receive({ ...sample, observedAtSeconds: 5678 })
          yield* observer.record
          return { first, idle, replaced }
        }),
      )
      const closed = yield* PrometheusMetrics.format()
      yield* TestClock.adjust('60 seconds')
      return { ...active, closed, afterClose: yield* PrometheusMetrics.format() }
    }).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Metric.MetricRegistry, new Map())),
  )
  for (const text of [metrics.first, metrics.idle]) {
    expect(text).toContain('bayn_runtime_memory_sample_timestamp_seconds{isolate="market-projection"} 1234\n')
    expect(text).toContain('bayn_runtime_memory_bytes{isolate="market-projection",kind="heap_used"} 1024\n')
    expect(text).toContain('bayn_runtime_memory_bytes{isolate="market-projection",kind="array_buffers"} 256\n')
  }
  for (const text of [metrics.replaced, metrics.closed, metrics.afterClose]) {
    expect(text).toContain('bayn_runtime_memory_sample_timestamp_seconds{isolate="market-projection"} 0\n')
    expect(text).toContain('bayn_runtime_memory_bytes{isolate="market-projection",kind="heap_used"} 0\n')
  }
  expect(metrics.closed).toBe(metrics.afterClose)
})

test.each([undefined, { ...sample, heapUsed: -1 }, { ...sample, external: Number.NaN }])(
  'an unavailable or invalid worker sample remains an unavailable diagnostic',
  async (invalid) => {
    const metrics = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const observer = yield* observeWorkerMemory(RuntimeIsolate.DecisionConstruction)
          observer.receive(sample)
          yield* observer.record
          observer.receive(invalid)
          yield* observer.record
          return yield* PrometheusMetrics.format()
        }),
      ).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
    )
    expect(metrics).toContain('bayn_runtime_memory_sample_timestamp_seconds{isolate="decision-construction"} 0\n')
    expect(metrics).not.toContain('NaN')
  },
)

test('samples the current isolate and exports process RSS once without thread identities', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sample = yield* sampleRuntimeMemory
      yield* recordProcessMemory
      return { sample, metrics: yield* PrometheusMetrics.format() }
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
  )
  expect(result.sample?.heapUsed).toBeGreaterThan(0)
  // Bun runs this test with JavaScriptCore compatibility counters; retain the raw fields without a V8 ordering assumption.
  expect(result.sample?.heapTotal).toBeGreaterThan(0)
  expect(result.sample?.heapLimit).toBeGreaterThan(0)
  expect(result.metrics).toMatch(/bayn_runtime_process_resident_memory_bytes [1-9][0-9]*\n/)
  expect(result.metrics).not.toContain('threadId')
  expect(result.metrics).not.toContain('workerId')
})

test('a real worker can sample its isolate but cannot export parent memory or duplicate process RSS', async () => {
  const worker = new Worker(new URL('./telemetry-memory-worker.test-support.ts', import.meta.url))
  try {
    const result = await new Promise<{ sample: RuntimeMemorySample | undefined; metrics: string }>(
      (resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
      },
    )
    expect(result.sample?.heapUsed).toBeGreaterThan(0)
    expect(result.metrics).not.toContain('bayn_runtime_process_resident_memory_bytes')
    expect(result.metrics).not.toContain('isolate="main"')
  } finally {
    await worker.terminate()
  }
}, 10_000)

test('diagnostic sampling and metric failures preserve the surrounding work without exporting private causes', async () => {
  const messages: unknown[] = []
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock
        const unavailable = yield* sampleRuntimeMemory.pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillis: Effect.die('private sampling failure'),
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            sleep: (duration) => clock.sleep(duration),
          }),
        )
        const observer = yield* observeWorkerMemory(RuntimeIsolate.DecisionConstruction)
        observer.receive(sample)
        yield* observer.record
        return { unavailable, outcome: 'unchanged' }
      }),
    ).pipe(
      Effect.provideService(
        Metric.MetricRegistry,
        new (class extends Map {
          override set(): this {
            throw new Error('private metric failure')
          }
        })(),
      ),
      Effect.provide(Logger.layer([Logger.make((options) => messages.push(options.message))])),
    ),
  )
  expect(result).toEqual({ unavailable: undefined, outcome: 'unchanged' })
  expect(JSON.stringify(messages)).toContain('Bayn isolate memory diagnostic could not be recorded')
  expect(JSON.stringify(messages)).not.toContain('private')
})

test.each(['failure', 'defect', 'interruption'])(
  'scope %s clears memory while preserving the original exit',
  async (kind) => {
    const reason = { original: true }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const observer = yield* observeWorkerMemory(RuntimeIsolate.MarketProjection)
              observer.receive(sample)
              yield* observer.record
              return yield* kind === 'failure'
                ? Effect.fail(reason)
                : kind === 'defect'
                  ? Effect.die(reason)
                  : Effect.interrupt
            }),
          ),
        )
        return { exit, metrics: yield* PrometheusMetrics.format() }
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
    )
    expect(Exit.isFailure(result.exit)).toBe(true)
    if (Exit.isFailure(result.exit)) {
      expect(result.exit.cause.reasons).toHaveLength(1)
      expect(result.exit.cause.reasons[0]?._tag).toBe(
        kind === 'failure' ? 'Fail' : kind === 'defect' ? 'Die' : 'Interrupt',
      )
    }
    expect(result.metrics).toContain('bayn_runtime_memory_sample_timestamp_seconds{isolate="market-projection"} 0\n')
  },
)
