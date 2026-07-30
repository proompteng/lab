import { describe, expect, test } from 'bun:test'

import { Clock, Deferred, Effect, Fiber, Layer, Logger, Redacted, Ref, References, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { alpacaSandboxBaseUrl, decodeBrokerConnection } from '../connection'
import { BrokerEnvironment, BrokerProvider } from '../identity'
import { BrokerReadError, BrokerReadErrorKind } from './failures'
import { AccountStatus, BrokerRead } from './model'
import {
  BrokerSession,
  BrokerSessionAcquisitionError,
  BrokerSessionAcquisitionStage,
  acquireBrokerSession,
  layer,
  retryRecoverableBrokerSessionAcquisition,
} from './session'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const key = 'paper-key-session-retry-secret'
const secret = 'paper-secret-session-retry-secret'

const accountResponse = {
  id: accountId,
  account_number: '010203ABCD',
  status: 'ACTIVE',
  currency: 'USD',
  cash: '100000.00',
  equity: '100000.00',
  last_equity: '100000.00',
  buying_power: '200000.00',
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

const connection = (retryAttempts: number) =>
  Result.getOrThrow(
    decodeBrokerConnection({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      expectedAccountId: accountId,
      key: Redacted.make(key),
      secret: Redacted.make(secret),
      proxyUrl: 'http://bayn-egress-proxy:3128',
      operationTimeoutMs: 30_000,
      retryAttempts,
    }),
  )

const responseHeaders = (requestId: string) => ({
  'content-type': 'application/json',
  'x-request-id': requestId,
  'x-ratelimit-limit': '200',
  'x-ratelimit-remaining': '199',
  'x-ratelimit-reset': '1784664000',
})

const jsonResponse = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  body: unknown,
  requestId: string,
  status = 200,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: responseHeaders(requestId),
    }),
  )

const completePreflightResponse = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  url: URL,
  requestId: string,
) => {
  if (url.pathname === '/v2/account') return jsonResponse(request, accountResponse, requestId)
  if (url.pathname === '/v2/account/configurations') {
    return jsonResponse(request, accountConfigurationResponse, requestId)
  }
  if (
    url.pathname === '/v2/positions' ||
    url.pathname === '/v2/orders' ||
    url.pathname === '/v2/account/activities/FILL' ||
    url.pathname === '/v2/calendar'
  ) {
    return jsonResponse(request, [], requestId)
  }
  return jsonResponse(request, { code: 40410000, message: 'order not found' }, requestId, 404)
}

describe('Alpaca broker session acquisition retry', () => {
  test('re-runs the complete preflight after request retry exhaustion and publishes one frozen verified session', async () => {
    const options = connection(1)
    let requests = 0
    let accountRequests = 0
    const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
    const logger = Logger.make<unknown, void>((entry) => {
      logs.push({
        message: entry.message,
        annotations: { ...entry.fiber.getRef(References.CurrentLogAnnotations) },
      })
    })
    const client = HttpClient.make((request, url) => {
      requests += 1
      if (url.pathname === '/v2/account') {
        accountRequests += 1
        if (accountRequests <= 2) {
          return Effect.succeed(
            jsonResponse(request, { code: 50010000, message: 'temporary account failure' }, `req-${requests}`, 500),
          )
        }
      }
      return Effect.succeed(completePreflightResponse(request, url, `req-${requests}`))
    })
    const testLayer = layer(options).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))

    const services = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.all({ session: BrokerSession, read: BrokerRead }).pipe(
          Effect.provide(testLayer),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Effect.yieldNow
        expect(accountRequests).toBe(2)
        yield* TestClock.adjust(1_000)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Logger.layer([logger])), Effect.provide(TestClock.layer())),
    )

    expect(services.session.read).toBe(services.read)
    expect(Object.isFrozen(services.session)).toBe(true)
    expect(services.session.connection).toBe(options)
    expect(services.session.preflight).toMatchObject({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      accountId,
      accountStatus: AccountStatus.Active,
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
      fractionalTrading: true,
      orderById: 'NOT_FOUND',
      orderByClientId: 'NOT_FOUND',
    })
    expect(accountRequests).toBe(3)
    expect(requests).toBe(11)
    const renderedLogs = JSON.stringify(logs)
    expect(renderedLogs).not.toContain(key)
    expect(renderedLogs).not.toContain(secret)
    expect(renderedLogs).not.toContain(accountId)
    expect(renderedLogs).not.toContain(accountResponse.account_number)
    expect(logs).toContainEqual(
      expect.objectContaining({
        annotations: expect.objectContaining({
          accountHash: services.session.preflight.accountHash,
        }),
      }),
    )
  })

  test('attempts a deterministic account mismatch once and preserves its typed stage without credentials', async () => {
    const options = connection(2)
    const wrongAccountId = '8f2a5d40-3a43-4e80-9ef0-4b8a4db1d276'
    let requests = 0
    const client = HttpClient.make((request) => {
      requests += 1
      return Effect.succeed(jsonResponse(request, { ...accountResponse, id: wrongAccountId }, `req-${requests}`))
    })

    const failure = await Effect.runPromise(
      Effect.flip(
        acquireBrokerSession(options).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(TestClock.layer()),
        ),
      ),
    )

    expect(requests).toBe(1)
    expect(failure).toBeInstanceOf(BrokerSessionAcquisitionError)
    expect(failure).toMatchObject({
      stage: BrokerSessionAcquisitionStage.Account,
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      expectedAccountId: accountId,
      cause: {
        operation: 'account',
        kind: BrokerReadErrorKind.AccountMismatch,
        retryable: false,
        requestId: 'req-1',
      },
    })
    expect(JSON.stringify(failure)).not.toContain(key)
    expect(JSON.stringify(failure)).not.toContain(secret)
  })

  test('bounds whole-session retry exhaustion and returns the final typed read failure', async () => {
    const options = connection(2)
    let requests = 0
    const client = HttpClient.make((request) => {
      requests += 1
      return Effect.succeed(
        jsonResponse(request, { code: 50010000, message: 'temporary account failure' }, `req-${requests}`, 500),
      )
    })

    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.flip(
          acquireBrokerSession(options).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(requests).toBe(3)
        yield* TestClock.adjust(1_000)
        expect(requests).toBe(6)
        yield* TestClock.adjust(1_000)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(requests).toBe(9)
    expect(failure).toMatchObject({
      stage: BrokerSessionAcquisitionStage.Account,
      cause: {
        operation: 'account',
        kind: BrokerReadErrorKind.Server,
        retryable: true,
        status: 500,
        requestId: 'req-9',
      },
    })
    expect(JSON.stringify(failure)).not.toContain(key)
    expect(JSON.stringify(failure)).not.toContain(secret)
  })

  test('does not start a late whole-session retry after the bounded startup retry window closes', async () => {
    const options = connection(2)
    let requests = 0
    const client = HttpClient.make((request) => {
      requests += 1
      const requestId = `req-${requests}`
      return Effect.sleep(6_000).pipe(
        Effect.as(jsonResponse(request, { code: 50010000, message: 'slow temporary failure' }, requestId, 500)),
      )
    })

    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.flip(
          acquireBrokerSession(options).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(requests).toBe(1)
        yield* TestClock.adjust(6_000)
        expect(requests).toBe(2)
        yield* TestClock.adjust(6_000)
        expect(requests).toBe(3)
        yield* TestClock.adjust(6_000)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(requests).toBe(3)
    expect(failure).toMatchObject({
      stage: BrokerSessionAcquisitionStage.Account,
      cause: {
        operation: 'account',
        kind: BrokerReadErrorKind.Server,
        retryable: true,
        requestId: 'req-3',
      },
    })
  })

  test('does not start a retry when delayed wake-up crosses the bounded startup retry deadline', async () => {
    const options = connection(1)
    let attempts = 0
    let clockReads = 0
    const clockTimes = [0, 0, 6_000] as const
    const readTime = () => clockTimes[Math.min(clockReads++, clockTimes.length - 1)]
    const currentTime = () => clockTimes[Math.min(clockReads, clockTimes.length - 1)]
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: readTime,
      currentTimeMillis: Effect.sync(readTime),
      currentTimeNanosUnsafe: () => BigInt(currentTime()) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(currentTime()) * 1_000_000n),
      sleep: () => Effect.succeed(undefined),
    }
    const cause = new BrokerReadError({
      operation: 'account',
      kind: BrokerReadErrorKind.Server,
      message: 'temporary account failure',
      retryable: true,
      status: 500,
      requestId: 'req-1',
    })
    const acquisitionFailure = new BrokerSessionAcquisitionError({
      stage: BrokerSessionAcquisitionStage.Account,
      provider: options.provider,
      environment: options.environment,
      baseUrl: options.baseUrl,
      expectedAccountId: options.expectedAccountId,
      cause,
    })
    const acquisition = Effect.sync(() => {
      attempts += 1
    }).pipe(Effect.andThen(Effect.fail(acquisitionFailure)))

    const failure = await Effect.runPromise(
      Effect.flip(retryRecoverableBrokerSessionAcquisition(options, acquisition)).pipe(
        Effect.provideService(Clock.Clock, clock),
      ),
    )

    expect(attempts).toBe(1)
    expect(failure).toBe(acquisitionFailure)
  })

  test('propagates interruption and finalizes the in-flight read exactly once without retrying', async () => {
    const options = connection(2)
    let requests = 0
    const finalizations = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finalized = yield* Ref.make(0)
        const client = HttpClient.make(() => {
          requests += 1
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Ref.update(finalized, (count) => count + 1)),
          )
        })
        const fiber = yield* acquireBrokerSession(options).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return yield* Ref.get(finalized)
      }),
    )

    expect(requests).toBe(1)
    expect(finalizations).toBe(1)
  })
})
