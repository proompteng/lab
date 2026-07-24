import { describe, expect, test } from 'bun:test'

import { Effect, Fiber, Redacted } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { canonicalHashV1 } from '../hash'
import { Authority, IntentState, MutationOutcome, OrderSide, OrderType, TimeInForce, type Intent } from '../paper'
import {
  BrokerMutationError,
  MutationFailure,
  MutationOperation,
  makeMutation,
  type BrokerMutationShape,
  type MutationOptions,
} from './alpaca-mutations'
import { OrderStatus } from './alpaca'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const orderId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const assetId = 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415'

const accountResponse = {
  id: accountId,
  account_number: '010203ABCD',
  status: 'ACTIVE',
  currency: 'USD',
  cash: '100000',
  equity: '100000',
  buying_power: '200000',
  account_blocked: false,
  trading_blocked: false,
  trade_suspended_by_user: false,
}

const options: MutationOptions = {
  expectedAccountId: accountId,
  maximumAuthority: Authority.Paper,
  key: Redacted.make('paper-key'),
  secret: Redacted.make('paper-secret'),
  proxyUrl: 'http://bayn-egress-proxy:3128',
  operationTimeoutMs: 1_000,
}

const intent: Intent = {
  schemaVersion: 'bayn.paper-intent.v2',
  intentId: 'a'.repeat(64),
  riskDecisionId: 'b'.repeat(64),
  strategyName: 'risk-balanced-trend',
  cycleId: 'c'.repeat(64),
  decisionHash: 'd'.repeat(64),
  policyHash: 'e'.repeat(64),
  accountId,
  clientOrderId: `b1_${'A'.repeat(43)}`,
  symbol: 'AMD',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: '1250000',
  notionalLimitMicros: '200000000',
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

const withVerifiedAccount = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.make((request, url) =>
    url.pathname === '/v2/account' ? Effect.succeed(response(request, accountResponse)) : client.execute(request),
  )

const withMutation = <A, E>(
  client: HttpClient.HttpClient,
  use: (mutation: BrokerMutationShape) => Effect.Effect<A, E>,
  mutationOptions: MutationOptions = options,
): Effect.Effect<A, BrokerMutationError | E> => {
  return makeMutation(mutationOptions).pipe(
    Effect.flatMap(use),
    Effect.provideService(HttpClient.HttpClient, withVerifiedAccount(client)),
  )
}

const requestBody = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]): unknown => {
  if (request.body._tag !== 'Uint8Array') throw new Error('expected a JSON request body')
  return JSON.parse(new TextDecoder().decode(request.body.body))
}

describe('Alpaca paper mutations', () => {
  test('refuses to construct mutation capability below explicit PAPER authority', async () => {
    let requests = 0
    const client = HttpClient.make(() => {
      requests += 1
      return Effect.die(new Error('OBSERVE must not make a broker request through the mutation constructor'))
    })

    const failure = await Effect.runPromise(
      Effect.flip(
        makeMutation({ ...options, maximumAuthority: Authority.Observe }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      ),
    )

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Configuration,
      outcome: MutationOutcome.Known,
      message: 'Alpaca mutation capability requires explicit PAPER maximum authority',
    })
    expect(requests).toBe(0)
  })

  test('refuses to expose mutation capability when the credentials resolve a different account', async () => {
    let mutationCalls = 0
    const client = HttpClient.make(() => {
      mutationCalls += 1
      return Effect.die(new Error('mutation request must not run'))
    })
    const wrongAccount = '40b22fc4-23bc-446c-bf07-bea43b5d6c35'

    const failure = await Effect.runPromise(
      Effect.flip(withMutation(client, () => Effect.void, { ...options, expectedAccountId: wrongAccount })),
    )

    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Configuration,
      outcome: MutationOutcome.Known,
    })
    expect(mutationCalls).toBe(0)
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
      type: 'market',
      time_in_force: 'day',
      client_order_id: intent.clientOrderId,
      extended_hours: false,
    }
    expect(requests).toEqual([{ body, method: 'POST', url: 'https://paper-api.alpaca.markets/v2/orders' }])
    expect(receipt).toMatchObject({
      requestHash: canonicalHashV1(body),
      order: {
        accountId,
        brokerOrderId: orderId,
        clientOrderId: intent.clientOrderId,
        status: OrderStatus.Accepted,
        quantityMicros: intent.quantityMicros,
      },
      evidence: {
        requestId: 'req-123',
        status: 200,
        contentHash: canonicalHashV1(orderResponse),
      },
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
      { ...options, operationTimeoutMs: 5_000 },
    ).pipe(Effect.provide(TestClock.layer()))

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
      evidence: { status: 200, requestId: 'req-123', contentHash: canonicalHashV1(mismatched) },
    })
  })

  test('fails before I/O for an unmarked intent or unsupported fractional GTC order', async () => {
    let calls = 0
    const client = HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(response(request, orderResponse))
    })
    const approved = { ...intent, state: IntentState.Approved }
    const fractionalGtc = { ...intent, timeInForce: TimeInForce.GoodUntilCanceled }

    const failures = await Effect.runPromise(
      Effect.all([
        Effect.flip(withMutation(client, (mutation) => mutation.submit(approved))),
        Effect.flip(withMutation(client, (mutation) => mutation.submit(fractionalGtc))),
      ]),
    )

    expect(failures).toEqual([
      expect.objectContaining({ failure: MutationFailure.InvalidRequest, outcome: MutationOutcome.Known }),
      expect.objectContaining({ failure: MutationFailure.InvalidRequest, outcome: MutationOutcome.Known }),
    ])
    expect(calls).toBe(0)
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
      evidence: { status: 422, requestId: 'req-123', contentHash: canonicalHashV1(error) },
    })
    expect(calls).toBe(1)
  })

  test('interrupts a timed-out submit and reports UNKNOWN without retry', async () => {
    let calls = 0
    let interrupted = false
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

    const program = makeMutation({ ...options, operationTimeoutMs: 10 }).pipe(
      Effect.flatMap((mutation) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.flip(mutation.submit(intent)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(10)
          return yield* Fiber.join(fiber)
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, withVerifiedAccount(client)),
      Effect.provide(TestClock.layer()),
    )

    const failure = await Effect.runPromise(program)
    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
    })
    expect(calls).toBe(1)
    expect(interrupted).toBe(true)
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

    const program = makeMutation({ ...options, operationTimeoutMs: 10 }).pipe(
      Effect.flatMap((mutation) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.flip(mutation.submit(intent)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(10)
          return yield* Fiber.join(fiber)
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, withVerifiedAccount(client)),
      Effect.provide(TestClock.layer()),
    )

    const failure = await Effect.runPromise(program)
    expect(failure).toMatchObject({
      operation: MutationOperation.Submit,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
    })
    expect(calls).toBe(1)
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
      evidence: { status: 204, requestId: 'req-123', contentHash: canonicalHashV1(null) },
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
        contentHash: canonicalHashV1({ code: 500, message: 'unknown' }),
      },
    })
    expect(requests).toEqual([
      { method: 'DELETE', url: `https://paper-api.alpaca.markets/v2/orders/${orderId}` },
      { method: 'DELETE', url: `https://paper-api.alpaca.markets/v2/orders/${orderId}` },
    ])
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
      { ...options, operationTimeoutMs: 5_000 },
    ).pipe(Effect.provide(TestClock.layer()))

    const failure = await Effect.runPromise(program)
    expect(failure).toMatchObject({
      operation: MutationOperation.Cancel,
      failure: MutationFailure.Unknown,
      outcome: MutationOutcome.Unknown,
      evidence: {
        contentHash: canonicalHashV1(error),
        observedAt: '1970-01-01T00:00:02.000Z',
        requestId: 'req-123',
        status: 500,
      },
    })
  })
})
