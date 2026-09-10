import { expect, test } from 'bun:test'
import http2 from 'node:http2'

import { ExportResultCode } from '../src/core'
import { OTLPTraceExporter } from '../src/exporter-trace-otlp-http'
import { Resource } from '../src/resources'
import {
  createSimpleSpanProcessor,
  type SpanData,
  type SpanExporter,
  SpanKind,
  SpanStatusCode,
  TracerProvider,
} from '../src/sdk-trace'

class TestSpanExporter implements SpanExporter {
  readonly exported: SpanData[] = []

  export(spans: SpanData[], resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    this.exported.push(...spans)
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  async shutdown(): Promise<void> {}
}

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

test('trace exporter emits protobuf payload when configured', async () => {
  let capturedContentType: string | undefined
  let capturedLength = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    capturedContentType = headers?.['content-type'] ?? headers?.['Content-Type']
    const body = init?.body
    if (body instanceof Uint8Array) {
      capturedLength = body.length
    } else if (body instanceof ArrayBuffer) {
      capturedLength = body.byteLength
    }
    return new Response('', { status: 200 })
  }) as typeof fetch

  try {
    const exporter = new OTLPTraceExporter({
      url: 'http://collector.test/v1/traces',
      protocol: 'http/protobuf',
    })
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

  expect(capturedContentType).toBe('application/x-protobuf')
  expect(capturedLength).toBeGreaterThan(0)
})

test('tracer preserves parent-child relationships', async () => {
  const exporter = new TestSpanExporter()
  const provider = new TracerProvider({
    resource: new Resource({ 'service.name': 'otel-test' }),
  })
  provider.addSpanProcessor(createSimpleSpanProcessor(exporter))

  const tracer = provider.getTracer('unit-test')
  const parent = tracer.startSpan('parent-span')
  const child = tracer.startSpan('child-span', { parentSpan: parent })
  child.end()
  parent.end()
  await provider.forceFlush()
  await provider.shutdown()

  const parentSpan = exporter.exported.find((span) => span.name === 'parent-span')
  const childSpan = exporter.exported.find((span) => span.name === 'child-span')

  expect(parentSpan).toBeDefined()
  expect(childSpan).toBeDefined()
  expect(childSpan?.traceId).toBe(parentSpan?.traceId)
  expect(childSpan?.parentSpanId).toBe(parentSpan?.spanId)
})

test('trace exporter sends gRPC payload', async () => {
  const server = http2.createServer()
  let receivedPath = ''
  let receivedLength = 0

  server.on('stream', (stream, headers) => {
    receivedPath = String(headers[':path'] ?? '')
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk))
    })
    stream.on('end', () => {
      const payload = Buffer.concat(chunks)
      if (payload.length >= 5) {
        receivedLength = payload.readUInt32BE(1)
      }
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
      stream.end(Buffer.from([0, 0, 0, 0, 0]))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  try {
    const exporter = new OTLPTraceExporter({
      url: `http://127.0.0.1:${port}`,
      protocol: 'grpc',
      timeoutMillis: 2000,
    })
    const span: SpanData = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      name: 'grpc-span',
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
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  expect(receivedPath).toBe('/opentelemetry.proto.collector.trace.v1.TraceService/Export')
  expect(receivedLength).toBeGreaterThan(0)
})
