import { expect, test } from 'bun:test'
import { Cause, Effect, Exit, Logger, Option, Redacted, References, Result, Tracer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { alpacaSandboxBaseUrl, decodeBrokerConnection } from '../connection'
import { BrokerEnvironment, BrokerProvider } from '../identity'
import { BrokerReadErrorKind } from './failures'
import { make } from './http'

test.each([null, 'private-position-value'])(
  'positions HTTP rejection emits only safe schema categories for %s',
  async (qty) => {
    const privateValues = ['private-position-value', 'private-key', 'private-secret', 'private-response-key']
    const connection = Result.getOrThrow(
      decodeBrokerConnection({
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        baseUrl: alpacaSandboxBaseUrl,
        expectedAccountId: 'e6fe16f3-64a4-4921-8928-cadf02f92f98',
        key: Redacted.make('private-key'),
        secret: Redacted.make('private-secret'),
        proxyUrl: 'http://bayn-egress-proxy:3128',
        operationTimeoutMs: 30_000,
        retryAttempts: 0,
      }),
    )
    const logs: Array<{ message: unknown; annotations: Readonly<Record<string, unknown>> }> = []
    const logger = Logger.make((entry) =>
      logs.push({ message: entry.message, annotations: entry.fiber.getRef(References.CurrentLogAnnotations) }),
    )
    const spans: Tracer.Span[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = Tracer.nativeTracer.span(options)
        spans.push(span)
        return span
      },
    })
    let calls = 0
    const client = HttpClient.make((request, url) => {
      calls += 1
      expect(request.method).toBe('GET')
      expect(url.pathname).toBe('/v2/positions')
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify([
              {
                asset_id: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
                symbol: 'AAPL',
                exchange: 'NASDAQ',
                asset_class: 'us_equity',
                avg_entry_price: '100',
                cost_basis: '500',
                qty,
                side: 'long',
                market_value: '600',
                unrealized_pl: '100',
                current_price: '120',
                'private-response-key': 'private-position-value',
              },
            ]),
            { headers: { 'content-type': 'application/json', 'x-request-id': 'private-request-id' } },
          ),
        ),
      )
    })
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(make(connection), (read) => read.positions).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provide(Logger.layer([logger])),
      ),
    )
    if (Exit.isSuccess(exit)) throw new Error('Expected synthetic schema rejection')
    expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
      operation: 'positions',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })
    expect(calls).toBe(1)
    const diagnostic = logs.filter((entry) =>
      JSON.stringify(entry.message).includes('Broker positions response schema rejected'),
    )
    expect(diagnostic).toHaveLength(1)
    const expected = {
      'broker.decode_field': '[].qty',
      'broker.decode_issue': qty === null ? 'type' : 'constraint',
      'broker.decode_expected_type': 'string',
      'broker.decode_actual_type': qty === null ? 'null' : 'string',
    }
    expect(diagnostic[0]?.annotations).toMatchObject(expected)
    expect(JSON.stringify(diagnostic)).not.toContain('private-request-id')
    const attributes = spans.map((span) => Object.fromEntries(span.attributes))
    expect(attributes.some((value) => Object.entries(expected).every(([key, value_]) => value[key] === value_))).toBe(
      true,
    )
    const rendered = JSON.stringify({ logs, attributes })
    for (const value of privateValues) expect(rendered).not.toContain(value)
    expect(rendered).not.toContain(connection.expectedAccountId)
  },
)
