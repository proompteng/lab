import { describe, expect, test } from 'bun:test'

import { Undici } from '@effect/platform-node'
import { Effect, Fiber, Layer, Redacted } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http'

import { canonicalHashV1 } from '../hash'
import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  AssetStatus,
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  OrderCollection,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSide,
  SortDirection,
  TradeActivityType,
  layer,
  make,
  makeProxyDispatcher,
  readPreflightTimeoutMs,
  verifyReadAccess,
  type BrokerReadShape,
  type ReadOptions,
} from './alpaca'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const assetId = 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415'
const orderId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const clientOrderId = 'bayn-test-order-1'

const options: ReadOptions = {
  expectedAccountId: accountId,
  key: Redacted.make('paper-key'),
  secret: Redacted.make('paper-secret'),
  proxyUrl: 'http://bayn-egress-proxy:3128',
  operationTimeoutMs: 1_000,
  retryAttempts: 2,
}

const accountResponse = {
  id: accountId,
  account_number: '010203ABCD',
  status: 'ACTIVE',
  currency: 'USD',
  cash: '-23140.2',
  equity: '103820.56',
  buying_power: '262113.632',
  account_blocked: false,
  trading_blocked: false,
  trade_suspended_by_user: false,
  options_buying_power: '0',
}

const accountConfigurationResponse = {
  fractional_trading: true,
  no_shorting: true,
  suspend_trade: false,
}

const positionResponse = {
  asset_id: assetId,
  symbol: 'AAPL',
  exchange: 'NASDAQ',
  asset_class: 'us_equity',
  avg_entry_price: '100.0',
  qty: '5',
  side: 'long',
  market_value: '600.0',
  unrealized_pl: '100.0',
  current_price: '120.0',
  cost_basis: '500.0',
}

const assetResponse = {
  id: assetId,
  class: 'us_equity',
  exchange: 'NASDAQ',
  symbol: 'AAPL',
  status: 'active',
  tradable: true,
  fractionable: true,
  attributes: ['has_options'],
  name: 'Apple Inc.',
}

const orderResponse = {
  id: orderId,
  client_order_id: clientOrderId,
  created_at: '2021-03-16T18:38:01.942282Z',
  updated_at: '2021-03-16T18:38:01.942282Z',
  submitted_at: '2021-03-16T18:38:01.937734Z',
  filled_at: null,
  expired_at: null,
  canceled_at: null,
  failed_at: null,
  replaced_at: null,
  replaced_by: null,
  replaces: null,
  asset_id: assetId,
  symbol: 'AAPL',
  asset_class: 'us_equity',
  notional: null,
  qty: '5',
  filled_qty: '0',
  filled_avg_price: null,
  order_class: '',
  order_type: 'market',
  type: 'market',
  side: 'buy',
  time_in_force: 'day',
  limit_price: null,
  stop_price: null,
  status: 'accepted',
  extended_hours: false,
  legs: null,
  trail_percent: null,
  trail_price: null,
  hwm: null,
  source: 'api',
}

const fillResponse = {
  activity_type: 'FILL',
  id: `20260721113406977::${orderId}`,
  account_id: accountId,
  cum_qty: '5',
  leaves_qty: '0',
  price: '120.125',
  qty: '5',
  side: 'buy',
  symbol: 'AAPL',
  transaction_time: '2026-07-21T15:34:06.977123Z',
  order_id: orderId,
  type: 'fill',
  order_status: 'filled',
}

const responseHeaders = {
  'content-type': 'application/json',
  'x-request-id': 'req-123',
  'x-ratelimit-limit': '200',
  'x-ratelimit-remaining': '199',
  'x-ratelimit-reset': '1784664000',
}

const jsonResponse = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  body: unknown,
  status = 200,
  headers: Record<string, string> = responseHeaders,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers,
    }),
  )

const withClient = <A, E>(
  client: HttpClient.HttpClient,
  use: (read: BrokerReadShape) => Effect.Effect<A, E>,
  readOptions: ReadOptions = options,
): Effect.Effect<A, BrokerReadError | E> =>
  make(readOptions).pipe(Effect.flatMap(use), Effect.provideService(HttpClient.HttpClient, client))

describe('Alpaca paper reads', () => {
  test('reads and runtime-decodes the configured paper account without leaking credentials', async () => {
    let method = ''
    let url = ''
    let key = ''
    let secret = ''
    let inspected = ''
    let surface: readonly string[] = []
    const client = HttpClient.make((request, target) =>
      Effect.sync(() => {
        method = request.method
        url = target.toString()
        key = request.headers['apca-api-key-id'] ?? ''
        secret = request.headers['apca-api-secret-key'] ?? ''
        inspected = JSON.stringify(request)
        return jsonResponse(request, accountResponse)
      }),
    )

    const result = await Effect.runPromise(
      withClient(client, (read) => {
        surface = Object.keys(read).sort()
        return read.account
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(method).toBe('GET')
    expect(url).toBe('https://paper-api.alpaca.markets/v2/account')
    expect(key).toBe('paper-key')
    expect(secret).toBe('paper-secret')
    expect(inspected).not.toContain('paper-key')
    expect(inspected).not.toContain('paper-secret')
    expect(surface).toEqual([
      'account',
      'accountConfiguration',
      'assetBySymbol',
      'fillActivities',
      'marketCalendar',
      'orderByClientId',
      'orderById',
      'orders',
      'positions',
    ])
    expect(result.value).toMatchObject({
      id: accountId,
      status: AccountStatus.Active,
      cashMicros: '-23140200000',
      equityMicros: '103820560000',
      buyingPowerMicros: '262113632000',
      observedAt: '1970-01-01T00:00:00.000Z',
    })
    expect(result.evidence).toEqual({
      requestId: 'req-123',
      status: 200,
      contentHash: canonicalHashV1(accountResponse),
      observedAt: '1970-01-01T00:00:00.000Z',
      rateLimit: {
        limit: '200',
        remaining: '199',
        reset: '1784664000',
        retryAfter: undefined,
      },
    })
  })

  test('reads and hashes the current fractional-trading account configuration with GET only', async () => {
    const requests: Array<{ method: string; url: URL; key: string; secret: string }> = []
    let releaseBody: (() => void) | undefined
    const client = HttpClient.make((request, url) => {
      requests.push({
        method: request.method,
        url,
        key: request.headers['apca-api-key-id'] ?? '',
        secret: request.headers['apca-api-secret-key'] ?? '',
      })
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseBody = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(accountConfigurationResponse)))
            controller.close()
          }
        },
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status: 200,
            headers: responseHeaders,
          }),
        ),
      )
    })

    const program = withClient(
      client,
      (read) =>
        Effect.gen(function* () {
          const fiber = yield* read.accountConfiguration.pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(1_000)
          releaseBody?.()
          return yield* Fiber.join(fiber)
        }),
      { ...options, operationTimeoutMs: 5_000 },
    ).pipe(Effect.provide(TestClock.layer()))
    const result = await Effect.runPromise(program)

    expect(requests).toEqual([
      {
        method: 'GET',
        url: new URL('https://paper-api.alpaca.markets/v2/account/configurations'),
        key: 'paper-key',
        secret: 'paper-secret',
      },
    ])
    const requestHash = canonicalHashV1({
      schemaVersion: 'bayn.alpaca-account-configuration-observation.v1',
      source: 'alpaca-v2-account-configurations',
      method: 'GET',
      path: '/v2/account/configurations',
    })
    const normalized = {
      schemaVersion: 'bayn.alpaca-account-configuration-observation.v1',
      source: 'alpaca-v2-account-configurations',
      requestHash,
      fractionalTrading: true,
    } as const
    expect(result.value).toEqual({
      ...normalized,
      observedAt: '1970-01-01T00:00:01.000Z',
      normalizedResponseHash: canonicalHashV1(normalized),
    })
    expect(result.evidence).toMatchObject({
      requestId: 'req-123',
      status: 200,
      contentHash: canonicalHashV1(accountConfigurationResponse),
      observedAt: '1970-01-01T00:00:01.000Z',
    })
    expect(requests.some(({ method }) => method === 'PATCH' || method === 'POST' || method === 'DELETE')).toBe(false)
  })

  test('rejects a malformed fractional-trading account configuration with typed response evidence', async () => {
    const response = { ...accountConfigurationResponse, fractional_trading: 'true' }
    const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, response)))

    const failure = await Effect.runPromise(
      Effect.flip(withClient(client, (read) => read.accountConfiguration)).pipe(Effect.provide(TestClock.layer())),
    )

    expect(failure).toMatchObject({
      operation: 'account-configuration',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
      status: 200,
      requestId: 'req-123',
      contentHash: canonicalHashV1(response),
      observedAt: '1970-01-01T00:00:00.000Z',
    })
  })

  test('reads exact asset evidence with GET-only auth and samples time after the complete body', async () => {
    const requestedSymbol = 'BRK.B'
    const response = {
      ...assetResponse,
      symbol: requestedSymbol,
      status: 'inactive',
      tradable: false,
      fractionable: false,
      attributes: ['ipo'],
    }
    const requests: Array<{ method: string; url: URL; key: string; secret: string }> = []
    let releaseBody: (() => void) | undefined
    const client = HttpClient.make((request, url) => {
      requests.push({
        method: request.method,
        url,
        key: request.headers['apca-api-key-id'] ?? '',
        secret: request.headers['apca-api-secret-key'] ?? '',
      })
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseBody = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(response)))
            controller.close()
          }
        },
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status: 200,
            headers: responseHeaders,
          }),
        ),
      )
    })

    const program = withClient(
      client,
      (read) =>
        Effect.gen(function* () {
          const fiber = yield* read.assetBySymbol(requestedSymbol).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(2_000)
          releaseBody?.()
          return yield* Fiber.join(fiber)
        }),
      { ...options, operationTimeoutMs: 5_000 },
    ).pipe(Effect.provide(TestClock.layer()))
    const result = await Effect.runPromise(program)

    expect(requests).toEqual([
      {
        method: 'GET',
        url: new URL(`https://paper-api.alpaca.markets/v2/assets/${encodeURIComponent(requestedSymbol)}`),
        key: 'paper-key',
        secret: 'paper-secret',
      },
    ])
    const requestHash = canonicalHashV1({
      schemaVersion: 'bayn.alpaca-asset-observation.v1',
      source: 'alpaca-v2-asset',
      method: 'GET',
      path: `/v2/assets/${encodeURIComponent(requestedSymbol)}`,
      requestedSymbol,
    })
    const normalized = {
      schemaVersion: 'bayn.alpaca-asset-observation.v1',
      source: 'alpaca-v2-asset',
      requestedSymbol,
      requestHash,
      assetId,
      symbol: requestedSymbol,
      assetClass: AssetClass.UsEquity,
      exchange: AssetExchange.Nasdaq,
      status: AssetStatus.Inactive,
      tradable: false,
      fractionable: false,
      attributes: ['ipo'],
    } as const
    expect(result.value).toEqual({
      ...normalized,
      observedAt: '1970-01-01T00:00:02.000Z',
      normalizedResponseHash: canonicalHashV1(normalized),
    })
    expect(result.evidence).toMatchObject({
      requestId: 'req-123',
      status: 200,
      contentHash: canonicalHashV1(response),
      observedAt: '1970-01-01T00:00:02.000Z',
    })
    expect(requests.some(({ method }) => method === 'POST' || method === 'DELETE')).toBe(false)
  })

  test('canonicalizes asset attributes into deterministic sorted-unique response evidence', async () => {
    let response: unknown = { ...assetResponse, attributes: ['ipo', 'has_options', 'ipo'] }
    const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, response)))

    const first = await Effect.runPromise(
      withClient(client, (read) => read.assetBySymbol('AAPL')).pipe(Effect.provide(TestClock.layer())),
    )
    response = { ...assetResponse, attributes: ['has_options', 'ipo'] }
    const second = await Effect.runPromise(
      withClient(client, (read) => read.assetBySymbol('AAPL')).pipe(Effect.provide(TestClock.layer())),
    )

    expect(first.value.attributes).toEqual(['has_options', 'ipo'])
    expect(first.value.requestHash).toBe(second.value.requestHash)
    expect(first.value.normalizedResponseHash).toBe(second.value.normalizedResponseHash)
    expect(first.evidence.contentHash).not.toBe(second.evidence.contentHash)
  })

  test('normalizes absent or null asset attributes to immutable empty evidence', async () => {
    const { attributes: _attributes, ...withoutAttributes } = assetResponse
    let response: unknown = withoutAttributes
    const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, response)))

    const absent = await Effect.runPromise(withClient(client, (read) => read.assetBySymbol('AAPL')))
    response = { ...assetResponse, attributes: null }
    const nullAttributes = await Effect.runPromise(withClient(client, (read) => read.assetBySymbol('AAPL')))

    expect(absent.value.attributes).toEqual([])
    expect(nullAttributes.value.attributes).toEqual([])
    expect(absent.value.normalizedResponseHash).toBe(nullAttributes.value.normalizedResponseHash)
  })

  test('fails typed with post-response evidence for malformed or mismatched assets', async () => {
    let calls = 0
    let response: unknown = { ...assetResponse, fractionable: 'false' }
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(jsonResponse(request, response))
    })
    const readFailure = (symbol: string) =>
      Effect.flip(withClient(client, (read) => read.assetBySymbol(symbol))).pipe(Effect.provide(TestClock.layer()))

    const malformed = await Effect.runPromise(readFailure('AAPL'))
    expect(malformed).toMatchObject({
      operation: 'asset-by-symbol',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
      status: 200,
      requestId: 'req-123',
      contentHash: canonicalHashV1(response),
      observedAt: '1970-01-01T00:00:00.000Z',
    })

    response = { ...assetResponse, symbol: 'MSFT' }
    const mismatch = await Effect.runPromise(readFailure('AAPL'))
    expect(mismatch).toMatchObject({
      operation: 'asset-by-symbol',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
      status: 200,
      requestId: 'req-123',
      contentHash: canonicalHashV1(response),
      observedAt: '1970-01-01T00:00:00.000Z',
      cause: {
        message: 'asset lookup returned symbol MSFT, expected AAPL',
      },
    })

    const callsBeforeInvalidSymbol = calls
    const invalidSymbol = await Effect.runPromise(readFailure('../AAPL'))
    expect(invalidSymbol).toMatchObject({
      operation: 'asset-by-symbol',
      kind: BrokerReadErrorKind.InvalidRequest,
      retryable: false,
    })
    expect(calls).toBe(callsBeforeInvalidSymbol)

    response = { ...assetResponse, exchange: '' }
    const emptyExchange = await Effect.runPromise(readFailure('AAPL'))
    expect(emptyExchange).toMatchObject({
      operation: 'asset-by-symbol',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
      contentHash: canonicalHashV1(response),
      observedAt: '1970-01-01T00:00:00.000Z',
    })
  })

  test('uses the bounded transient GET retry policy for exact asset reads', async () => {
    const methods: string[] = []
    let calls = 0
    const client = HttpClient.make((request) => {
      methods.push(request.method)
      calls += 1
      return Effect.succeed(
        calls === 1
          ? jsonResponse(request, { code: 50010000, message: 'temporary failure' }, 500)
          : jsonResponse(request, assetResponse),
      )
    })

    const result = await Effect.runPromise(
      withClient(client, (read) => read.assetBySymbol('AAPL'), { ...options, retryAttempts: 1 }),
    )

    expect(result.value.symbol).toBe('AAPL')
    expect(calls).toBe(2)
    expect(methods).toEqual(['GET', 'GET'])
  })

  test('reads one bounded market calendar range and returns deterministic UTC observation evidence', async () => {
    let method = ''
    let requestedUrl: URL | undefined
    const response = [
      { date: '2026-03-09', open: '09:30', close: '16:00', session_open: '0400', session_close: '2000' },
      { date: '2026-03-06', open: '09:30', close: '16:00', session_open: '0400', session_close: '2000' },
    ]
    const client = HttpClient.make((request, url) => {
      method = request.method
      requestedUrl = url
      return Effect.succeed(jsonResponse(request, response))
    })

    const result = await Effect.runPromise(
      withClient(client, (read) => read.marketCalendar({ start: '2026-03-06', end: '2026-03-10' })),
    )

    expect(method).toBe('GET')
    expect(requestedUrl?.pathname).toBe('/v2/calendar')
    expect(requestedUrl?.searchParams.toString()).toBe('start=2026-03-06&end=2026-03-10&date_type=TRADING')
    const normalized = {
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      requestedRange: { start: '2026-03-06', end: '2026-03-10' },
      timeZone: 'UTC',
      sessions: [
        {
          date: '2026-03-06',
          openAt: '2026-03-06T14:30:00.000Z',
          closeAt: '2026-03-06T21:00:00.000Z',
        },
        {
          date: '2026-03-09',
          openAt: '2026-03-09T13:30:00.000Z',
          closeAt: '2026-03-09T20:00:00.000Z',
        },
      ],
    } as const
    expect(result.value).toEqual({
      ...normalized,
      normalizedResponseHash: canonicalHashV1(normalized),
    })
    expect(result.evidence).toMatchObject({
      requestId: 'req-123',
      status: 200,
      contentHash: canonicalHashV1(response),
    })
  })

  test('rejects reversed or overlong market calendar ranges before broker I/O', async () => {
    let calls = 0
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(jsonResponse(request, []))
    })

    const reversed = await Effect.runPromise(
      Effect.flip(withClient(client, (read) => read.marketCalendar({ start: '2026-03-10', end: '2026-03-09' }))),
    )
    expect(reversed).toMatchObject({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.InvalidRequest,
      retryable: false,
    })

    const overlong = await Effect.runPromise(
      Effect.flip(withClient(client, (read) => read.marketCalendar({ start: '2026-01-01', end: '2026-02-01' }))),
    )
    expect(overlong).toMatchObject({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.InvalidRequest,
      retryable: false,
    })
    expect(calls).toBe(0)
  })

  test('fails closed on malformed, duplicate, or out-of-range market calendar rows', async () => {
    let response: unknown = [{ date: '2026-03-09', open: '9:30', close: '16:00' }]
    const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, response)))
    const query = { start: '2026-03-06', end: '2026-03-10' }

    const malformed = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.marketCalendar(query))))
    expect(malformed).toMatchObject({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })

    response = [
      { date: '2026-03-09', open: '09:30', close: '16:00' },
      { date: '2026-03-09', open: '09:30', close: '16:00' },
    ]
    const duplicate = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.marketCalendar(query))))
    expect(duplicate).toMatchObject({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })

    response = [{ date: '2026-03-11', open: '09:30', close: '16:00' }]
    const outsideRange = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.marketCalendar(query))))
    expect(outsideRange).toMatchObject({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })
  })

  test('preflights the startup GET-only surface without persisting or inventing an order', async () => {
    const requests: Array<{ method: string; url: URL }> = []
    const client = HttpClient.make((request, url) => {
      requests.push({ method: request.method, url })
      if (url.pathname === '/v2/account') return Effect.succeed(jsonResponse(request, accountResponse))
      if (url.pathname === '/v2/positions') return Effect.succeed(jsonResponse(request, []))
      if (
        url.pathname === '/v2/orders' ||
        url.pathname === '/v2/account/activities/FILL' ||
        url.pathname === '/v2/calendar'
      ) {
        return Effect.succeed(jsonResponse(request, []))
      }
      return Effect.succeed(jsonResponse(request, { code: 40410000, message: 'order not found' }, 404))
    })

    const proof = await Effect.runPromise(withClient(client, verifyReadAccess).pipe(Effect.provide(TestClock.layer())))

    expect(proof).toMatchObject({
      accountId,
      positionCount: 0,
      openOrderCount: 0,
      recentOrderCount: 0,
      fillCount: 0,
      marketCalendarSessionCount: 0,
      orderById: 'NOT_FOUND',
      orderByClientId: 'NOT_FOUND',
    })
    expect(proof.accountHash).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.positionsHash).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.ordersHash).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.fillsHash).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.marketCalendarHash).toMatch(/^[a-f0-9]{64}$/)
    expect(requests).toHaveLength(8)
    expect(requests.every(({ method }) => method === 'GET')).toBe(true)
    expect(
      requests
        .filter(({ url }) => url.pathname === '/v2/orders')
        .map(({ url }) => url.searchParams.get('status'))
        .sort((left, right) => (left ?? '').localeCompare(right ?? '')),
    ).toEqual(['all', 'open'])
    expect(requests.some(({ url }) => url.pathname === `/v2/orders/00000000-0000-4000-8000-000000000000`)).toBe(true)
    expect(requests.some(({ url }) => url.pathname === '/v2/orders:by_client_order_id')).toBe(true)
    const fill = requests.find(({ url }) => url.pathname === '/v2/account/activities/FILL')
    expect(fill?.url.searchParams.get('page_size')).toBe('1')
    expect(fill?.url.searchParams.get('direction')).toBe('desc')
    const calendar = requests.find(({ url }) => url.pathname === '/v2/calendar')
    expect(calendar?.url.searchParams.toString()).toBe('start=1970-01-01&end=1970-01-14&date_type=TRADING')
  })

  test('preflights ordinary non-empty orders whose optional Alpaca fields are null', async () => {
    const client = HttpClient.make((request, url) => {
      if (url.pathname === '/v2/account') return Effect.succeed(jsonResponse(request, accountResponse))
      if (
        url.pathname === '/v2/positions' ||
        url.pathname === '/v2/account/activities/FILL' ||
        url.pathname === '/v2/calendar'
      ) {
        return Effect.succeed(jsonResponse(request, []))
      }
      return Effect.succeed(jsonResponse(request, url.pathname === '/v2/orders' ? [orderResponse] : orderResponse))
    })

    const proof = await Effect.runPromise(withClient(client, verifyReadAccess))

    expect(proof).toMatchObject({
      accountId,
      openOrderCount: 1,
      recentOrderCount: 1,
      orderById: 'MATCHED',
      orderByClientId: 'MATCHED',
    })
    expect(proof.ordersHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('fails the complete startup preflight when the market calendar payload is invalid', async () => {
    const client = HttpClient.make((request, url) => {
      if (url.pathname === '/v2/account') return Effect.succeed(jsonResponse(request, accountResponse))
      if (url.pathname === '/v2/calendar') {
        return Effect.succeed(jsonResponse(request, [{ date: '2026-07-23', open: '9:30', close: '16:00' }]))
      }
      return Effect.succeed(jsonResponse(request, []))
    })

    const failure = await Effect.runPromise(Effect.flip(withClient(client, verifyReadAccess)))

    expect(failure).toMatchObject({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })
  })

  test('bounds the complete startup preflight below the Kubernetes startup-probe budget', async () => {
    let interrupted = 0
    const client = HttpClient.make((request, url) => {
      if (url.pathname === '/v2/account') return Effect.succeed(jsonResponse(request, accountResponse))
      return Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted += 1
          }),
        ),
      )
    })

    const program = withClient(
      client,
      (read) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.flip(verifyReadAccess(read)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(readPreflightTimeoutMs)
          return yield* Fiber.join(fiber)
        }),
      { ...options, operationTimeoutMs: 120_000, retryAttempts: 0 },
    ).pipe(Effect.provide(TestClock.layer()))

    const failure = await Effect.runPromise(program)
    expect(failure).toMatchObject({
      kind: BrokerReadErrorKind.Timeout,
      operation: 'preflight',
      retryable: true,
    })
    expect(interrupted).toBeGreaterThan(0)
  })

  test('normalizes equity positions exactly and rejects precision loss', async () => {
    let response: unknown = [positionResponse]
    const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, response)))

    const result = await Effect.runPromise(withClient(client, (read) => read.positions))
    expect(result.value).toEqual([
      {
        accountId,
        assetId,
        symbol: 'AAPL',
        exchange: AssetExchange.Nasdaq,
        assetClass: AssetClass.UsEquity,
        side: PositionSide.Long,
        quantityMicros: '5000000',
        averageEntryPriceMicros: '100000000',
        marketPriceMicros: '120000000',
        marketValueMicros: '600000000',
        unrealizedPnlMicros: '100000000',
        observedAt: expect.any(String),
      },
    ])

    response = [{ ...positionResponse, side: 'short', qty: '5', market_value: '600.0', unrealized_pl: '-100.0' }]
    const short = await Effect.runPromise(withClient(client, (read) => read.positions))
    expect(short.value).toEqual([
      expect.objectContaining({
        side: PositionSide.Short,
        quantityMicros: '-5000000',
        marketValueMicros: '-600000000',
        unrealizedPnlMicros: '-100000000',
      }),
    ])

    response = [{ ...positionResponse, qty: '0.079145874' }]
    const failure = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.positions)))
    expect(failure).toMatchObject({
      _tag: 'BrokerReadError',
      operation: 'positions',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })
    expect(failure.message).toContain('violates the Bayn read contract')

    response = [{ ...positionResponse, side: 'long', qty: '-170141183460469231731687303715884.105728' }]
    const normalizedOverflow = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.positions)))
    expect(normalizedOverflow).toMatchObject({
      _tag: 'BrokerReadError',
      operation: 'positions',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })
  })

  test('reads order collections and deterministic order lookups with GET only', async () => {
    const requests: Array<{ method: string; url: URL }> = []
    const client = HttpClient.make((request, url) => {
      requests.push({ method: request.method, url })
      return Effect.succeed(jsonResponse(request, url.pathname === '/v2/orders' ? [orderResponse] : orderResponse))
    })

    const result = await Effect.runPromise(
      withClient(client, (read) =>
        Effect.all([
          read.orders({
            status: OrderCollection.All,
            limit: 25,
            direction: SortDirection.Ascending,
            side: OrderSide.Buy,
            symbols: ['AAPL'],
          }),
          read.orderById(orderId),
          read.orderByClientId(clientOrderId),
        ]),
      ),
    )

    expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET'])
    expect(requests[0].url.pathname).toBe('/v2/orders')
    expect(requests[0].url.searchParams.get('status')).toBe('all')
    expect(requests[0].url.searchParams.get('limit')).toBe('25')
    expect(requests[0].url.searchParams.get('direction')).toBe('asc')
    expect(requests[0].url.searchParams.get('side')).toBe('buy')
    expect(requests[0].url.searchParams.get('symbols')).toBe('AAPL')
    expect(requests[1].url.pathname).toBe(`/v2/orders/${orderId}`)
    expect(requests[2].url.pathname).toBe('/v2/orders:by_client_order_id')
    expect(requests[2].url.searchParams.get('client_order_id')).toBe(clientOrderId)

    for (const read of result) {
      const order = Array.isArray(read.value) ? read.value[0] : read.value
      expect(order).toMatchObject({
        accountId,
        brokerOrderId: orderId,
        clientOrderId,
        orderType: OrderType.Market,
        side: OrderSide.Buy,
        status: OrderStatus.Accepted,
        quantityMicros: '5000000',
        filledQuantityMicros: '0',
        createdAt: '2021-03-16T18:38:01.942282Z',
      })
    }
  })

  test('uses canonical order type when the deprecated alias is absent across every order read', async () => {
    const { order_type: _orderType, ...responseWithoutAlias } = orderResponse
    const client = HttpClient.make((request, url) =>
      Effect.succeed(
        jsonResponse(request, url.pathname === '/v2/orders' ? [responseWithoutAlias] : responseWithoutAlias),
      ),
    )

    const reads = await Effect.runPromise(
      withClient(client, (read) =>
        Effect.all([read.orders(), read.orderById(orderId), read.orderByClientId(clientOrderId)]),
      ),
    )

    for (const read of reads) {
      const order = Array.isArray(read.value) ? read.value[0] : read.value
      expect(order?.orderType).toBe(OrderType.Market)
    }
  })

  test('rejects a present deprecated order type alias that disagrees with canonical type', async () => {
    const response = { ...orderResponse, order_type: 'limit' }
    const client = HttpClient.make((request, url) =>
      Effect.succeed(jsonResponse(request, url.pathname === '/v2/orders' ? [response] : response)),
    )

    const failures = await Effect.runPromise(
      withClient(client, (read) =>
        Effect.all([
          Effect.flip(read.orders()),
          Effect.flip(read.orderById(orderId)),
          Effect.flip(read.orderByClientId(clientOrderId)),
        ]),
      ),
    )

    expect(failures).toMatchObject([
      { operation: 'orders', kind: BrokerReadErrorKind.InvalidResponse, retryable: false },
      { operation: 'order-by-id', kind: BrokerReadErrorKind.InvalidResponse, retryable: false },
      { operation: 'order-by-client-id', kind: BrokerReadErrorKind.InvalidResponse, retryable: false },
    ])
  })

  test('validates every non-market order shape from canonical type when the deprecated alias is absent', async () => {
    const malformed = [
      { label: 'limit', response: { ...orderResponse, type: 'limit', limit_price: null } },
      { label: 'stop', response: { ...orderResponse, type: 'stop', stop_price: null } },
      {
        label: 'stop-limit',
        response: { ...orderResponse, type: 'stop_limit', limit_price: null, stop_price: null },
      },
      {
        label: 'trailing-stop',
        response: { ...orderResponse, type: 'trailing_stop', trail_percent: null, trail_price: null },
      },
    ] as const

    for (const { label, response } of malformed) {
      const { order_type: _orderType, ...responseWithoutAlias } = response
      const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, responseWithoutAlias)))

      const failure = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.orderById(orderId))))

      expect(failure, label).toMatchObject({
        operation: 'order-by-id',
        kind: BrokerReadErrorKind.InvalidResponse,
        retryable: false,
      })
    }
  })

  test('retains causal read evidence when pending order timestamps are null or absent', async () => {
    const { updated_at: _updatedAt, submitted_at: _submittedAt, ...responseWithoutPendingTimestamps } = orderResponse
    const client = HttpClient.make((request, url) => {
      if (url.pathname === '/v2/orders') {
        return Effect.succeed(jsonResponse(request, [{ ...orderResponse, updated_at: null, submitted_at: null }]))
      }
      if (url.pathname === `/v2/orders/${orderId}`) {
        return Effect.succeed(jsonResponse(request, responseWithoutPendingTimestamps))
      }
      return Effect.succeed(jsonResponse(request, { ...responseWithoutPendingTimestamps, updated_at: null }))
    })

    const reads = await Effect.runPromise(
      withClient(client, (read) =>
        Effect.all([read.orders(), read.orderById(orderId), read.orderByClientId(clientOrderId)]),
      ),
    )

    for (const read of reads) {
      const order = Array.isArray(read.value) ? read.value[0] : read.value
      expect(order).toMatchObject({
        createdAt: orderResponse.created_at,
        observedAt: read.evidence.observedAt,
      })
      expect(order?.updatedAt).toBeUndefined()
      expect(order?.submittedAt).toBeUndefined()
      expect(read.evidence.observedAt).toMatch(/Z$/)
    }
  })

  test('accepts external client order IDs through 128 characters and rejects longer values', async () => {
    let calls = 0
    let responseClientOrderId = 'e'.repeat(49)
    let requestedClientOrderId = ''
    const client = HttpClient.make((request, url) => {
      calls += 1
      requestedClientOrderId = url.searchParams.get('client_order_id') ?? ''
      const body =
        url.pathname === '/v2/orders'
          ? [{ ...orderResponse, client_order_id: responseClientOrderId }]
          : { ...orderResponse, client_order_id: responseClientOrderId }
      return Effect.succeed(jsonResponse(request, body))
    })

    const external49 = await Effect.runPromise(withClient(client, (read) => read.orders()))
    expect(external49.value[0]?.clientOrderId).toBe('e'.repeat(49))

    responseClientOrderId = 'f'.repeat(128)
    const external128 = await Effect.runPromise(
      withClient(client, (read) => Effect.all([read.orderById(orderId), read.orderByClientId(responseClientOrderId)])),
    )
    expect(external128.map((read) => read.value.clientOrderId)).toEqual([responseClientOrderId, responseClientOrderId])
    expect(requestedClientOrderId).toBe(responseClientOrderId)

    responseClientOrderId = 'g'.repeat(129)
    const responseFailures = await Effect.runPromise(
      withClient(client, (read) => Effect.all([Effect.flip(read.orders()), Effect.flip(read.orderById(orderId))])),
    )
    expect(responseFailures).toMatchObject([
      { operation: 'orders', kind: BrokerReadErrorKind.InvalidResponse, retryable: false },
      { operation: 'order-by-id', kind: BrokerReadErrorKind.InvalidResponse, retryable: false },
    ])

    const callsBeforeInvalidLookup = calls
    const lookupFailure = await Effect.runPromise(
      Effect.flip(withClient(client, (read) => read.orderByClientId('h'.repeat(129)))),
    )
    expect(lookupFailure).toMatchObject({
      operation: 'order-by-client-id',
      kind: BrokerReadErrorKind.InvalidRequest,
      retryable: false,
    })
    expect(calls).toBe(callsBeforeInvalidLookup)
  })

  test('reads a bounded fill page and derives the documented page token', async () => {
    let requestedUrl: URL | undefined
    const client = HttpClient.make((request, url) => {
      requestedUrl = url
      return Effect.succeed(jsonResponse(request, [fillResponse]))
    })

    const result = await Effect.runPromise(
      withClient(client, (read) =>
        read.fillActivities({
          pageSize: 1,
          direction: SortDirection.Descending,
          pageToken: `20260720113406977::${orderId}`,
        }),
      ),
    )

    expect(requestedUrl?.pathname).toBe('/v2/account/activities/FILL')
    expect(requestedUrl?.searchParams.get('page_size')).toBe('1')
    expect(requestedUrl?.searchParams.get('page_token')).toBe(`20260720113406977::${orderId}`)
    expect(result.value).toEqual({
      items: [
        {
          accountId,
          activityId: fillResponse.id,
          cumulativeQuantityMicros: '5000000',
          leavesQuantityMicros: '0',
          priceMicros: '120125000',
          quantityMicros: '5000000',
          side: OrderSide.Buy,
          symbol: 'AAPL',
          transactionTime: '2026-07-21T15:34:06.977123Z',
          brokerOrderId: orderId,
          type: TradeActivityType.Fill,
          orderStatus: OrderStatus.Filled,
        },
      ],
      nextPageToken: fillResponse.id,
    })
  })

  test('requests the default fill page size explicitly and returns a cursor for a full page', async () => {
    let requestedUrl: URL | undefined
    const page = Array.from({ length: 100 }, (_, index) => ({
      ...fillResponse,
      id: `fill-${String(index).padStart(3, '0')}::${orderId}`,
    }))
    const client = HttpClient.make((request, url) => {
      requestedUrl = url
      return Effect.succeed(jsonResponse(request, page))
    })

    const result = await Effect.runPromise(withClient(client, (read) => read.fillActivities()))

    expect(requestedUrl?.searchParams.get('page_size')).toBe('100')
    expect(result.value.items).toHaveLength(100)
    expect(result.value.nextPageToken).toBe(page[99].id)
  })

  test('fails closed on unknown vocabularies, malformed numbers, and invalid query combinations', async () => {
    let calls = 0
    let body: unknown = { ...accountResponse, status: 'SURPRISE_STATUS' }
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(jsonResponse(request, body))
    })

    const unknownStatus = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.account)))
    expect(unknownStatus).toMatchObject({ kind: BrokerReadErrorKind.InvalidResponse })

    body = { ...accountResponse, cash: '1e9' }
    const malformedNumber = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.account)))
    expect(malformedNumber).toMatchObject({ kind: BrokerReadErrorKind.InvalidResponse })
    expect(malformedNumber.cause).toMatchObject({
      tag: 'SchemaError',
      message: expect.stringContaining('["cash"]'),
    })

    const callsBeforeInvalidQuery = calls
    const invalidQuery = await Effect.runPromise(
      Effect.flip(
        withClient(client, (read) =>
          read.fillActivities({
            date: '2026-07-21',
            after: '2026-07-20T00:00:00Z',
          }),
        ),
      ),
    )
    expect(invalidQuery).toMatchObject({ kind: BrokerReadErrorKind.InvalidRequest })
    expect(calls).toBe(callsBeforeInvalidQuery)
  })

  test('retries transient GET failures only within the configured bound', async () => {
    let calls = 0
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(
        calls < 3
          ? jsonResponse(request, { code: 50010000, message: 'temporary failure' }, 500)
          : jsonResponse(request, accountResponse),
      )
    })

    const result = await Effect.runPromise(withClient(client, (read) => read.account))
    expect(result.value.id).toBe(accountId)
    expect(calls).toBe(3)

    calls = 0
    const denied = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(jsonResponse(request, { code: 40110000, message: 'not authorized' }, 401))
    })
    const failure = await Effect.runPromise(Effect.flip(withClient(denied, (read) => read.account)))
    expect(failure).toMatchObject({
      kind: BrokerReadErrorKind.Authentication,
      status: 401,
      requestId: 'req-123',
      retryable: false,
    })
    expect(calls).toBe(1)

    calls = 0
    const rateLimited = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(jsonResponse(request, { code: 42910000, message: 'slow down' }, 429))
    })
    const rateFailure = await Effect.runPromise(
      Effect.flip(withClient(rateLimited, (read) => read.account, { ...options, retryAttempts: 1 })),
    )
    expect(rateFailure).toMatchObject({
      kind: BrokerReadErrorKind.RateLimited,
      status: 429,
      requestId: 'req-123',
      retryable: true,
      contentHash: canonicalHashV1({ code: 42910000, message: 'slow down' }),
    })
    expect(calls).toBe(2)
  })

  test('interrupts the underlying request when the Effect deadline expires', async () => {
    let interrupted = false
    const client = HttpClient.make(() =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      ),
    )

    const program = withClient(
      client,
      (read) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.flip(read.account).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(10)
          return yield* Fiber.join(fiber)
        }),
      { ...options, operationTimeoutMs: 10, retryAttempts: 0 },
    ).pipe(Effect.provide(TestClock.layer()))

    const failure = await Effect.runPromise(program)
    if (!(failure instanceof BrokerReadError)) throw new Error('deadline test failed with an unexpected value')
    expect(failure).toMatchObject({
      kind: BrokerReadErrorKind.Timeout,
      operation: 'account',
      retryable: true,
    })
    expect(interrupted).toBe(true)
  })

  test('maps immediate transport failures without misreporting a timeout', async () => {
    const client = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: 'connection refused for paper-key and paper-secret',
          }),
        }),
      ),
    )

    const failure = await Effect.runPromise(
      Effect.flip(withClient(client, (read) => read.account, { ...options, retryAttempts: 0 })),
    )
    expect(failure).toMatchObject({
      kind: BrokerReadErrorKind.Transport,
      operation: 'account',
      retryable: true,
      cause: {
        tag: 'HttpClientError',
        reason: 'TransportError',
        message: expect.stringContaining('connection refused'),
      },
    })
    expect(JSON.stringify(failure.cause)).not.toContain('paper-key')
    expect(JSON.stringify(failure.cause)).not.toContain('paper-secret')
  })

  test('retains the failing configuration path without invoking Alpaca', async () => {
    let calls = 0
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(jsonResponse(request, accountResponse))
    })

    const failure = await Effect.runPromise(
      Effect.flip(withClient(client, (read) => read.account, { ...options, operationTimeoutMs: 0 })),
    )

    expect(failure).toMatchObject({
      kind: BrokerReadErrorKind.Configuration,
      operation: 'configuration',
      cause: {
        tag: 'SchemaError',
        message: expect.stringContaining('["operationTimeoutMs"]'),
      },
    })
    expect(calls).toBe(0)
  })

  test('refuses to publish the live capability for the wrong paper account', async () => {
    const wrongAccount = '8f2a5d40-3a43-4e80-9ef0-4b8a4db1d276'
    const client = HttpClient.make((request) =>
      Effect.succeed(jsonResponse(request, { ...accountResponse, id: wrongAccount })),
    )
    const testLayer = layer(options).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* BrokerRead
        }).pipe(Effect.provide(testLayer)),
      ),
    )
    expect(failure).toMatchObject({
      kind: BrokerReadErrorKind.AccountMismatch,
      operation: 'account',
      retryable: false,
      requestId: 'req-123',
    })
    expect(failure.message).toContain(wrongAccount)
    expect(failure.message).toContain(accountId)
  })
})

describe('Alpaca proxy lifecycle', () => {
  test('keeps its Undici proxy dispatcher alive until the owning scope exits and releases it exactly once', async () => {
    let releases = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* makeProxyDispatcher('http://proxy.test:3128', {
            create: (url) => new Undici.ProxyAgent({ uri: url.toString() }),
            destroy: () => {
              releases += 1
              return Promise.resolve()
            },
          })
          expect(releases).toBe(0)
          yield* Effect.yieldNow
          expect(releases).toBe(0)
        }),
      ),
    )
    expect(releases).toBe(1)
  })

  test('fails before acquisition for unsafe proxy configuration', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(Effect.scoped(makeProxyDispatcher('socks5://user:secret@proxy.test:1080'))),
    )
    expect(failure).toMatchObject({
      kind: BrokerReadErrorKind.Configuration,
      operation: 'proxy',
      retryable: false,
    })
  })
})
