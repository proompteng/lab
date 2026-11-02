import { expect, test } from 'bun:test'
import { Cause, Effect, Exit, Logger, Option, Redacted, References, Result, Tracer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { alpacaSandboxBaseUrl, decodeBrokerConnection } from '../connection'
import { BrokerEnvironment, BrokerProvider } from '../identity'
import { BrokerReadErrorKind } from './failures'
import { make } from './http'

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
const position = {
  asset_id: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
  symbol: 'AAPL',
  exchange: 'NASDAQ',
  asset_class: 'us_equity',
  avg_entry_price: '100',
  cost_basis: '500',
  qty: '5',
  side: 'long',
  market_value: '600',
  unrealized_pl: '100',
  current_price: '120',
}
const warning = 'Broker positions response schema rejected'

const observe = async (
  operation: 'positions' | 'account-configuration',
  raw: unknown,
  status = 200,
  diagnosticFault?: 'logger' | 'span' | 'interrupt',
) => {
  const controller = new AbortController()
  let faultAttempts = 0
  const logs: Array<{ message: unknown; annotations: Readonly<Record<string, unknown>> }> = []
  const logger = Logger.make((entry) => {
    if (JSON.stringify(entry.message).includes(warning)) {
      if (diagnosticFault === 'logger') {
        faultAttempts += 1
        throw new Error('private-logger-defect')
      }
      if (diagnosticFault === 'interrupt') {
        faultAttempts += 1
        controller.abort()
      }
    }
    logs.push({ message: entry.message, annotations: entry.fiber.getRef(References.CurrentLogAnnotations) })
  })
  const spans: Tracer.Span[] = []
  const tracer = Tracer.make({
    span(options) {
      const span = Tracer.nativeTracer.span(options)
      const attribute = span.attribute.bind(span)
      span.attribute = (key, value) => {
        if (diagnosticFault === 'span' && key.startsWith('broker.decode_')) {
          faultAttempts += 1
          throw new Error('private-span-defect')
        }
        attribute(key, value)
      }
      spans.push(span)
      return span
    },
  })
  let calls = 0
  const client = HttpClient.make((request, url) => {
    calls += 1
    expect(request.method).toBe('GET')
    expect(url.pathname).toBe(operation === 'positions' ? '/v2/positions' : '/v2/account/configurations')
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(raw), {
          status,
          headers: { 'content-type': 'application/json', 'x-request-id': 'private-request-id' },
        }),
      ),
    )
  })
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(make(connection), (read) =>
      operation === 'positions' ? Effect.asVoid(read.positions) : Effect.asVoid(read.accountConfiguration),
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provide(Logger.layer([logger])),
    ),
    { signal: controller.signal },
  )
  const attributes = spans.map((span) => Object.fromEntries(span.attributes))
  const diagnostics = logs.filter((entry) => JSON.stringify(entry.message).includes(warning))
  const diagnosticSpans = attributes.filter((entry) =>
    Object.keys(entry).some((key) => key.startsWith('broker.decode_')),
  )
  return { exit, calls, logs, attributes, diagnostics, diagnosticSpans, faultAttempts }
}

test.each([null, 'private-position-value'])(
  'positions HTTP rejection emits only safe schema categories for %s',
  async (qty) => {
    const observed = await observe('positions', [
      ...Array.from({ length: 17 }, () => position),
      { ...position, qty, 'private-response-key': 'private-position-value' },
    ])
    const { exit, calls, diagnostics, diagnosticSpans, logs, attributes } = observed
    if (Exit.isSuccess(exit)) throw new Error('Expected synthetic schema rejection')
    expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
      operation: 'positions',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })
    expect(calls).toBe(1)
    expect(diagnostics).toHaveLength(1)
    expect(diagnosticSpans).toHaveLength(1)
    const expected = {
      'broker.decode_field': '[].qty',
      'broker.decode_issue': qty === null ? 'type' : 'constraint',
      'broker.decode_expected_type': 'string',
      'broker.decode_actual_type': qty === null ? 'null' : 'string',
    }
    expect(diagnostics[0]?.annotations).toMatchObject(expected)
    expect(diagnosticSpans[0]).toMatchObject(expected)
    const decodeKeys = (value: Readonly<Record<string, unknown>>) =>
      Object.keys(value)
        .filter((key) => key.startsWith('broker.decode_'))
        .sort()
    expect(decodeKeys(diagnostics[0]?.annotations ?? {})).toEqual(Object.keys(expected).sort())
    expect(decodeKeys(diagnosticSpans[0] ?? {})).toEqual(Object.keys(expected).sort())
    expect(JSON.stringify(diagnostics)).not.toContain('private-request-id')
    expect(JSON.stringify(diagnostics)).not.toContain('[17]')
    const rendered = JSON.stringify({ logs, attributes })
    for (const value of [
      'private-position-value',
      'private-key',
      'private-secret',
      'private-response-key',
      connection.expectedAccountId,
      position.asset_id,
      'SchemaError',
    ]) {
      expect(rendered).not.toContain(value)
    }
  },
)

test.each([
  { name: 'valid positions', operation: 'positions', raw: [position], success: true },
  { name: 'empty positions', operation: 'positions', raw: [], success: true },
  {
    name: 'valid other endpoint',
    operation: 'account-configuration',
    raw: { fractional_trading: true },
    success: true,
  },
  {
    name: 'invalid other endpoint',
    operation: 'account-configuration',
    raw: { fractional_trading: null },
    success: false,
  },
] as const)(
  '$name retains validation and emits no position rejection diagnostic',
  async ({ operation, raw, success }) => {
    const { exit, calls, diagnostics, diagnosticSpans } = await observe(operation, raw)
    expect(calls).toBe(1)
    expect(Exit.isSuccess(exit)).toBe(success)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
        operation,
        kind: BrokerReadErrorKind.InvalidResponse,
        retryable: false,
      })
    }
    expect(diagnostics).toEqual([])
    expect(diagnosticSpans).toEqual([])
  },
)

test('positions HTTP permission rejection is not relabeled as a schema failure', async () => {
  const { exit, calls, diagnostics, diagnosticSpans } = await observe(
    'positions',
    { code: 40310000, message: 'forbidden' },
    403,
  )
  if (Exit.isSuccess(exit)) throw new Error('Expected permission rejection')
  expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
    operation: 'positions',
    kind: BrokerReadErrorKind.Forbidden,
    retryable: false,
  })
  expect(calls).toBe(1)
  expect(diagnostics).toEqual([])
  expect(diagnosticSpans).toEqual([])
})

test.each(['logger', 'span'] as const)('a defective diagnostic %s cannot replace INVALID_RESPONSE', async (fault) => {
  const { exit, calls, faultAttempts, logs, attributes } = await observe(
    'positions',
    [{ ...position, qty: null }],
    200,
    fault,
  )
  if (Exit.isSuccess(exit)) throw new Error('Expected schema rejection')
  expect(faultAttempts).toBe(1)
  expect(calls).toBe(1)
  expect(Cause.hasDies(exit.cause)).toBe(false)
  expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
    operation: 'positions',
    kind: BrokerReadErrorKind.InvalidResponse,
    message: 'Alpaca positions response body does not match its schema',
    retryable: false,
    cause: { tag: 'SchemaError' },
  })
  expect(JSON.stringify({ logs, attributes })).not.toContain(`private-${fault}-defect`)
})

test('cancellation during diagnostic emission remains interruption', async () => {
  const { exit, calls, faultAttempts } = await observe('positions', [{ ...position, qty: null }], 200, 'interrupt')
  if (Exit.isSuccess(exit)) throw new Error('Expected interruption')
  expect(faultAttempts).toBe(1)
  expect(calls).toBe(1)
  expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(Cause.findErrorOption(exit.cause)).toEqual(Option.none())
})
