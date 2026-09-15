import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { ConnectError, Code } from '@connectrpc/connect'

import { makeDefaultInterceptorBuilder } from '../../src/client/interceptors'
import type { Logger } from '../../src/observability/logger'
import type { MetricsExporter, MetricsRegistry } from '../../src/observability/metrics'

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

const makeUnaryRequest = () => ({
  stream: false,
  service: { typeName: 'temporal.WorkflowService', methods: [] },
  method: { name: 'DescribeNamespace' },
  url: 'https://temporal.example',
  header: new Headers(),
  signal: new AbortController().signal,
  message: {},
}) as unknown

describe('default interceptor builder', () => {
  test('applies auth headers, logs, and records success metrics', async () => {
    const { logger, entries } = createLogger()
    const metrics = createMetrics()
    const builder = makeDefaultInterceptorBuilder()
    const interceptors = await run(
      builder.build({
        namespace: 'resilience',
        identity: 'client-123',
        logger,
        metricsRegistry: metrics.registry,
        metricsExporter: metrics.exporter,
      }),
    )

    const pipeline = interceptors.reduceRight(
      (next, interceptor) => interceptor(next),
      async (req: any) => {
        return {
          stream: false,
          service: req.service,
          method: req.method,
          header: new Headers(),
          trailer: new Headers(),
          message: {},
        }
      },
    )

    await pipeline(makeUnaryRequest())

    expect(entries.some((entry) => entry.message.includes('temporal rpc request'))).toBe(true)
    expect(entries.some((entry) => entry.message.includes('temporal rpc response'))).toBe(true)
    expect(metrics.counters.get('temporal_rpc_client_total')).toBe(1)
    expect(metrics.counters.get('temporal_rpc_client_failures_total') ?? 0).toBe(0)
    expect((metrics.histograms.get('temporal_rpc_client_latency_ms') ?? []).length).toBe(1)
  })

  test('records failures and preserves thrown errors', async () => {
    const { logger } = createLogger()
    const metrics = createMetrics()
    const builder = makeDefaultInterceptorBuilder()
    const interceptors = await run(
      builder.build({
        namespace: 'resilience',
        identity: 'client-123',
        logger,
        metricsRegistry: metrics.registry,
        metricsExporter: metrics.exporter,
      }),
    )

    const pipeline = interceptors.reduceRight(
      (next, interceptor) => interceptor(next),
      async (_req: any) => {
        throw new ConnectError('boom', Code.Internal)
      },
    )

    await expect(pipeline(makeUnaryRequest())).rejects.toThrow('boom')
    expect(metrics.counters.get('temporal_rpc_client_failures_total')).toBe(1)
  })
})
