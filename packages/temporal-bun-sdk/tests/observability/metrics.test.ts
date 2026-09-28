import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMetricsExporter, createMetricsRegistry } from '../../src/observability/metrics'

test('file metrics exporter emits JSON lines', async () => {
  const path = join(tmpdir(), `metrics-${Date.now()}.json`)
  const exporter = await Effect.runPromise(createMetricsExporter({ type: 'file', endpoint: path }))
  const registry = createMetricsRegistry(exporter)
  const counter = await Effect.runPromise(registry.counter('test_counter', 'test counter'))
  await Effect.runPromise(counter.inc(3))
  const histogram = await Effect.runPromise(registry.histogram('test_hist', 'test hist'))
  await Effect.runPromise(histogram.observe(42))
  await Effect.runPromise(exporter.flush())

  const content = await readFile(path, 'utf8')
  const lines = content.split('\n').filter(Boolean)
  expect(lines.length).toBe(2)

  const parsed = lines.map((line) => JSON.parse(line))
  expect(parsed[0]).toMatchObject({ type: 'counter', name: 'test_counter', value: 3 })
  expect(parsed[1]).toMatchObject({ type: 'histogram', name: 'test_hist', value: 42 })
})

test('prometheus exporter aggregates histogram stats without retaining samples', async () => {
  const path = join(tmpdir(), `prom-metrics-${Date.now()}.prom`)
  const exporter = await Effect.runPromise(createMetricsExporter({ type: 'prometheus', endpoint: path }))
  const registry = createMetricsRegistry(exporter)
  const histogram = await Effect.runPromise(registry.histogram('worker_latency_ms', 'worker latency'))
  await Effect.runPromise(histogram.observe(5))
  await Effect.runPromise(histogram.observe(15))
  await Effect.runPromise(exporter.flush())

  const content = await readFile(path, 'utf8')
  expect(content).toContain('worker_latency_ms_count 2')
  expect(content).toContain('worker_latency_ms_sum 20')
  expect(content).toContain('worker_latency_ms_min 5')
  expect(content).toContain('worker_latency_ms_max 15')
})

test('otlp exporter emits ExportMetricsServiceRequest payload', async () => {
  const endpoint = 'http://collector.test/v1/metrics'
  const requests: { url: string | URL; body?: string }[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url, init) => {
    let body: string | undefined
    if (init?.body && typeof init.body === 'string') {
      body = init.body
    }
    requests.push({ url, body })
    return new Response('', { status: 200 })
  }) as typeof fetch

  try {
    const exporter = await Effect.runPromise(createMetricsExporter({ type: 'otlp', endpoint }))
    const registry = createMetricsRegistry(exporter)
    const counter = await Effect.runPromise(registry.counter('otlp_counter', 'test counter'))
    await Effect.runPromise(counter.inc(2))
    const histogram = await Effect.runPromise(registry.histogram('otlp_hist', 'test histogram'))
    await Effect.runPromise(histogram.observe(3))
    await Effect.runPromise(histogram.observe(7))
    await Effect.runPromise(exporter.flush())
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(requests).toHaveLength(1)
  const payload = JSON.parse(requests[0].body ?? '{}')
  const scopeMetrics = payload.resourceMetrics?.[0]?.scopeMetrics?.[0]
  expect(scopeMetrics?.metrics?.length).toBeGreaterThanOrEqual(2)
  const metricNames = scopeMetrics.metrics.map((metric: { name: string }) => metric.name)
  expect(metricNames).toContain('otlp_counter')
  expect(metricNames).toContain('otlp_hist')
})
