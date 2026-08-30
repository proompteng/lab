import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { NodeHttpClient } from '@effect/platform-node'
import { ConfigProvider, Effect, Layer, Logger, References } from 'effect'
import { OtlpSerialization, OtlpTracer } from 'effect/unstable/observability'

import { decodeOtlpTraceEndpoint, telemetryRuntimeConfig, withObservedSpan } from './telemetry'

describe('Bayn telemetry', () => {
  test('loads bounded resource attributes through Effect Config', async () => {
    const options = await Effect.runPromise(
      telemetryRuntimeConfig('bayn-test').pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            BAYN_CODE_REVISION: ' source-revision ',
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ' http://tempo:4318/v1/traces ',
            NODE_ENV: ' production ',
            POD_NAMESPACE: ' bayn ',
            HOSTNAME: ' bayn-test-0 ',
          }),
        ),
      ),
    )

    expect(options).toEqual({
      serviceName: 'bayn-test',
      serviceVersion: 'source-revision',
      endpoint: 'http://tempo:4318/v1/traces',
      environment: 'production',
      namespace: 'bayn',
      instanceId: 'bayn-test-0',
    })
  })

  test('accepts only an uncredentialed HTTP(S) OTLP traces endpoint', () => {
    expect(decodeOtlpTraceEndpoint(undefined)).toEqual({ _tag: 'Disabled' })
    expect(decodeOtlpTraceEndpoint('http://tempo.observability.svc:4318/v1/traces')).toEqual({
      _tag: 'Configured',
      url: 'http://tempo.observability.svc:4318/v1/traces',
    })
    expect(decodeOtlpTraceEndpoint('http://user:secret@tempo:4318/v1/traces')._tag).toBe('Invalid')
    expect(decodeOtlpTraceEndpoint('http://tempo:4318')._tag).toBe('Invalid')
    expect(decodeOtlpTraceEndpoint('file:///tmp/traces')._tag).toBe('Invalid')
  })

  test('correlates Effect logs with the active trace and span', async () => {
    const annotations: Array<Record<string, unknown>> = []
    const logger = Logger.make((options) => {
      annotations.push(options.fiber.getRef(References.CurrentLogAnnotations))
    })

    await Effect.runPromise(
      Effect.logInfo('correlated').pipe(withObservedSpan('bayn.test'), Effect.provide(Logger.layer([logger]))),
    )

    expect(annotations).toHaveLength(1)
    expect(annotations[0]?.['trace_id']).toMatch(/^[0-9a-f]{32}$/)
    expect(annotations[0]?.['span_id']).toMatch(/^[0-9a-f]{16}$/)
  })

  test('exports Effect spans as OTLP protobuf', async () => {
    let resolveRequest: ((request: { readonly path: string; readonly body: Uint8Array }) => void) | undefined
    const received = new Promise<{ readonly path: string; readonly body: Uint8Array }>((resolve) => {
      resolveRequest = resolve
    })
    const server = createServer((request, response) => {
      const chunks: Array<Uint8Array> = []
      request.on('data', (chunk: Uint8Array) => chunks.push(chunk))
      request.on('end', () => {
        resolveRequest?.({ path: request.url ?? '', body: Buffer.concat(chunks) })
        response.writeHead(200).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('telemetry test server did not bind TCP')

    const tracer = OtlpTracer.layer({
      url: `http://127.0.0.1:${address.port}/v1/traces`,
      resource: { serviceName: 'bayn-telemetry-test', serviceVersion: 'test-version' },
      maxBatchSize: 1,
      exportInterval: '1 millis',
      shutdownTimeout: '1 second',
    }).pipe(Layer.provide(Layer.mergeAll(NodeHttpClient.layerNodeHttp, OtlpSerialization.layerProtobuf)))

    try {
      await Effect.runPromise(Effect.void.pipe(withObservedSpan('bayn.test.export'), Effect.provide(tracer)))
      const request = await received
      expect(request.path).toBe('/v1/traces')
      expect(request.body.byteLength).toBeGreaterThan(0)
      expect(Buffer.from(request.body).includes(Buffer.from('bayn-telemetry-test'))).toBe(true)
      expect(Buffer.from(request.body).includes(Buffer.from('bayn.test.export'))).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      )
    }
  })
})
