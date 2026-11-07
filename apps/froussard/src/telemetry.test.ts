import { createServer, type Server } from 'node:http'

import { Effect, ManagedRuntime } from 'effect'
import { OtlpExporter } from 'effect/observability'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeTelemetryLayer, traceRequest } from './telemetry'
import { makeLinearWebhookMetrics } from './webhooks/linear-metrics'

describe('native Effect telemetry', () => {
  const originalEnv = process.env
  let server: Server
  let runtime: ManagedRuntime.ManagedRuntime<OtlpExporter.Flusher, never>
  let requests: Array<{ path: string; body: string; contentType: string | undefined }>
  let traceFailures: number
  let traceStatus: number
  let hang: boolean
  let connectionClosed: boolean

  beforeEach(async () => {
    requests = []
    traceFailures = 0
    traceStatus = 503
    hang = false
    connectionClosed = false
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({
        path: request.url ?? '',
        body: Buffer.concat(chunks).toString(),
        contentType: request.headers['content-type'],
      })
      if (hang) {
        response.once('close', () => {
          connectionClosed = true
        })
        return
      }
      const fail = request.url === '/v1/traces' && traceFailures-- > 0
      response.writeHead(fail ? traceStatus : 200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Receiver has no TCP address')
    process.env = {
      ...originalEnv,
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_SERVICE_NAME: 'froussard',
      OTEL_SERVICE_NAMESPACE: 'froussard-test',
      FROUSSARD_COMMIT: 'native-effect-test',
      POD_NAME: 'froussard-test-pod',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${address.port}/v1/metrics`,
      OTEL_BSP_SCHEDULE_DELAY: '60000',
      OTEL_METRIC_EXPORT_INTERVAL: '60000',
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '5000',
      OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: '5000',
    }
    runtime = ManagedRuntime.make(makeTelemetryLayer())
    await runtime.runPromise(Effect.void)
  })

  afterEach(async () => {
    await runtime.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    process.env = originalEnv
  })

  const flush = () => runtime.runPromise(Effect.flatMap(OtlpExporter.Flusher, (flusher) => flusher.flush))
  const traceBodies = () => requests.filter(({ path }) => path === '/v1/traces').map(({ body }) => body)

  it('exports the complete handler lifetime, parent context and bounded route without private URL or body data', async () => {
    const request = new Request('http://localhost/webhooks/linear?secret=private-query', {
      method: 'POST',
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
      body: 'private-body',
    })
    const response = await runtime.runPromise(
      traceRequest(request, '/webhooks/:provider', async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return new Response('accepted', { status: 202 })
      }),
    )
    expect(response.status).toBe(202)
    expect(requests).toHaveLength(0)
    await runtime.dispose()
    expect(traceBodies()).toHaveLength(1)
    const body = traceBodies()[0] ?? ''
    expect(JSON.parse(body)).toMatchObject({
      resourceSpans: [
        {
          resource: {
            attributes: expect.arrayContaining([
              { key: 'service.name', value: { stringValue: 'froussard' } },
              { key: 'service.version', value: { stringValue: 'native-effect-test' } },
              { key: 'service.instance.id', value: { stringValue: 'froussard-test-pod' } },
            ]),
          },
          scopeSpans: [
            {
              spans: [
                expect.objectContaining({
                  name: 'POST /webhooks/:provider',
                  traceId: '0af7651916cd43dd8448eb211c80319c',
                  parentSpanId: 'b7ad6b7169203331',
                  kind: 2,
                  attributes: expect.arrayContaining([{ key: 'http.response.status_code', value: { intValue: 202 } }]),
                }),
              ],
            },
          ],
        },
      ],
    })
    const start = body.match(/"startTimeUnixNano":"(\d+)"/)?.[1]
    const end = body.match(/"endTimeUnixNano":"(\d+)"/)?.[1]
    expect(start).toBeDefined()
    expect(end).toBeDefined()
    expect(BigInt(end ?? 0) - BigInt(start ?? 0)).toBeGreaterThanOrEqual(20_000_000n)
    expect(body).not.toContain('private-query')
    expect(body).not.toContain('private-body')
    expect(requests.every(({ contentType }) => contentType === 'application/json')).toBe(true)
  })

  it.each([200, 401, 503])('preserves HTTP %i while exporting response status and request metrics', async (status) => {
    const response = await runtime.runPromise(
      traceRequest(new Request('http://localhost/'), '/', () => new Response('', { status })),
    )
    expect(response.status).toBe(status)
    await flush()
    expect(traceBodies().join('')).toContain(`"intValue":${status}`)
    expect(traceBodies().join('')).toContain(`"status":{"code":${status >= 500 ? 2 : 1}`)
    const metrics = requests.find(({ path }) => path === '/v1/metrics')?.body ?? ''
    expect(metrics).toContain('froussard_http_requests_total')
    expect(metrics).toContain(`"stringValue":"${status}"`)
    expect(metrics).toContain('froussard_http_request_duration_ms')
  })

  it('exports failed handlers as errors and counts the failure', async () => {
    await expect(
      runtime.runPromise(
        traceRequest(new Request('http://localhost/'), '/', () => {
          throw new Error('handler failed')
        }),
      ),
    ).rejects.toThrow('handler failed')
    await flush()
    expect(traceBodies().join('')).toContain('"status":{"code":2')
    expect(requests.find(({ path }) => path === '/v1/metrics')?.body).toContain('"stringValue":"500"')
  })

  it('batches requests and exports native Linear counters and histograms on shutdown', async () => {
    for (let i = 0; i < 10; i++) {
      await runtime.runPromise(traceRequest(new Request('http://localhost/'), '/', () => new Response('OK')))
    }
    const metrics = makeLinearWebhookMetrics(runtime)
    metrics.recordVerificationFailure('signature')
    metrics.recordDownstreamFailure('kafka', 'timeout')
    metrics.recordDeliveryLatencyMs(25, 'retry')
    await runtime.dispose()
    expect(traceBodies()).toHaveLength(1)
    expect(traceBodies()[0]?.match(/"name":"GET \/"/g)).toHaveLength(10)
    const body = requests.find(({ path }) => path === '/v1/metrics')?.body ?? ''
    for (const name of [
      'froussard_linear_webhook_verification_failures_total',
      'froussard_linear_webhook_downstream_failures_total',
      'froussard_linear_webhook_delivery_latency_ms',
    ])
      expect(body).toContain(name)
    expect(body).toContain('"asDouble":10')
    expect(body).toContain('"isMonotonic":true')
    expect(body).toContain('"aggregationTemporality":2')
    expect(body).toContain('"histogram"')
  })

  it('retries transient receiver failures with identical batches', async () => {
    traceFailures = 2
    await runtime.runPromise(traceRequest(new Request('http://localhost/'), '/', () => new Response('OK')))
    await runtime.dispose()
    expect(traceBodies()).toHaveLength(3)
    expect(new Set(traceBodies()).size).toBe(1)
  })

  it('does not retry a permanent receiver error', async () => {
    traceFailures = 5
    traceStatus = 400
    await runtime.runPromise(traceRequest(new Request('http://localhost/'), '/', () => new Response('OK')))
    await runtime.dispose()
    expect(traceBodies()).toHaveLength(1)
  })

  it('bounds shutdown and cancels a hung receiver', async () => {
    await runtime.dispose()
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = '200'
    process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT = '200'
    runtime = ManagedRuntime.make(makeTelemetryLayer())
    await runtime.runPromise(traceRequest(new Request('http://localhost/'), '/', () => new Response('OK')))
    hang = true
    const started = performance.now()
    await runtime.dispose()
    expect(performance.now() - started).toBeLessThan(1500)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(connectionClosed).toBe(true)
  })
})
