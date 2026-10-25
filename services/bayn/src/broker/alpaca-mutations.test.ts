import { prepareSubmit } from './alpaca-mutations/decisions'
import { describe, expect, test } from 'bun:test'

import { Deferred, Effect, Fiber, Redacted, Ref, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http'

import { provideTestLayer } from '../effect-test-support'
import { canonicalHashV1Result } from '../hash'
import {
  BrokerAccess,
  BrokerEnvironment,
  grantedCapitalAuthority,
  makeExecutionAuthority,
  makeCapitalGrantRecord,
  noCapitalAuthority,
  type ExecutionStrategyIdentity,
  type ExecutionAuthority,
} from '../execution/authority'
import { IntentState, MutationOutcome, OrderSide, OrderType, TimeInForce, type Intent } from '../execution/contracts'
import {
  BrokerMutationError,
  MutationFailure,
  MutationOperation,
  type BrokerMutationShape,
} from './alpaca-mutations/model'
import {
  authorizeMutationAccess,
  orderPriceBoundaryMicros,
  orderRequestBody,
  submitBody,
} from './alpaca-mutations/decisions'
import { makeMutation } from './alpaca-mutations/interpreter'
import { AccountStatus, OrderStatus, type BrokerReadShape, type ReadPreflight } from './alpaca/model'
import { BrokerProvider, alpacaLiveBaseUrl, alpacaSandboxBaseUrl, decodeBrokerConnection } from './connection'
import { type BrokerSessionShape } from './alpaca/session'
import { unusedAssetBySymbol, unusedMarketCalendar } from './alpaca-test-support'
import { decodeOrder } from './alpaca/model'
import { normalizeOrderResult } from './alpaca/normalizers'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const orderId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const assetId = 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415'
const authorityGenerationHash = 'f'.repeat(64)
const strategyIdentity: ExecutionStrategyIdentity = {
  name: 'risk-balanced-trend',
  behaviorHash: '8'.repeat(64),
  parameterHash: '9'.repeat(64),
  parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
}
const authorityObservedAt = '2026-07-28T08:00:00.000Z'

const connection = Result.getOrThrow(
  decodeBrokerConnection({
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: accountId,
    key: Redacted.make('paper-key'),
    secret: Redacted.make('paper-secret'),
    proxyUrl: 'http://bayn-egress-proxy:3128',
    operationTimeoutMs: 1_000,
    retryAttempts: 0,
  }),
)

const submitAuthority = Result.getOrThrow(
  makeExecutionAuthority({
    brokerIdentity: connection.identity,
    brokerAccess: BrokerAccess.Mutation,
    capitalAuthority: grantedCapitalAuthority(authorityGenerationHash),
    strategy: strategyIdentity,
    observedAt: authorityObservedAt,
  }),
)

const preflight: ReadPreflight = {
  provider: BrokerProvider.Alpaca,
  environment: BrokerEnvironment.Sandbox,
  baseUrl: alpacaSandboxBaseUrl,
  accountId,
  accountStatus: AccountStatus.Active,
  accountBlocked: false,
  tradingBlocked: false,
  tradeSuspendedByUser: false,
  accountHash: '1'.repeat(64),
  fractionalTrading: true,
  accountConfigurationHash: '2'.repeat(64),
  positionCount: 0,
  positionsHash: '3'.repeat(64),
  openOrderCount: 0,
  recentOrderCount: 0,
  ordersHash: '4'.repeat(64),
  fillCount: 0,
  fillsHash: '5'.repeat(64),
  orderById: 'NOT_FOUND',
  orderByClientId: 'NOT_FOUND',
}

const unexpectedRead = <A>(label: string): Effect.Effect<A> => Effect.die(new Error(`unexpected ${label}`))

const verifiedSession = (
  options: {
    readonly operationTimeoutMs?: number
    readonly read?: Partial<BrokerReadShape>
    readonly preflight?: Partial<ReadPreflight>
  } = {},
): BrokerSessionShape => ({
  connection: {
    ...connection,
    operationTimeoutMs: options.operationTimeoutMs ?? connection.operationTimeoutMs,
  },
  read: {
    account: unexpectedRead('account read'),
    accountConfiguration: unexpectedRead('account configuration read'),
    assetBySymbol: unusedAssetBySymbol,
    positions: unexpectedRead('positions read'),
    orders: () => unexpectedRead('orders read'),
    orderById: () => unexpectedRead('order-by-id read'),
    orderByClientId: () => unexpectedRead('order-by-client-id read'),
    feeActivities: () => unexpectedRead('fee activities read'),
    fillActivities: () => unexpectedRead('fill activities read'),
    marketCalendar: unusedMarketCalendar,
    ...options.read,
  },
  preflight: { ...preflight, ...options.preflight },
})

interface MutationHarnessOptions {
  readonly authority?: ExecutionAuthority
  readonly operationTimeoutMs?: number
  readonly session?: BrokerSessionShape
}

const projectedSession = (
  lifecycle: (phase: 'begin' | 'end') => Effect.Effect<void>,
  operationTimeoutMs?: number,
): BrokerSessionShape => {
  const session = verifiedSession(operationTimeoutMs === undefined ? {} : { operationTimeoutMs })
  return {
    ...session,
    read: {
      ...session.read,
      projection: {
        fresh: session.read,
        snapshot: unexpectedRead('cached snapshot'),
        submissionSnapshot: () => unexpectedRead('unused submit projection'),
        invalidate: unexpectedRead('unguarded cache invalidation'),
        withMutation: (effect) =>
          Effect.acquireUseRelease(
            lifecycle('begin'),
            () => effect,
            () => lifecycle('end'),
          ),
      },
    },
  }
}

const intent: Intent = {
  schemaVersion: 'bayn.execution-intent.v5',
  intentId: 'a'.repeat(64),
  authorityGenerationHash: 'f'.repeat(64),
  riskDecisionId: 'b'.repeat(64),
  strategyName: 'risk-balanced-trend',
  cycleId: 'c'.repeat(64),
  decisionHash: 'd'.repeat(64),
  policyHash: 'e'.repeat(64),
  accountId,
  clientOrderId: `b1_${'A'.repeat(43)}`,
  symbol: 'AMD',
  side: OrderSide.Buy,
  orderType: OrderType.Limit as const,
  timeInForce: TimeInForce.Day as const,
  quantityAtoms: '1250000000',
  notionalLimitMicros: '200000000',
  limitPriceMicros: '160000000',
  state: IntentState.IoStarted,
  createdAt: '2026-07-22T12:00:00.000Z',
}

const orderResponse = {
  id: orderId,
  client_order_id: intent.clientOrderId,
  created_at: '2026-07-22T12:00:01.100Z',
  updated_at: '2026-07-22T12:00:01.100Z',
  submitted_at: '2026-07-22T12:00:01.000Z',
  filled_at: null,
  expired_at: null,
  canceled_at: null,
  failed_at: null,
  replaced_at: null,
  replaced_by: null,
  replaces: null,
  asset_id: assetId,
  symbol: intent.symbol,
  asset_class: 'us_equity',
  notional: null,
  qty: '1.25',
  filled_qty: '0',
  filled_avg_price: null,
  order_class: '',
  order_type: 'limit',
  type: 'limit',
  side: 'buy',
  time_in_force: 'day',
  limit_price: '160',
  stop_price: null,
  status: 'accepted',
  extended_hours: true,
  legs: null,
  trail_percent: null,
  trail_price: null,
  hwm: null,
}

const responseHeaders = {
  'content-type': 'application/json',
  'x-request-id': 'req-123',
}

const response = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  body: unknown,
  status = 200,
  headers: Record<string, string> = responseHeaders,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers,
    }),
  )

const withMutation = <A, E>(
  client: HttpClient.HttpClient,
  use: (mutation: BrokerMutationShape) => Effect.Effect<A, E>,
  options: MutationHarnessOptions = {},
): Effect.Effect<A, BrokerMutationError | E> => {
  const session =
    options.session ??
    verifiedSession(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs })
  return makeMutation(session, options.authority ?? submitAuthority, client).pipe(Effect.flatMap(use))
}

const requestBody = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]): unknown => {
  if (request.body._tag !== 'Uint8Array') throw new Error('expected a JSON request body')
  return JSON.parse(new TextDecoder().decode(request.body.body))
}

const assertFailure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error('expected request encoding failure')
  return result.failure
}

describe('Alpaca broker mutations', () => {
  test.each([
    ['submit', 200],
    ['submit', 500],
    ['cancel', 204],
    ['cancel', 500],
  ] as const)('holds the cache until %s returns HTTP %i', async (operation, status) => {
    const trace: string[] = []
    const session = projectedSession((phase) =>
      Effect.sync(() => {
        trace.push(phase)
      }),
    )
    const client = HttpClient.make((request) => {
      trace.push('request')
      return Effect.succeed(response(request, operation === 'submit' ? orderResponse : {}, status))
    })
    const exit = await Effect.runPromiseExit(
      withMutation(
        client,
        (mutation) =>
          operation === 'submit'
            ? mutation.submit(intent).pipe(Effect.asVoid)
            : mutation.cancel(orderId).pipe(Effect.asVoid),
        { session },
      ),
    )
    expect(exit._tag).toBe(status < 400 ? 'Success' : 'Failure')
    expect(trace).toEqual(['begin', 'request', 'end'])
  })

  test('returns closed request encoding failures without throwing', () => {
    expect(assertFailure(submitBody({ ...intent, state: IntentState.Approved }))).toMatchObject({
      _tag: 'OrderRequestError',
      failure: 'invalid-intent-state',
    })
    expect(assertFailure(orderRequestBody({ ...intent, orderType: OrderType.Market }))).toMatchObject({
      _tag: 'OrderRequestError',
      failure: 'invalid-order',
    })
    expect(
      assertFailure(
        orderRequestBody({
          ...intent,
          limitPriceMicros: '160000001',
        }),
      ),
    ).toMatchObject({
      _tag: 'OrderRequestError',
      failure: 'invalid-order',
      quantityAtoms: intent.quantityAtoms,
    })
    expect(assertFailure(orderRequestBody({ ...intent, timeInForce: TimeInForce.GoodUntilCanceled }))).toMatchObject({
      _tag: 'OrderRequestError',
      failure: 'invalid-order',
    })
    const malformedQuantity = assertFailure(orderRequestBody({ ...intent, quantityAtoms: 'not-an-integer' }))
    expect(malformedQuantity).toMatchObject({
      _tag: 'OrderRequestError',
      failure: 'invalid-order',
      quantityAtoms: 'not-an-integer',
    })
  })

  test('preserves BUY and SELL explicit LIMIT prices and exact fractional quantities', () => {
    const boundaryIntent = {
      ...intent,
      quantityAtoms: '3000000000',
      notionalLimitMicros: '99990000',
      limitPriceMicros: '33330000',
    }

    expect(orderPriceBoundaryMicros({ ...boundaryIntent, side: OrderSide.Buy })).toEqual(Result.succeed(33_330_000n))
    const sellIntent = {
      ...boundaryIntent,
      side: OrderSide.Sell,
      limitPriceMicros: '33340000',
      notionalLimitMicros: '100020000',
    }
    expect(orderPriceBoundaryMicros(sellIntent)).toEqual(Result.succeed(33_340_000n))
    expect(orderRequestBody({ ...boundaryIntent, side: OrderSide.Buy })).toMatchObject(
      Result.succeed({ type: 'limit', qty: '3', limit_price: '33.33', side: 'buy', extended_hours: true }),
    )
    expect(orderRequestBody(sellIntent)).toMatchObject(
      Result.succeed({ type: 'limit', qty: '3', limit_price: '33.34', side: 'sell', extended_hours: true }),
    )
    expect(
      orderRequestBody({
        ...boundaryIntent,
        side: OrderSide.Sell,
        quantityAtoms: '500000000',
        notionalLimitMicros: '50000000',
        limitPriceMicros: '100000000',
      }),
    ).toMatchObject(
      Result.succeed({ type: 'limit', time_in_force: 'day', limit_price: '100', qty: '0.5', side: 'sell' }),
    )
    expect(
      orderRequestBody({
        ...boundaryIntent,
        notionalLimitMicros: '100000001',
      }),
    ).toMatchObject(Result.fail({ failure: 'invalid-order' }))
  })

  test('preserves an exact verified limit price and rejects broker-increment drift instead of rounding it', () => {
    expect(
      orderRequestBody({
        ...intent,
        quantityAtoms: '1000000000',
        notionalLimitMicros: '101240000',
        limitPriceMicros: '101240000',
        orderType: OrderType.Limit as const,
        timeInForce: TimeInForce.Day as const,
      }),
    ).toMatchObject(
      Result.succeed({ type: 'limit', time_in_force: 'day', qty: '1', limit_price: '101.24', side: 'buy' }),
    )
    expect(
      orderRequestBody({
        ...intent,
        quantityAtoms: '1000000000',
        notionalLimitMicros: '101235000',
        limitPriceMicros: '101235000',
        orderType: OrderType.Limit as const,
        timeInForce: TimeInForce.Day as const,
      }),
    ).toMatchObject(Result.fail({ failure: 'invalid-order' }))
  })

  test('preserves executable adverse quote ticks through LIMIT request construction', () => {
    const buyIntent = {
      ...intent,
      side: OrderSide.Buy,
      orderType: OrderType.Limit as const,
      timeInForce: TimeInForce.Day as const,
      quantityAtoms: '3000000000',
      notionalLimitMicros: '300420000',
      limitPriceMicros: '100140000',
    }
    const sellIntent = {
      ...buyIntent,
      side: OrderSide.Sell,
      notionalLimitMicros: '300360000',
      limitPriceMicros: '100120000',
    }

    expect(orderPriceBoundaryMicros(buyIntent)).toEqual(Result.succeed(100_140_000n))
    expect(orderRequestBody(buyIntent)).toMatchObject(Result.succeed({ side: 'buy', limit_price: '100.14' }))
    expect(orderPriceBoundaryMicros(sellIntent)).toEqual(Result.succeed(100_120_000n))
    expect(orderRequestBody(sellIntent)).toMatchObject(Result.succeed({ side: 'sell', limit_price: '100.12' }))
  })

  test('rejects a notional cap that differs from the explicit price and quantity', () => {
    for (const notionalLimitMicros of ['26253492098', '999999']) {
      expect(orderRequestBody({ ...intent, notionalLimitMicros })).toMatchObject(
        Result.fail({ failure: 'invalid-order' }),
      )
    }
  })

  test('rejects retired MARKET terms at the intent boundary before request serialization', () => {
    const failure = assertFailure(
      prepareSubmit({ ...intent, orderType: OrderType.Market, timeInForce: TimeInForce.GoodUntilCanceled }, accountId),
    )
    expect(failure).toMatchObject({
      failure: MutationFailure.InvalidRequest,
      operation: MutationOperation.Submit,
      outcome: MutationOutcome.Known,
    })
  })

  test('allows a read-valid account with fractional trading disabled but blocks a notional mutation before broker I/O', async () => {
    let calls = 0
    const client = HttpClient.make(() => {
      calls += 1
      return Effect.die(new Error('fractional-ineligible mutation must not reach broker I/O'))
    })
    const session = verifiedSession({ preflight: { fractionalTrading: false } })

    const failure = await Effect.runPromise(
      Effect.flip(withMutation(client, (mutation) => mutation.submit(intent), { session })),
    )

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.InvalidRequest,
      outcome: MutationOutcome.Known,
      message: 'order requires fractional trading but the broker account configuration disables it',
    })
    expect(calls).toBe(0)
  })

  test('refuses to construct mutation capability without explicit submit-orders access', async () => {
    let requests = 0
    const client = HttpClient.make(() => {
      requests += 1
      return Effect.die(new Error('read-only access must not make a broker mutation request'))
    })
    const readOnly = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: connection.identity,
        brokerAccess: BrokerAccess.ReadOnly,
        capitalAuthority: noCapitalAuthority,
        strategy: strategyIdentity,
        observedAt: authorityObservedAt,
      }),
    )

    const failure = await Effect.runPromise(Effect.flip(makeMutation(verifiedSession(), readOnly, client)))

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Configuration,
      outcome: MutationOutcome.Known,
      message: 'Alpaca mutation capability requires explicit mutation broker access',
    })
    expect(requests).toBe(0)
  })

  test('exposes mutation access only from a validated mutation authority', () => {
    expect(authorizeMutationAccess(submitAuthority)).toEqual(Result.succeed(BrokerAccess.Mutation))
  })

  test('refuses authority and verified-session environment mismatch without broker I/O', async () => {
    let mutationCalls = 0
    const client = HttpClient.make(() => {
      mutationCalls += 1
      return Effect.die(new Error('environment mismatch must not make a mutation request'))
    })
    const liveConnection = Result.getOrThrow(
      decodeBrokerConnection({
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Live,
        baseUrl: alpacaLiveBaseUrl,
        expectedAccountId: accountId,
        key: Redacted.make('live-key'),
        secret: Redacted.make('live-secret'),
        proxyUrl: 'http://bayn-egress-proxy:3128',
        operationTimeoutMs: 1_000,
        retryAttempts: 0,
      }),
    )
    const grant = Result.getOrThrow(
      makeCapitalGrantRecord({
        schemaVersion: 'bayn.capital-grant.v2',
        brokerIdentity: liveConnection.identity,
        authorityGenerationHash,
        strategy: strategyIdentity,
        limits: {
          maxGrossNotionalMicros: '100000000000',
          maxOrderNotionalMicros: '10000000000',
          maxPositionNotionalMicros: '25000000000',
          maxDailyLossMicros: '1000000000',
          maxOpenOrders: 5,
        },
        validFrom: '2026-07-28T07:00:00.000Z',
        validUntil: '2026-07-28T09:00:00.000Z',
        issuedAt: '2026-07-28T06:00:00.000Z',
        issuedBy: 'operator:test',
      }),
    )
    const liveAuthority = Result.getOrThrow(
      makeExecutionAuthority({
        brokerIdentity: liveConnection.identity,
        brokerAccess: BrokerAccess.Mutation,
        capitalAuthority: grantedCapitalAuthority(grant),
        strategy: strategyIdentity,
        observedAt: authorityObservedAt,
      }),
    )

    const failure = await Effect.runPromise(
      Effect.flip(withMutation(client, () => Effect.void, { authority: liveAuthority })),
    )

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Configuration,
      outcome: MutationOutcome.Known,
      message: 'Alpaca mutation authority identity does not match the verified broker session',
    })
    expect(mutationCalls).toBe(0)
  })

  test('refuses a structurally mismatched verified session before broker I/O', async () => {
    let mutationCalls = 0
    const client = HttpClient.make(() => {
      mutationCalls += 1
      return Effect.die(new Error('session binding mismatch must not make a mutation request'))
    })
    const session: BrokerSessionShape = {
      ...verifiedSession(),
      preflight: {
        ...preflight,
        accountId: '40b22fc4-23bc-446c-bf07-bea43b5d6c35',
      },
    }

    const failure = await Effect.runPromise(Effect.flip(withMutation(client, () => Effect.void, { session })))

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Configuration,
      outcome: MutationOutcome.Known,
      message: 'Alpaca mutation capability requires an exact verified broker session binding',
    })
    expect(mutationCalls).toBe(0)
  })

  test('delegates durable recovery lookups to the exact verified session read adapter', async () => {
    const lookups: string[] = []
    const readResult = {
      value: Result.getOrThrow(
        normalizeOrderResult(Result.getOrThrow(decodeOrder(orderResponse)), accountId, intent.createdAt),
      ),
      evidence: { requestId: 'lookup', status: 200, contentHash: '7'.repeat(64), observedAt: intent.createdAt },
    }
    const session = verifiedSession({
      read: {
        orderById: (value) => {
          lookups.push(`id:${value}`)
          return Effect.succeed(readResult)
        },
        orderByClientId: (value) => {
          lookups.push(`client:${value}`)
          return Effect.succeed(readResult)
        },
      },
    })
    const client = HttpClient.make(() => Effect.die(new Error('lookup delegation must not use mutation HTTP I/O')))

    await Effect.runPromise(
      withMutation(
        client,
        (mutation) => Effect.all([mutation.orderById!(orderId), mutation.orderByClientId!(intent.clientOrderId)]),
        { session },
      ),
    )

    expect(lookups).toEqual([`id:${orderId}`, `client:${intent.clientOrderId}`])
  })

  test('submits the exact IO_STARTED intent once and verifies the accepted order', async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = []
    const client = HttpClient.make((request, url) => {
      requests.push({ body: requestBody(request), method: request.method, url: url.toString() })
      return Effect.succeed(response(request, orderResponse))
    })

    const receipt = await Effect.runPromise(withMutation(client, (mutation) => mutation.submit(intent)))

    const body = {
      symbol: 'AMD',
      qty: '1.25',
      side: 'buy',
      type: 'limit',
      time_in_force: 'day',
      limit_price: '160',
      client_order_id: intent.clientOrderId,
      extended_hours: true,
    }
    expect(requests).toEqual([{ body, method: 'POST', url: 'https://paper-api.alpaca.markets/v2/orders' }])
    expect(receipt).toMatchObject({
      requestHash: Result.getOrThrow(canonicalHashV1Result(body)),
      order: {
        accountId,
        brokerOrderId: orderId,
        clientOrderId: intent.clientOrderId,
        status: OrderStatus.Accepted,
        quantityAtoms: intent.quantityAtoms,
      },
      evidence: {
        requestId: 'req-123',
        status: 200,
        contentHash: Result.getOrThrow(canonicalHashV1Result(orderResponse)),
      },
    })
  })

  test('rejects Alpaca confirmation using a retired BUY notional', async () => {
    const requests: unknown[] = []
    const client = HttpClient.make((request) => {
      requests.push(requestBody(request))
      return Effect.succeed(response(request, { ...orderResponse, qty: null, notional: '200' }))
    })
    const failure = await Effect.runPromise(Effect.flip(withMutation(client, (mutation) => mutation.submit(intent))))
    expect(requests).toEqual([Result.getOrThrow(orderRequestBody(intent))])
    expect(failure).toMatchObject({
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      brokerOrderId: orderId,
    })
  })

  test('submits a SELL as an exact quantity LIMIT order and verifies the accepted order', async () => {
    const sellIntent = { ...intent, side: OrderSide.Sell }
    const requests: Array<{ body: unknown; method: string; url: string }> = []
    const client = HttpClient.make((request, url) => {
      requests.push({ body: requestBody(request), method: request.method, url: url.toString() })
      return Effect.succeed(
        response(request, {
          ...orderResponse,
          notional: null,
          qty: '1.25',
          side: 'sell',
        }),
      )
    })

    const receipt = await Effect.runPromise(withMutation(client, (mutation) => mutation.submit(sellIntent)))

    const body = {
      symbol: 'AMD',
      qty: '1.25',
      side: 'sell',
      type: 'limit',
      time_in_force: 'day',
      limit_price: '160',
      client_order_id: intent.clientOrderId,
      extended_hours: true,
    }
    expect(requests).toEqual([{ body, method: 'POST', url: 'https://paper-api.alpaca.markets/v2/orders' }])
    expect(receipt).toMatchObject({
      requestHash: Result.getOrThrow(canonicalHashV1Result(body)),
      order: {
        accountId,
        brokerOrderId: orderId,
        clientOrderId: intent.clientOrderId,
        status: OrderStatus.Accepted,
        quantityAtoms: intent.quantityAtoms,
      },
    })
  })

  test('submits a whole-share LIMIT/DAY at the exact durable quote boundary', async () => {
    const limitIntent = {
      ...intent,
      orderType: OrderType.Limit as const,
      timeInForce: TimeInForce.Day as const,
      quantityAtoms: '3000000000',
      notionalLimitMicros: '303690000',
      limitPriceMicros: '101230000',
    }
    const requests: unknown[] = []
    const accepted = {
      ...orderResponse,
      notional: null,
      qty: '3',
      order_type: 'limit',
      type: 'limit',
      time_in_force: 'day',
      limit_price: '101.23',
      extended_hours: true,
    }
    const client = HttpClient.make((request) => {
      requests.push(requestBody(request))
      return Effect.succeed(response(request, accepted))
    })

    const receipt = await Effect.runPromise(withMutation(client, (mutation) => mutation.submit(limitIntent)))

    expect(requests).toEqual([
      {
        symbol: 'AMD',
        qty: '3',
        side: 'buy',
        type: 'limit',
        time_in_force: 'day',
        limit_price: '101.23',
        client_order_id: intent.clientOrderId,
        extended_hours: true,
      },
    ])
    expect(receipt).toMatchObject({
      requestHash: Result.getOrThrow(canonicalHashV1Result(requests[0])),
      order: {
        orderType: 'limit',
        timeInForce: 'day',
        quantityAtoms: '3000000000',
        limitPriceMicros: '101230000',
      },
    })
  })

  test('treats an accepted LIMIT/DAY at a different price as an unknown broker outcome', async () => {
    const limitIntent = {
      ...intent,
      orderType: OrderType.Limit as const,
      timeInForce: TimeInForce.Day as const,
      quantityAtoms: '3000000000',
      notionalLimitMicros: '303690000',
      limitPriceMicros: '101230000',
    }
    const mismatched = {
      ...orderResponse,
      notional: null,
      qty: '3',
      order_type: 'limit',
      type: 'limit',
      time_in_force: 'day',
      limit_price: '101.24',
    }
    const client = HttpClient.make((request) => Effect.succeed(response(request, mismatched)))

    const failure = await Effect.runPromise(
      Effect.flip(withMutation(client, (mutation) => mutation.submit(limitIntent))),
    )

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      brokerOrderId: orderId,
    })
  })

  test('rejects a wrong-account intent before making a mutation request', async () => {
    let mutationRequests = 0
    const client = HttpClient.make(() => {
      mutationRequests += 1
      return Effect.die(new Error('wrong-account intent must not make a mutation request'))
    })
    const wrongAccountIntent = {
      ...intent,
      accountId: '40b22fc4-23bc-446c-bf07-bea43b5d6c35',
    }

    const failure = await Effect.runPromise(
      Effect.flip(withMutation(client, (mutation) => mutation.submit(wrongAccountIntent))),
    )

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.InvalidRequest,
      outcome: MutationOutcome.Known,
      message: 'order intent account does not match the configured Alpaca account',
    })
    expect(mutationRequests).toBe(0)
  })

  test('samples submit evidence after the complete response body', async () => {
    let releaseBody: () => void = () => {
      throw new Error('submit response body reader did not start')
    }
    const client = HttpClient.make((request) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseBody = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(orderResponse)))
            controller.close()
          }
        },
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status: 200, headers: responseHeaders })),
      )
    })

    const program = withMutation(
      client,
      (mutation) =>
        Effect.gen(function* () {
          const fiber = yield* mutation.submit(intent).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(2_000)
          releaseBody()
          return yield* Fiber.join(fiber)
        }),
      { operationTimeoutMs: 5_000 },
    ).pipe((self) => provideTestLayer(self, TestClock.layer()))

    const receipt = await Effect.runPromise(program)
    expect(receipt.evidence.observedAt).toBe('1970-01-01T00:00:02.000Z')
    expect(receipt.order.observedAt).toBe('1970-01-01T00:00:02.000Z')
  })

  test('preserves the broker order ID when Alpaca accepts a mismatched order', async () => {
    const mismatched = { ...orderResponse, symbol: 'NVDA' }
    const client = HttpClient.make((request) => Effect.succeed(response(request, mismatched)))

    const failure = await Effect.runPromise(Effect.flip(withMutation(client, (mutation) => mutation.submit(intent))))

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      brokerOrderId: orderId,
      evidence: {
        status: 200,
        requestId: 'req-123',
        contentHash: Result.getOrThrow(canonicalHashV1Result(mismatched)),
      },
    })
  })

  test('fails before I/O for invalid state, order constraints, or malformed intent data', async () => {
    let calls = 0
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(response(request, orderResponse))
    })
    const approved = { ...intent, state: IntentState.Approved }
    const invalidPrice = { ...intent, limitPriceMicros: '0' }
    const invalidNotional = { ...intent, notionalLimitMicros: '1' }
    const malformed = { ...intent, quantityAtoms: 'not-micros' }

    const failures = await Effect.runPromise(
      Effect.all([
        Effect.flip(withMutation(client, (mutation) => mutation.submit(approved))),
        Effect.flip(withMutation(client, (mutation) => mutation.submit(invalidPrice))),
        Effect.flip(withMutation(client, (mutation) => mutation.submit(invalidNotional))),
        Effect.flip(withMutation(client, (mutation) => mutation.submit(malformed))),
      ]),
    )

    expect(failures).toEqual([
      expect.objectContaining({ failure: MutationFailure.InvalidRequest, outcome: MutationOutcome.Known }),
      expect.objectContaining({ failure: MutationFailure.InvalidRequest, outcome: MutationOutcome.Known }),
      expect.objectContaining({ failure: MutationFailure.InvalidRequest, outcome: MutationOutcome.Known }),
      expect.objectContaining({ failure: MutationFailure.InvalidRequest, outcome: MutationOutcome.Known }),
    ])
    expect(calls).toBe(0)
  })

  test('classifies malformed accepted and rejected responses as UNKNOWN with exact evidence', async () => {
    const malformedAccepted = { ...orderResponse, qty: null, notional: null }
    const malformedRejected = { message: 'missing broker code' }
    let calls = 0
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(
        calls === 1 ? response(request, malformedAccepted) : response(request, malformedRejected, 422),
      )
    })

    const acceptedFailure = await Effect.runPromise(
      Effect.flip(withMutation(client, (mutation) => mutation.submit(intent))),
    )
    const rejectedFailure = await Effect.runPromise(
      Effect.flip(withMutation(client, (mutation) => mutation.submit(intent))),
    )

    expect(acceptedFailure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      message: 'Alpaca submit response violates the order contract',
      evidence: {
        status: 200,
        requestId: 'req-123',
        contentHash: Result.getOrThrow(canonicalHashV1Result(malformedAccepted)),
      },
    })
    expect(rejectedFailure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      message: 'Alpaca submit error response is invalid',
      evidence: {
        status: 422,
        requestId: 'req-123',
        contentHash: Result.getOrThrow(canonicalHashV1Result(malformedRejected)),
      },
    })
    expect(calls).toBe(2)
  })

  test('classifies a decoded 422 as a known rejection and never retries', async () => {
    let calls = 0
    const error = { code: 40310000, message: 'insufficient buying power' }
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(response(request, error, 422))
    })

    const failure = await Effect.runPromise(Effect.flip(withMutation(client, (mutation) => mutation.submit(intent))))

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Rejected,
      outcome: MutationOutcome.Known,
      brokerCode: '40310000',
      evidence: { status: 422, requestId: 'req-123', contentHash: Result.getOrThrow(canonicalHashV1Result(error)) },
    })
    expect(calls).toBe(1)
  })

  test('interrupts a timed-out submit and reports UNKNOWN without retry', async () => {
    let calls = 0
    let interrupted = false
    let invalidations = 0
    const session = projectedSession(
      () =>
        Effect.sync(() => {
          invalidations += 1
        }),
      10,
    )
    const client = HttpClient.make(() => {
      calls += 1
      return Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      )
    })

    const program = makeMutation(session, submitAuthority, client).pipe(
      Effect.flatMap((mutation) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.flip(mutation.submit(intent)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(10)
          return yield* Fiber.join(fiber)
        }),
      ),
      (self) => provideTestLayer(self, TestClock.layer()),
    )

    const failure = await Effect.runPromise(program)
    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
    })
    expect(calls).toBe(1)
    expect(interrupted).toBe(true)
    expect(invalidations).toBe(2)
  })

  test('redacts credentials from an ambiguous submit transport failure', async () => {
    let calls = 0
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: 'connection refused for paper-key and paper-secret',
          }),
        }),
      )
    })

    const failure = await Effect.runPromise(Effect.flip(withMutation(client, (mutation) => mutation.submit(intent))))

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      cause: { tag: 'HttpClientError', reason: 'TransportError' },
    })
    expect(JSON.stringify(failure)).not.toContain('paper-key')
    expect(JSON.stringify(failure)).not.toContain('paper-secret')
    expect(calls).toBe(1)
  })

  test('applies the mutation deadline while the broker response body is still streaming', async () => {
    let calls = 0
    const client = HttpClient.make((request) => {
      calls += 1
      const body = new ReadableStream<Uint8Array>({ start: () => undefined })
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status: 200, headers: responseHeaders })),
      )
    })

    const program = makeMutation(verifiedSession({ operationTimeoutMs: 10 }), submitAuthority, client).pipe(
      Effect.flatMap((mutation) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.flip(mutation.submit(intent)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(10)
          return yield* Fiber.join(fiber)
        }),
      ),
      (self) => provideTestLayer(self, TestClock.layer()),
    )

    const failure = await Effect.runPromise(program)
    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
    })
    expect(calls).toBe(1)
  })

  test('propagates external interruption and finalizes an in-flight submit exactly once', async () => {
    let calls = 0
    let invalidations = 0
    const finalizations = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finalized = yield* Ref.make(0)
        const client = HttpClient.make(() => {
          calls += 1
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Ref.update(finalized, (count) => count + 1)),
          )
        })
        const session = projectedSession(() =>
          Effect.sync(() => {
            invalidations += 1
          }),
        )
        const mutation = yield* makeMutation(session, submitAuthority, client)
        const fiber = yield* mutation.submit(intent).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return yield* Ref.get(finalized)
      }),
    )

    expect(calls).toBe(1)
    expect(finalizations).toBe(1)
    expect(invalidations).toBe(2)
  })

  test('cancels a positively identified order once; every non-204 result requires lookup', async () => {
    let status = 204
    const requests: Array<{ method: string; url: string }> = []
    const client = HttpClient.make((request, url) => {
      requests.push({ method: request.method, url: url.toString() })
      return Effect.succeed(response(request, { code: 500, message: 'unknown' }, status))
    })

    const receipt = await Effect.runPromise(withMutation(client, (mutation) => mutation.cancel(orderId)))
    expect(receipt).toMatchObject({
      brokerOrderId: orderId,
      evidence: { status: 204, requestId: 'req-123', contentHash: Result.getOrThrow(canonicalHashV1Result(null)) },
    })

    status = 500
    const failure = await Effect.runPromise(Effect.flip(withMutation(client, (mutation) => mutation.cancel(orderId))))
    expect(failure).toMatchObject({
      operation: MutationOperation.Cancel,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      evidence: {
        status: 500,
        requestId: 'req-123',
        contentHash: Result.getOrThrow(canonicalHashV1Result({ code: 500, message: 'unknown' })),
      },
    })
    expect(requests).toEqual([
      { method: 'DELETE', url: `https://paper-api.alpaca.markets/v2/orders/${orderId}` },
      { method: 'DELETE', url: `https://paper-api.alpaca.markets/v2/orders/${orderId}` },
    ])
  })

  test('rejects an invalid cancel target before DELETE I/O', async () => {
    let calls = 0
    const client = HttpClient.make(() => {
      calls += 1
      return Effect.die(new Error('invalid cancel target must not make a mutation request'))
    })

    const failure = await Effect.runPromise(
      Effect.flip(withMutation(client, (mutation) => mutation.cancel('../orders/all'))),
    )

    expect(failure).toMatchObject({
      operation: MutationOperation.Cancel,
      failure: MutationFailure.InvalidRequest,
      outcome: MutationOutcome.Known,
      message: 'invalid Alpaca order ID',
    })
    expect(calls).toBe(0)
  })

  test('samples ambiguous cancel evidence after the complete response body', async () => {
    const error = { code: 50010000, message: 'unknown' }
    let releaseBody: () => void = () => {
      throw new Error('cancel response body reader did not start')
    }
    const client = HttpClient.make((request) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseBody = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(error)))
            controller.close()
          }
        },
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status: 500, headers: responseHeaders })),
      )
    })

    const program = withMutation(
      client,
      (mutation) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.flip(mutation.cancel(orderId)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(2_000)
          releaseBody()
          return yield* Fiber.join(fiber)
        }),
      { operationTimeoutMs: 5_000 },
    ).pipe((self) => provideTestLayer(self, TestClock.layer()))

    const failure = await Effect.runPromise(program)
    expect(failure).toMatchObject({
      operation: MutationOperation.Cancel,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      evidence: {
        contentHash: Result.getOrThrow(canonicalHashV1Result(error)),
        observedAt: '1970-01-01T00:00:02.000Z',
        requestId: 'req-123',
        status: 500,
      },
    })
  })

  test('hashes a non-JSON cancel response as exact raw text', async () => {
    const body = 'upstream unavailable\n'
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status: 502, headers: responseHeaders })),
      ),
    )

    const failure = await Effect.runPromise(Effect.flip(withMutation(client, (mutation) => mutation.cancel(orderId))))

    expect(failure).toMatchObject({
      operation: MutationOperation.Cancel,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      evidence: {
        contentHash: Result.getOrThrow(canonicalHashV1Result(body)),
        requestId: 'req-123',
        status: 502,
      },
    })
  })

  test('falls back to exact raw cancel text when valid JSON decodes to a non-canonical value', async () => {
    const body = '1e400'
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status: 502, headers: responseHeaders })),
      ),
    )

    const failure = await Effect.runPromise(Effect.flip(withMutation(client, (mutation) => mutation.cancel(orderId))))

    expect(failure).toMatchObject({
      operation: MutationOperation.Cancel,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      evidence: {
        contentHash: Result.getOrThrow(canonicalHashV1Result(body)),
        requestId: 'req-123',
        status: 502,
      },
    })
  })
})
