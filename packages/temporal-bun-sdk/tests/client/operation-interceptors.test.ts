import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'

import { makeDefaultClientInterceptors, runClientInterceptors } from '../../src/interceptors/client'
import type { TemporalInterceptor } from '../../src/interceptors/types'
import type { Logger } from '../../src/observability/logger'
import type { MetricsExporter, MetricsRegistry } from '../../src/observability/metrics'
import { defaultRetryPolicy } from '../../src/client/retries'

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

describe('client operation interceptors', () => {
  test('retries transient rpc and records attempt metadata', async () => {
    const { logger } = createLogger()
    const metrics = createMetrics()
    const interceptors = await run(
      makeDefaultClientInterceptors({
        namespace: 'integration',
        taskQueue: 'demo',
        identity: 'client-1',
        logger,
        metricsRegistry: metrics.registry,
        metricsExporter: metrics.exporter,
        retryPolicy: { ...defaultRetryPolicy, maxAttempts: 3 },
        tracingEnabled: false,
      }),
    )

    let calls = 0
    const context = {
      kind: 'rpc' as const,
      namespace: 'integration',
      taskQueue: 'demo',
      identity: 'client-1',
      headers: {},
      metadata: { retryPolicy: { ...defaultRetryPolicy, maxAttempts: 3 } },
    }

    const result = await run(
      runClientInterceptors(interceptors as readonly TemporalInterceptor[], context, () =>
        Effect.tryPromise(async () => {
          calls += 1
          if (calls < 2) {
            throw new Error('flaky')
          }
          return 'ok'
        }),
      ),
    )

    expect(result).toBe('ok')
    expect(calls).toBe(2)
    expect(context.attempt).toBe(2)
    expect(metrics.counters.get('temporal_client_interceptor_rpc_total')).toBe(2)
    expect(metrics.counters.get('temporal_client_interceptor_rpc_errors_total') ?? 0).toBe(1)
  })

  test('records workflow operation telemetry and preserves headers', async () => {
    const { logger } = createLogger()
    const metrics = createMetrics()
    const interceptors = await run(
      makeDefaultClientInterceptors({
        namespace: 'integration',
        taskQueue: 'demo',
        identity: 'client-2',
        logger,
        metricsRegistry: metrics.registry,
        metricsExporter: metrics.exporter,
        tracingEnabled: true,
      }),
    )

    const headers: Record<string, string> = {}
    const context = {
      kind: 'workflow.signal' as const,
      namespace: 'integration',
      taskQueue: 'demo',
      identity: 'client-2',
      headers,
    }

    await run(
      runClientInterceptors(interceptors as readonly TemporalInterceptor[], context, () =>
        Effect.tryPromise(async () => 'signalled'),
      ),
    )

    expect(headers['temporal-namespace']).toBe('integration')
    expect(headers['temporal-client-identity']).toBe('client-2')
    expect(metrics.counters.get('temporal_client_interceptor_operation_total')).toBe(1)
  })
})
