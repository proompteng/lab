import { expect, test } from 'bun:test'

import { ExportResultCode } from '../src/core'
import { OTLPTraceExporter } from '../src/exporter-trace-otlp-http'
import { SpanKind, SpanStatusCode, type SpanData } from '../src/sdk-trace'

test('trace exporter emits OTLP resourceSpans payload', async () => {
  const requests: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url, init) => {
    if (typeof init?.body === 'string') {
      requests.push(init.body)
    }
    return new Response('', { status: 200 })
  }) as typeof fetch

  try {
    const exporter = new OTLPTraceExporter({ url: 'http://collector.test/v1/traces' })
    const span: SpanData = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      name: 'unit-span',
      kind: SpanKind.INTERNAL,
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { env: 'test' },
      status: { code: SpanStatusCode.OK },
      resourceAttributes: { 'service.name': 'otel-test' },
      scope: { name: 'unit-test' },
    }

    await new Promise<void>((resolve, reject) => {
      exporter.export([span], (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          resolve()
          return
        }
        reject(result.error)
      })
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(requests.length).toBe(1)
  const payload = JSON.parse(requests[0] ?? '{}')
  const resourceSpans = payload.resourceSpans?.[0]
  expect(resourceSpans?.resource?.attributes?.[0]?.key).toBe('service.name')
  const scopeSpans = resourceSpans?.scopeSpans?.[0]
  expect(scopeSpans?.scope?.name).toBe('unit-test')
  const spanNames = scopeSpans?.spans?.map((entry: { name: string }) => entry.name)
  expect(spanNames).toContain('unit-span')
})
