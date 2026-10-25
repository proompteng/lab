import { describe, expect, test } from 'bun:test'

import * as Undici from '@effect/platform-node/Undici'
import { Cause, Effect, Exit, Fiber, Layer, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http'

import { canonicalHashV1Result } from '../hash'
import { BrokerEnvironment } from '../execution/authority'
import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  AssetStatus,
  BrokerRead,
  OrderCollection,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSide,
  SortDirection,
  TradeActivityType,
  readPreflightTimeoutMs,
  type BrokerReadShape,
} from './alpaca/model'
import { BrokerReadError, BrokerReadErrorKind } from './alpaca/failures'
import { BrokerAccountPreflightError, verifyReadAccess } from './alpaca/preflight'
import { BrokerProvider, alpacaSandboxBaseUrl, decodeBrokerConnection, type BrokerConnection } from './connection'
import { BrokerSession, BrokerSessionAcquisitionError, BrokerSessionAcquisitionStage, layer } from './alpaca/session'
import { make, alpacaHttpLayer } from './alpaca/http'
import { decodeOrder } from './alpaca/model'
import { decimalToMicrosResult, normalizeOrderResult } from './alpaca/normalizers'
import { responseEvidenceResult } from './alpaca/requests'
import { readStableBrokerSnapshot } from '../simulation-reconciliation/broker-history'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const assetId = 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415'
const orderId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const clientOrderId = 'bayn-test-order-1'

const options = Result.getOrThrow(
  decodeBrokerConnection({
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: accountId,
    key: Redacted.make('paper-key'),
    secret: Redacted.make('paper-secret'),
    proxyUrl: 'http://bayn-egress-proxy:3128',
    operationTimeoutMs: 1_000,
    retryAttempts: 2,
  }),
)

const accountResponse = {
  id: accountId,
  account_number: '010203ABCD',
  status: 'ACTIVE',
  currency: 'USD',
  cash: '-23140.2',
  equity: '103820.56',
  last_equity: '104000.00',
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
  readOptions: BrokerConnection = options,
): Effect.Effect<A, BrokerReadError | E> =>
  make(readOptions).pipe(Effect.flatMap(use), Effect.provideService(HttpClient.HttpClient, client))

const verifyConnectionReadAccess = (read: BrokerReadShape) => verifyReadAccess(options, read)

describe('Alpaca paper reads', () => {
  test('retains the broker crypto fee tier with its account response evidence', async () => {
    const raw = { ...accountResponse, crypto_status: 'ACTIVE', crypto_tier: 4 }
    const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, raw)))
    const result = await Effect.runPromise(withClient(client, (read) => read.account))
    expect(result.value).toMatchObject({ id: accountId, cryptoStatus: 'ACTIVE', cryptoFeeTier: 4 })
    expect(result.evidence.contentHash).toBe(Result.getOrThrow(canonicalHashV1Result(raw)))
  })

  test.each([0, 9, '4'])('rejects an unrecognized broker crypto fee tier %s', async (cryptoTier) => {
    const raw = { ...accountResponse, crypto_status: 'ACTIVE', crypto_tier: cryptoTier }
    const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, raw)))
    const failure = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.account)))
    expect(failure.kind).toBe(BrokerReadErrorKind.InvalidResponse)
  })

  test.each([
    ['ETHUSD', 'us_equity'],
    ['ETH/USD', 'us_equity'],
    ['AAPL', 'crypto'],
    ['XRPUSD', 'crypto'],
    ['ETH/BTC', 'crypto'],
    ['ethusd', 'crypto'],
  ])('rejects mismatched or unsupported broker position %s in %s', async (symbol, assetClass) => {
    const response = [{ ...positionResponse, symbol, asset_class: assetClass }]
    const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, response)))
    const failure = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.positions)))
    expect(failure).toMatchObject({
      operation: 'positions',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })
  })

  test('reads and runtime-decodes the configured paper account without leaking credentials', async () => {
    let method = ''
    let url = ''
    let key = ''
    let secret = ''
    let inspected = ''
    let surface: readonly string[] = []
    const client = HttpClient.make((request, target) =>
      Effect.gen(function* () {
        method = request.method
        url = target.toString()
        key = request.headers['apca-api-key-id'] ?? ''
        secret = request.headers['apca-api-secret-key'] ?? ''
        inspected = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(request.toJSON()).pipe(
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.EncodeError({
                  request,
                  cause,
                  description: 'failed to encode redacted request inspection',
                }),
              }),
          ),
        )
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
      'feeActivities',
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
      lastEquityMicros: '104000000000',
      buyingPowerMicros: '262113632000',
      observedAt: '1970-01-01T00:00:00.000Z',
    })
    expect(result.evidence).toEqual({
      requestId: 'req-123',
      status: 200,
      contentHash: Result.getOrThrow(canonicalHashV1Result(accountResponse)),
      observedAt: '1970-01-01T00:00:00.000Z',
      rateLimit: {
        limit: '200',
        remaining: '199',
        reset: '1784664000',
        retryAfter: undefined,
      },
    })
  })

  test.each([
    ['103820.560000493882', '104000.000000693882', '103820560000', '104000000001'],
    ['-0.000000000001', '-0.000000000001', '-1', '0'],
    ['-100.000000000001', '-101.000000000001', '-100000001', '-101000000'],
    ['10.999999999999', '11.999999999999', '10999999', '12000000'],
    ['10.123456000000', '11.123456000000', '10123456', '11123456'],
  ])(
    'bounds account equity marks without understating daily loss: %s / %s',
    async (equity, lastEquity, current, previous) => {
      const raw = { ...accountResponse, equity, last_equity: lastEquity }
      const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, raw)))
      const result = await Effect.runPromise(withClient(client, (read) => read.account))
      expect(result.value.equityMicros).toBe(current)
      expect(result.value.lastEquityMicros).toBe(previous)
      expect(result.value.cashMicros).toBe('-23140200000')
      expect(result.value.buyingPowerMicros).toBe('262113632000')
      expect(result.evidence.contentHash).toBe(Result.getOrThrow(canonicalHashV1Result(raw)))
    },
  )

  test.each(['cash', 'buying_power', 'non_marginable_buying_power'] as const)(
    'keeps exact-money precision checks for %s while accepting high-precision marks',
    async (field) => {
      const raw = { ...accountResponse, last_equity: '104000.000000693882', [field]: '1.000000000001' }
      const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, raw)))
      const failure = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.account)))
      expect(failure).toMatchObject({
        operation: 'account',
        kind: BrokerReadErrorKind.InvalidResponse,
        retryable: false,
      })
    },
  )

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
    const requestHash = Result.getOrThrow(
      canonicalHashV1Result({
        schemaVersion: 'bayn.alpaca-account-configuration-observation.v1',
        source: 'alpaca-v2-account-configurations',
        method: 'GET',
        path: '/v2/account/configurations',
      }),
    )
    const normalized = {
      schemaVersion: 'bayn.alpaca-account-configuration-observation.v1',
      source: 'alpaca-v2-account-configurations',
      requestHash,
      fractionalTrading: true,
    } as const
    expect(result.value).toEqual({
      ...normalized,
      observedAt: '1970-01-01T00:00:01.000Z',
      normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(normalized)),
    })
    expect(result.evidence).toMatchObject({
      requestId: 'req-123',
      status: 200,
      contentHash: Result.getOrThrow(canonicalHashV1Result(accountConfigurationResponse)),
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
      contentHash: Result.getOrThrow(canonicalHashV1Result(response)),
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
      minimumQuantityAtoms: '1000000000',
      quantityIncrementAtoms: '1000000000',
      priceIncrementAtoms: '100000',
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
    const requestHash = Result.getOrThrow(
      canonicalHashV1Result({
        schemaVersion: 'bayn.alpaca-asset-observation.v1',
        source: 'alpaca-v2-asset',
        method: 'GET',
        path: `/v2/assets/${encodeURIComponent(requestedSymbol)}`,
        requestedSymbol,
      }),
    )
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
      minimumQuantityAtoms: '1000000000',
      quantityIncrementAtoms: '1000000000',
      priceIncrementAtoms: '100000',
      attributes: ['ipo'],
    } as const
    expect(result.value).toEqual({
      ...normalized,
      observedAt: '1970-01-01T00:00:02.000Z',
      normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(normalized)),
    })
    expect(result.evidence).toMatchObject({
      requestId: 'req-123',
      status: 200,
      contentHash: Result.getOrThrow(canonicalHashV1Result(response)),
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
      contentHash: Result.getOrThrow(canonicalHashV1Result(response)),
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
      contentHash: Result.getOrThrow(canonicalHashV1Result(response)),
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
      contentHash: Result.getOrThrow(canonicalHashV1Result(response)),
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
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
      source: 'alpaca-v2-calendar',
      requestedRange: { start: '2026-03-06', end: '2026-03-10' },
      timeZone: 'UTC',
      sessions: [
        {
          date: '2026-03-06',
          openAt: '2026-03-06T13:00:00.000Z',
          closeAt: '2026-03-06T22:00:00.000Z',
        },
        {
          date: '2026-03-09',
          openAt: '2026-03-09T12:00:00.000Z',
          closeAt: '2026-03-09T21:00:00.000Z',
        },
      ],
      providerSessions: [
        {
          date: '2026-03-06',
          regularOpenAt: '2026-03-06T14:30:00.000Z',
          regularCloseAt: '2026-03-06T21:00:00.000Z',
          sessionOpenAt: '2026-03-06T09:00:00.000Z',
          sessionCloseAt: '2026-03-07T01:00:00.000Z',
        },
        {
          date: '2026-03-09',
          regularOpenAt: '2026-03-09T13:30:00.000Z',
          regularCloseAt: '2026-03-09T20:00:00.000Z',
          sessionOpenAt: '2026-03-09T08:00:00.000Z',
          sessionCloseAt: '2026-03-10T00:00:00.000Z',
        },
      ],
    } as const
    expect(result.value).toEqual({
      ...normalized,
      normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(normalized)),
    })
    expect(result.evidence).toMatchObject({
      requestId: 'req-123',
      status: 200,
      contentHash: Result.getOrThrow(canonicalHashV1Result(response)),
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
      { session_open: '0930', session_close: '1600', date: '2026-03-09', open: '09:30', close: '16:00' },
      { session_open: '0930', session_close: '1600', date: '2026-03-09', open: '09:30', close: '16:00' },
    ]
    const duplicate = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.marketCalendar(query))))
    expect(duplicate).toMatchObject({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
    })

    response = [{ session_open: '0930', session_close: '1600', date: '2026-03-11', open: '09:30', close: '16:00' }]
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
      if (url.pathname === '/v2/account/configurations') {
        return Effect.succeed(jsonResponse(request, accountConfigurationResponse))
      }
      if (url.pathname === '/v2/positions') return Effect.succeed(jsonResponse(request, []))
      if (url.pathname === '/v2/orders' || url.pathname === '/v2/account/activities/FILL') {
        return Effect.succeed(jsonResponse(request, []))
      }
      return Effect.succeed(jsonResponse(request, { code: 40410000, message: 'order not found' }, 404))
    })

    const proof = await Effect.runPromise(
      withClient(client, verifyConnectionReadAccess).pipe(Effect.provide(TestClock.layer())),
    )

    expect(proof).toMatchObject({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      accountId,
      accountStatus: AccountStatus.Active,
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
      fractionalTrading: true,
      positionCount: 0,
      openOrderCount: 0,
      recentOrderCount: 0,
      fillCount: 0,
      orderById: 'NOT_FOUND',
      orderByClientId: 'NOT_FOUND',
    })
    expect(proof.accountHash).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.accountConfigurationHash).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.positionsHash).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.ordersHash).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.fillsHash).toMatch(/^[a-f0-9]{64}$/)
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
    expect(requests.some(({ url }) => url.pathname === '/v2/calendar')).toBe(false)
  })

  test('preflights ordinary non-empty orders whose optional Alpaca fields are null', async () => {
    const client = HttpClient.make((request, url) => {
      if (url.pathname === '/v2/account') return Effect.succeed(jsonResponse(request, accountResponse))
      if (url.pathname === '/v2/account/configurations') {
        return Effect.succeed(jsonResponse(request, accountConfigurationResponse))
      }
      if (
        url.pathname === '/v2/positions' ||
        url.pathname === '/v2/account/activities/FILL' ||
        url.pathname === '/v2/calendar'
      ) {
        return Effect.succeed(jsonResponse(request, []))
      }
      return Effect.succeed(jsonResponse(request, url.pathname === '/v2/orders' ? [orderResponse] : orderResponse))
    })

    const proof = await Effect.runPromise(withClient(client, verifyConnectionReadAccess))

    expect(proof).toMatchObject({
      accountId,
      openOrderCount: 1,
      recentOrderCount: 1,
      orderById: 'MATCHED',
      orderByClientId: 'MATCHED',
    })
    expect(proof.ordersHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('preflights account access during a market calendar outage', async () => {
    const requests: string[] = []
    const client = HttpClient.make((request, url) => {
      requests.push(url.pathname)
      if (url.pathname === '/v2/account') return Effect.succeed(jsonResponse(request, accountResponse))
      if (url.pathname === '/v2/account/configurations') {
        return Effect.succeed(jsonResponse(request, accountConfigurationResponse))
      }
      if (url.pathname === '/v2/calendar') {
        return Effect.succeed(jsonResponse(request, { message: 'Internal Server Error' }, 500))
      }
      if (url.pathname.startsWith('/v2/orders/') || url.pathname === '/v2/orders:by_client_order_id') {
        return Effect.succeed(jsonResponse(request, { code: 40410000, message: 'order not found' }, 404))
      }
      return Effect.succeed(jsonResponse(request, []))
    })

    const proof = await Effect.runPromise(
      withClient(client, verifyConnectionReadAccess, { ...options, retryAttempts: 0 }),
    )

    expect(proof).toMatchObject({
      accountId,
      accountStatus: AccountStatus.Active,
      positionCount: 0,
      openOrderCount: 0,
      recentOrderCount: 0,
      fillCount: 0,
      orderById: 'NOT_FOUND',
      orderByClientId: 'NOT_FOUND',
    })
    expect(requests).not.toContain('/v2/calendar')
  })

  test('fails closed on every account permission gate before reading positions, orders, or fills', async () => {
    const cases = [
      {
        name: 'inactive account',
        account: { ...accountResponse, status: AccountStatus.Inactive },
        configuration: accountConfigurationResponse,
        failure: { _tag: 'BrokerAccountNotActive', status: AccountStatus.Inactive },
      },
      {
        name: 'blocked account',
        account: { ...accountResponse, account_blocked: true },
        configuration: accountConfigurationResponse,
        failure: { _tag: 'BrokerAccountBlocked' },
      },
      {
        name: 'trading blocked',
        account: { ...accountResponse, trading_blocked: true },
        configuration: accountConfigurationResponse,
        failure: { _tag: 'BrokerTradingBlocked' },
      },
      {
        name: 'trading suspended by user',
        account: { ...accountResponse, trade_suspended_by_user: true },
        configuration: accountConfigurationResponse,
        failure: { _tag: 'BrokerTradingSuspendedByUser' },
      },
    ] as const

    for (const invalid of cases) {
      const paths: string[] = []
      const client = HttpClient.make((request, url) => {
        paths.push(url.pathname)
        if (url.pathname === '/v2/account') return Effect.succeed(jsonResponse(request, invalid.account))
        if (url.pathname === '/v2/account/configurations') {
          return Effect.succeed(jsonResponse(request, invalid.configuration))
        }
        return Effect.die(new Error(`unexpected preflight request to ${url.pathname}`))
      })

      const failure = await Effect.runPromise(
        Effect.flip(withClient(client, verifyConnectionReadAccess)).pipe(Effect.provide(TestClock.layer())),
      )

      expect(failure, invalid.name).toBeInstanceOf(BrokerAccountPreflightError)
      expect(failure, invalid.name).toMatchObject({
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        baseUrl: alpacaSandboxBaseUrl,
        expectedAccountId: accountId,
        failure: invalid.failure,
      })
      expect(paths, invalid.name).toEqual(['/v2/account', '/v2/account/configurations'])
    }
  })

  test('keeps fractional-trading configuration as read evidence instead of rejecting the shared read session', async () => {
    const client = HttpClient.make((request, url) => {
      if (url.pathname === '/v2/account') return Effect.succeed(jsonResponse(request, accountResponse))
      if (url.pathname === '/v2/account/configurations') {
        return Effect.succeed(jsonResponse(request, { ...accountConfigurationResponse, fractional_trading: false }))
      }
      if (
        url.pathname === '/v2/positions' ||
        url.pathname === '/v2/orders' ||
        url.pathname === '/v2/account/activities/FILL' ||
        url.pathname === '/v2/calendar'
      ) {
        return Effect.succeed(jsonResponse(request, []))
      }
      return Effect.succeed(jsonResponse(request, { code: 40410000, message: 'order not found' }, 404))
    })

    const proof = await Effect.runPromise(
      withClient(client, verifyConnectionReadAccess).pipe(Effect.provide(TestClock.layer())),
    )

    expect(proof).toMatchObject({
      accountStatus: AccountStatus.Active,
      fractionalTrading: false,
      orderById: 'NOT_FOUND',
      orderByClientId: 'NOT_FOUND',
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
          const fiber = yield* Effect.flip(verifyReadAccess(options, read)).pipe(Effect.forkChild)
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
        quantityAtoms: '5000000000',
        averageEntryPriceMicros: '100000000',
        costBasisMicros: '500000000',
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
        quantityAtoms: '-5000000000',
        marketValueMicros: '-600000000',
        unrealizedPnlMicros: '-100000000',
      }),
    ])

    response = [{ ...positionResponse, qty: '0.0791458741' }]
    const failure = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.positions)))
    expect(failure).toMatchObject({
      _tag: 'BrokerReadError',
      operation: 'positions',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
      cause: {
        tag: 'BrokerReadContractFailure',
        reason: 'DECIMAL_PRECISION',
        field: 'position quantity',
        actual: '0.0791458741',
      },
    })
    expect(failure.message).toContain('violates the Bayn read contract')

    response = [{ ...positionResponse, side: 'long', qty: '-170141183460469231731687303715884.105728' }]
    const normalizedOverflow = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.positions)))
    expect(normalizedOverflow).toMatchObject({
      _tag: 'BrokerReadError',
      operation: 'positions',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
      cause: {
        tag: 'BrokerReadContractFailure',
        reason: 'DECIMAL_RANGE',
        field: 'position quantity',
        actual: '-170141183460469231731687303715884.105728',
      },
    })
  })

  for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
    test(`reads the compact ${symbol} position after a native coin fill`, async () => {
      const response = [
        {
          ...positionResponse,
          symbol: symbol.replace('/', ''),
          exchange: 'CRYPTO',
          asset_class: 'crypto',
          qty: '0.032967375',
          avg_entry_price: '2425.31',
          cost_basis: '79.956104',
          market_value: '79.45467',
          unrealized_pl: '-0.501434',
          current_price: '2410.1',
        },
      ]
      const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, response)))
      const result = await Effect.runPromise(withClient(client, (read) => read.positions))
      expect(result.evidence.contentHash).toBe(Result.getOrThrow(canonicalHashV1Result(response)))
      expect(result.value).toEqual([
        expect.objectContaining({
          symbol,
          assetClass: AssetClass.Crypto,
          quantityAtoms: '32967375',
          averageEntryPriceMicros: '2425310000',
          costBasisMicros: '79956104',
          marketValueMicros: '79454670',
          unrealizedPnlMicros: '-501434',
        }),
      ])
    })
  }

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
        quantityAtoms: '5000000000',
        filledQuantityAtoms: '0',
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

  test('reads exact signed non-trade fees without retaining account descriptions', async () => {
    let requestedUrl: URL | undefined
    const raw = {
      activity_type: 'FEE',
      id: `20260910000000000::${orderId}`,
      date: '2026-09-10',
      net_amount: '-0.21',
      description: 'private account detail',
    }
    const client = HttpClient.make((request, url) => {
      requestedUrl = url
      return Effect.succeed(jsonResponse(request, [raw]))
    })
    const result = await Effect.runPromise(
      withClient(client, (read) => read.feeActivities({ pageSize: 1, direction: SortDirection.Ascending })),
    )
    expect(requestedUrl?.pathname).toBe('/v2/account/activities')
    expect(requestedUrl?.searchParams.get('activity_types')).toBe('FEE,CFEE')
    expect(result.value).toEqual({
      items: [{ accountId, activityId: raw.id, date: raw.date, netAmountMicros: '-210000' }],
      nextPageToken: raw.id,
    })
    expect(JSON.stringify(result.value)).not.toContain('private account detail')
    for (const invalid of [
      { ...raw, account_id: assetId },
      { ...raw, net_amount: '-0.0000001' },
      { ...raw, activity_type: 'DIV' },
      { ...raw, date: '2026-02-30' },
    ]) {
      const bad = HttpClient.make((request) => Effect.succeed(jsonResponse(request, [invalid])))
      const exit = await Effect.runPromiseExit(withClient(bad, (read) => read.feeActivities()))
      expect(Exit.isFailure(exit)).toBe(true)
    }
    expect(Result.getOrThrow(decimalToMicrosResult('-0.01', true, 'fee'))).toBe('-10000')
    expect(Result.isFailure(decimalToMicrosResult('-0.01', false, 'quantity'))).toBe(true)
    expect(Result.getOrThrow(decimalToMicrosResult('0.01', true, 'fee refund'))).toBe('10000')
  })

  test('retains available cash CFEE through the HTTP adapter in a stable broker snapshot', async () => {
    const raw = {
      activity_type: 'CFEE',
      id: `20261015000000000::${orderId}`,
      date: '2026-10-15',
      created_at: '2026-10-14T23:59:58.123456Z',
      net_amount: '-0.23',
      status: 'executed',
      description: 'Coin Pair Transaction Fee (USD)',
    }
    const client = HttpClient.make((request, url) => {
      if (url.pathname === '/v2/account') return Effect.succeed(jsonResponse(request, accountResponse))
      if (url.pathname === '/v2/account/activities')
        return Effect.succeed(jsonResponse(request, url.searchParams.has('until') ? [] : [raw]))
      if (['/v2/positions', '/v2/orders', '/v2/account/activities/FILL'].includes(url.pathname))
        return Effect.succeed(jsonResponse(request, []))
      return Effect.die(new Error('Unexpected broker endpoint'))
    })

    const snapshot = await Effect.runPromise(
      withClient(client, (read) => readStableBrokerSnapshot(read, Effect.succeed('2026-10-15T08:00:00.000Z'))),
    )
    expect(snapshot.history.fees).toHaveLength(1)
    expect(snapshot.history.fees[0]?.value).toMatchObject({
      accountId,
      activityId: raw.id,
      date: raw.date,
      sourceCreatedAt: '2026-10-14T23:59:58.123456000Z',
      netAmountMicros: '-230000',
    })
    expect(snapshot.history.fees[0]?.value.coinDebit).toBeUndefined()
    expect(snapshot.history.fees[0]?.evidence.contentHash).toBe(Result.getOrThrow(canonicalHashV1Result([raw])))
  })

  test('rejects trade timestamp filters on daily fee queries before dispatch', async () => {
    let calls = 0
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(jsonResponse(request, []))
    })
    for (const query of [
      { pageSize: 1, until: '2026-10-15T09:56:00.000Z' },
      { pageSize: 1, after: '2026-10-15T00:00:00.000Z' },
    ]) {
      const failure = await Effect.runPromise(Effect.flip(withClient(client, (read) => read.feeActivities(query))))
      expect(failure).toMatchObject({
        operation: 'fee-activities',
        kind: BrokerReadErrorKind.InvalidRequest,
        retryable: false,
      })
    }
    expect(calls).toBe(0)
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
          cumulativeQuantityAtoms: '5000000000',
          leavesQuantityAtoms: '0',
          priceAtoms: '120125000000',
          quantityAtoms: '5000000000',
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

  test('returns closed fact-bearing failures at decimal and order boundaries without throwing', () => {
    const signedMaximum = decimalToMicrosResult('170141183460469231731687303715884.105727', true, 'signed')
    const unsignedMaximum = decimalToMicrosResult('340282366920938463463374607431768.211455', false, 'unsigned')
    const signedOverflow = decimalToMicrosResult('170141183460469231731687303715884.105728', true, 'signed')
    const unsignedOverflow = decimalToMicrosResult('340282366920938463463374607431768.211456', false, 'unsigned')
    const precisionLoss = decimalToMicrosResult('0.0000001', false, 'precision')

    expect(Result.getOrThrow(signedMaximum)).toBe('170141183460469231731687303715884105727')
    expect(Result.getOrThrow(unsignedMaximum)).toBe('340282366920938463463374607431768211455')
    expect(signedOverflow).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'BrokerReadContractFailure', reason: 'DECIMAL_RANGE', field: 'signed' },
    })
    expect(unsignedOverflow).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'BrokerReadContractFailure', reason: 'DECIMAL_RANGE', field: 'unsigned' },
    })
    expect(precisionLoss).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'BrokerReadContractFailure', reason: 'DECIMAL_PRECISION', field: 'precision' },
    })

    const decoded = decodeOrder({ ...orderResponse, qty: null, notional: null })
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isFailure(decoded)) return
    expect(() => normalizeOrderResult(decoded.success, accountId, '2026-07-26T08:00:00.000Z')).not.toThrow()
    expect(normalizeOrderResult(decoded.success, accountId, '2026-07-26T08:00:00.000Z')).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'BrokerReadContractFailure',
        reason: 'ORDER_SHAPE',
        message: 'order must contain exactly one of qty or notional',
      },
    })
  })

  test('rejects inconsistent rate-limit evidence as a total typed result', () => {
    const evidence = responseEvidenceResult(
      {
        'x-request-id': 'req-rate-limit',
        'x-ratelimit-limit': '10',
        'x-ratelimit-remaining': '11',
      },
      200,
      'a'.repeat(64),
      '2026-07-26T08:00:00.000Z',
    )

    expect(evidence).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'BrokerReadContractFailure',
        reason: 'RATE_LIMIT',
        field: 'x-ratelimit-remaining',
        expected: '<=10',
        actual: '11',
      },
    })
  })

  test('fails typed when raw JSON cannot be canonically hashed', async () => {
    const response = { ...accountResponse, account_number: '\ud800' }
    const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, response)))

    const failure = await Effect.runPromise(
      Effect.flip(withClient(client, (read) => read.account)).pipe(Effect.provide(TestClock.layer())),
    )

    expect(failure).toMatchObject({
      operation: 'account',
      kind: BrokerReadErrorKind.InvalidResponse,
      retryable: false,
      status: 200,
      requestId: 'req-123',
      cause: {
        tag: 'BrokerReadContractFailure',
        message: expect.stringContaining('invalid-unicode-surrogate'),
      },
    })
    expect(failure.contentHash).toBeUndefined()
    expect(failure.observedAt).toBeUndefined()
  })

  test('retains raw hash and causal time when rate-limit evidence is inconsistent', async () => {
    const headers = {
      ...responseHeaders,
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '11',
    }
    const client = HttpClient.make((request) => Effect.succeed(jsonResponse(request, accountResponse, 200, headers)))

    const failure = await Effect.runPromise(
      Effect.flip(withClient(client, (read) => read.account)).pipe(Effect.provide(TestClock.layer())),
    )

    expect(failure).toMatchObject({
      operation: 'account',
      kind: BrokerReadErrorKind.InvalidResponse,
      status: 200,
      requestId: 'req-123',
      contentHash: Result.getOrThrow(canonicalHashV1Result(accountResponse)),
      observedAt: '1970-01-01T00:00:00.000Z',
      cause: {
        tag: 'BrokerReadContractFailure',
        message: 'rate-limit remaining exceeds limit',
      },
    })
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
      contentHash: Result.getOrThrow(canonicalHashV1Result({ code: 42910000, message: 'slow down' })),
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

  test('interrupts one active GET without starting retries after the deadline', async () => {
    let calls = 0
    let interrupted = false
    const client = HttpClient.make((request) => {
      calls += 1
      expect(request.method).toBe('GET')
      return Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      )
    })

    const program = withClient(
      client,
      (read) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.flip(read.account).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(10)
          return yield* Fiber.join(fiber)
        }),
      { ...options, operationTimeoutMs: 10, retryAttempts: 3 },
    ).pipe(Effect.provide(TestClock.layer()))

    const failure = await Effect.runPromise(program)
    expect(failure).toMatchObject({ kind: BrokerReadErrorKind.Timeout, operation: 'account' })
    expect(calls).toBe(1)
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

  test('preserves an underlying HttpClient defect as a Cause defect', async () => {
    const defect = new Error('unexpected HttpClient defect')
    const client = HttpClient.make(() => Effect.die(defect))

    const exit = await Effect.runPromiseExit(
      withClient(client, (read) => read.account, { ...options, retryAttempts: 0 }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
  })

  test('acquires one verified session and publishes its exact read capability once', async () => {
    const paths: string[] = []
    const client = HttpClient.make((request, url) => {
      paths.push(url.pathname)
      if (url.pathname === '/v2/account') return Effect.succeed(jsonResponse(request, accountResponse))
      if (url.pathname === '/v2/account/configurations') {
        return Effect.succeed(jsonResponse(request, accountConfigurationResponse))
      }
      if (
        url.pathname === '/v2/positions' ||
        url.pathname === '/v2/orders' ||
        url.pathname === '/v2/account/activities/FILL' ||
        url.pathname === '/v2/calendar'
      ) {
        return Effect.succeed(jsonResponse(request, []))
      }
      return Effect.succeed(jsonResponse(request, { code: 40410000, message: 'order not found' }, 404))
    })
    const testLayer = layer(options).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))

    const services = await Effect.runPromise(
      Effect.all({ session: BrokerSession, read: BrokerRead }).pipe(
        Effect.provide(Layer.merge(testLayer, TestClock.layer())),
      ),
    )

    expect(services.session.read).toBe(services.read)
    expect(services.session.connection).toBe(options)
    expect(services.session.preflight).toMatchObject({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      accountId,
      accountStatus: AccountStatus.Active,
      fractionalTrading: true,
    })
    expect(paths).toHaveLength(8)
    expect(paths).not.toContain('/v2/calendar')
    expect(paths.filter((path) => path === '/v2/account')).toHaveLength(1)
    expect(paths.filter((path) => path === '/v2/account/configurations')).toHaveLength(1)
  })

  test('refuses to publish the live capability for the wrong paper account', async () => {
    const wrongAccount = '8f2a5d40-3a43-4e80-9ef0-4b8a4db1d276'
    const client = HttpClient.make((request) =>
      Effect.succeed(jsonResponse(request, { ...accountResponse, id: wrongAccount })),
    )
    const testLayer = layer(options).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))
    const failure = await Effect.runPromise(Effect.flip(BrokerRead.pipe(Effect.provide(testLayer))))
    expect(failure).toBeInstanceOf(BrokerSessionAcquisitionError)
    expect(failure).toMatchObject({
      stage: BrokerSessionAcquisitionStage.Account,
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      expectedAccountId: accountId,
      cause: {
        kind: BrokerReadErrorKind.AccountMismatch,
        operation: 'account',
        retryable: false,
        requestId: 'req-123',
      },
    })
    expect(failure.cause.message).toContain(wrongAccount)
    expect(failure.cause.message).toContain(accountId)
  })
})

describe('Alpaca proxy lifecycle', () => {
  test('keeps its Undici proxy dispatcher alive until the owning scope exits and releases it exactly once', async () => {
    let releases = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            alpacaHttpLayer(options, {
              create: (url) => new Undici.ProxyAgent({ uri: url.toString() }),
              destroy: () => {
                releases += 1
                return Promise.resolve()
              },
            }),
          )
          expect(releases).toBe(0)
          yield* Effect.yieldNow
          expect(releases).toBe(0)
        }),
      ),
    )
    expect(releases).toBe(1)
  })

  test('contains dispatcher construction failures in the typed acquisition channel', async () => {
    let releases = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Layer.build(
            alpacaHttpLayer(options, {
              create: () => {
                throw new Error('dispatcher construction failed')
              },
              destroy: () => {
                releases += 1
                return Promise.resolve()
              },
            }),
          ),
        ),
      ),
    )

    expect(failure).toMatchObject({
      kind: BrokerReadErrorKind.Configuration,
      operation: 'proxy',
      retryable: false,
      message: 'Alpaca proxy dispatcher acquisition failed',
    })
    expect(releases).toBe(0)
  })
})
