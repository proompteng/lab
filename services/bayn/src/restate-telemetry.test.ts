import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'

import type { Request as RestateRequest } from '@restatedev/restate-sdk'
import { Effect } from 'effect'

import { acquireRestateTelemetry, currentOpenTelemetryLogAnnotations } from './restate-telemetry'

const fakeRequest = {
  target: {
    service: 'BaynLifecycle',
    handler: 'advance',
    toString: () => 'BaynLifecycle/advance',
  },
  id: 'inv_test',
  headers: new Map(),
  attemptHeaders: new Map(),
  body: new Uint8Array(),
  extraArgs: [],
  signal: new AbortController().signal,
} as unknown as RestateRequest

describe('Bayn Restate telemetry', () => {
  test('is a no-op when no OTLP endpoint is configured', async () => {
    const telemetry = await Effect.runPromise(Effect.scoped(acquireRestateTelemetry({ serviceName: 'bayn-restate' })))

    expect(telemetry.hooks).toEqual([])
    expect(telemetry.traceHeaders()).toEqual({})
  })

  test('exports official Restate attempt spans and propagates their W3C context', async () => {
    let resolveRequest: ((request: { readonly path: string; readonly body: Uint8Array }) => void) | undefined
    const received = new Promise<{ readonly path: string; readonly body: Uint8Array }>((resolve) => {
      resolveRequest = resolve
    })
    const server = createServer((request, response) => {
      const chunks: Uint8Array[] = []
      request.on('data', (chunk: Uint8Array) => chunks.push(chunk))
      request.on('end', () => {
        resolveRequest?.({ path: request.url ?? '', body: Buffer.concat(chunks) })
        response.writeHead(200).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('telemetry test server did not bind TCP')

    let traceparent: string | undefined
    let logAnnotations: Readonly<Record<string, string>> = {}
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const telemetry = yield* acquireRestateTelemetry({
              serviceName: 'bayn-restate-test',
              serviceVersion: 'test-version',
              endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
            })
            const provider = telemetry.hooks[0]
            if (provider === undefined) throw new Error('Restate tracing hook was not configured')
            const handler = provider({ request: fakeRequest }).interceptor?.handler
            if (handler === undefined) throw new Error('Restate tracing handler interceptor was not configured')
            yield* Effect.promise(() =>
              handler(async () => {
                traceparent = telemetry.traceHeaders().traceparent
                logAnnotations = currentOpenTelemetryLogAnnotations()
              }),
            )
          }),
        ),
      )

      const request = await received
      expect(request.path).toBe('/v1/traces')
      expect(request.body.byteLength).toBeGreaterThan(0)
      expect(Buffer.from(request.body).includes(Buffer.from('bayn-restate-test'))).toBe(true)
      expect(Buffer.from(request.body).includes(Buffer.from('attempt BaynLifecycle/advance'))).toBe(true)
      expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
      if (traceparent === undefined) throw new Error('Restate trace context was not propagated')
      const [, traceId, spanId] = traceparent.split('-')
      expect(logAnnotations['trace_id']).toBe(traceId)
      expect(logAnnotations['span_id']).toBe(spanId)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      )
    }
  })
})
