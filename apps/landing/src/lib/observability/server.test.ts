import { expect, test } from 'bun:test'
import { context, trace, propagation } from '@opentelemetry/api'
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { flushObservability, initializeObservability, injectTrace, observeRequest } from './server'

test('BFF exports a joined OTLP request without credentials, query strings, or bodies', async () => {
  const exports: Buffer[] = []
  const collector = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      exports.push(Buffer.from(await request.arrayBuffer()))
      return new Response(new Uint8Array(), { headers: { 'Content-Type': 'application/x-protobuf' } })
    },
  })
  const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  const previousRevision = process.env.APP_SOURCE_REVISION
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${collector.port}/v1/traces`
  process.env.APP_SOURCE_REVISION = 'a'.repeat(40)
  try {
    initializeObservability()
    trace.getTracer('next.js').startActiveSpan('framework.request', (span) => {
      span.setAttribute('http.target', '/api/auth/callback?code=PRIVATE_SENTINEL')
      span.end()
    })
    let forwarded = ''
    const response = await observeRequest(
      new Request('https://proompteng.ai/api/tengri?secret=PRIVATE_SENTINEL', {
        method: 'POST',
        headers: {
          traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
          cookie: 'PRIVATE_SENTINEL',
        },
        body: 'PRIVATE_SENTINEL',
      }),
      'tengri.action',
      async () => {
        injectTrace((name, value) => {
          if (name === 'traceparent') forwarded = value
        })
        await Promise.resolve()
        return new Response(null, { status: 204 })
      },
    )
    expect(response.headers.get('x-trace-id')).toBe('1'.repeat(32))
    expect(forwarded).toStartWith(`00-${'1'.repeat(32)}-`)
    expect(forwarded).not.toContain('2222222222222222')
    await flushObservability()
    expect(exports).toHaveLength(1)
    const bytes = exports[0]!
    expect(bytes.includes(Buffer.from('1'.repeat(32), 'hex'))).toBe(true)
    expect(bytes.includes(Buffer.from('tengri.action'))).toBe(true)
    expect(bytes.includes(Buffer.from('a'.repeat(40)))).toBe(true)
    expect(bytes.includes(Buffer.from('PRIVATE_SENTINEL'))).toBe(false)
  } finally {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = previousEndpoint
    process.env.APP_SOURCE_REVISION = previousRevision
    context.disable()
    trace.disable()
    propagation.disable()
    await collector.stop()
  }
})

test('stream spans stay open through delivery and end on close, failure, or cancellation', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  provider.register()
  const request = new Request('https://proompteng.ai/api/tengri/events')
  try {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const response = await observeRequest(
      request,
      'tengri.events',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              source = controller
            },
          }),
        ),
    )
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    const reader = response.body!.getReader()
    source.enqueue(new TextEncoder().encode('event: ready\n\n'))
    expect((await reader.read()).done).toBe(false)
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    source.close()
    expect((await reader.read()).done).toBe(true)
    expect(exporter.getFinishedSpans()).toHaveLength(1)

    const failed = await observeRequest(
      request,
      'tengri.events',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              source = controller
            },
          }),
        ),
    )
    source.error(new Error('Stream failed'))
    await expect(failed.body!.getReader().read()).rejects.toThrow('Stream failed')
    expect(exporter.getFinishedSpans()).toHaveLength(2)
    expect(exporter.getFinishedSpans()[1]!.status.code).toBe(2)

    let cancelled = false
    const closed = await observeRequest(
      request,
      'tengri.events',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    await closed.body!.cancel()
    expect(cancelled).toBe(true)
    expect(exporter.getFinishedSpans()).toHaveLength(3)
  } finally {
    await provider.shutdown()
    context.disable()
    trace.disable()
    propagation.disable()
  }
})
