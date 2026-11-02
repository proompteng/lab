import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'

import { makeDefaultWorkerInterceptors, runWorkerInterceptors } from '../src/interceptors/worker'
import type { TemporalInterceptor } from '../src/interceptors/types'
import type { Logger } from '../src/observability/logger'
import type { MetricsExporter, MetricsRegistry } from '../src/observability/metrics'
import { createDefaultDataConverter } from '../src/common/payloads'

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

const createLogger = () => {
  const entries: { level: string; message: string }[] = []
  const logger: Logger = {
    log(level, message) {
      entries.push({ level, message })
      return Effect.void
    },
  }
  return { logger, entries }
}

const createMetrics = () => {
  const counters = new Map<string, number>()
  const histograms = new Map<string, number[]>()
  const registry: MetricsRegistry = {
    counter(name) {
      return Effect.succeed({
        inc(value = 1) {
          return Effect.sync(() => {
            counters.set(name, (counters.get(name) ?? 0) + value)
          })
        },
      })
    },
    histogram(name) {
      return Effect.succeed({
        observe(value) {
          return Effect.sync(() => {
            const bucket = histograms.get(name) ?? []
            bucket.push(value)
            histograms.set(name, bucket)
          })
        },
      })
    },
  }
  const exporter: MetricsExporter = {
    recordCounter() {
      return Effect.void
    },
    recordHistogram() {
      return Effect.void
    },
    flush() {
      return Effect.void
    },
  }
  return { registry, exporter, counters, histograms }
}

describe('worker interceptors', () => {
  test('record activity task metrics and tracing data', async () => {
    const { logger } = createLogger()
    const metrics = createMetrics()
    const interceptors = await run(
      makeDefaultWorkerInterceptors({
        namespace: 'default',
        taskQueue: 'worker-q',
        identity: 'worker-1',
        logger,
        metricsRegistry: metrics.registry,
        metricsExporter: metrics.exporter,
        dataConverter: createDefaultDataConverter(),
        tracingEnabled: true,
      }),
    )

    const context = {
      kind: 'worker.activityTask' as const,
      namespace: 'default',
      taskQueue: 'worker-q',
      identity: 'worker-1',
      attempt: 1,
    }

    const result = await run(
      runWorkerInterceptors(interceptors as readonly TemporalInterceptor[], context, () =>
        Effect.tryPromise(async () => 'done'),
      ),
    )

    expect(result).toBe('done')
    expect(metrics.counters.get('temporal_worker_interceptor_activity_total')).toBe(1)
    expect(metrics.histograms.get('temporal_worker_interceptor_activity_latency_ms')?.length ?? 0).toBeGreaterThan(0)
  })
})
