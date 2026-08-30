import { afterAll, describe, expect, test } from 'bun:test'

import { metrics, trace } from '../../src/otel/api'
import { registerOpenTelemetry } from '../../src/observability/opentelemetry'

type CapturedRequest = {
  path: string
  body: string
}

const capturedRequests: CapturedRequest[] = []
let handle: Awaited<ReturnType<typeof registerOpenTelemetry>>
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = await request.text()
    capturedRequests.push({ path: url.pathname, body })
    return new Response('', { status: 200 })
  },
})

afterAll(async () => {
  if (handle) {
    await handle.shutdown()
  }
  await server.stop(true)
})

const waitFor = async (predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await Bun.sleep(intervalMs)
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`)
}

describe('registerOpenTelemetry', () => {
  test('exports trace and metrics payloads over OTLP http/json', { timeout: 20_000 }, async () => {
    handle = await registerOpenTelemetry({
      enabled: true,
      serviceName: 'temporal-bun-sdk-test',
      tracesEndpoint: `http://127.0.0.1:${server.port}/v1/traces`,
      metricsEndpoint: `http://127.0.0.1:${server.port}/v1/metrics`,
      exportIntervalMs: 5_000,
    })

    expect(handle).toBeDefined()

    const tracer = trace.getTracer('temporal-bun-sdk-test')
    const span = tracer.startSpan('otlp-smoke-span')
    span.end()

    const meter = metrics.getMeter('temporal-bun-sdk-test')
    const counter = meter.createCounter('temporal_bun_sdk_otlp_smoke_total')
    counter.add(1, { source: 'test' })

    await waitFor(() => capturedRequests.some((entry) => entry.path === '/v1/traces'), 2_000)
    await waitFor(() => capturedRequests.some((entry) => entry.path === '/v1/metrics'), 8_000)

    const tracePayload = capturedRequests.find((entry) => entry.path === '/v1/traces')
    const metricPayload = capturedRequests.find((entry) => entry.path === '/v1/metrics')

    expect(tracePayload?.body).toContain('resourceSpans')
    expect(tracePayload?.body).toContain('otlp-smoke-span')
    expect(metricPayload?.body).toContain('resourceMetrics')
    expect(metricPayload?.body).toContain('temporal_bun_sdk_otlp_smoke_total')
  })
})
