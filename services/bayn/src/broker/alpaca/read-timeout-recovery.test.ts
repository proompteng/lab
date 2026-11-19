import { expect, test } from 'bun:test'
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Logger, Option, Redacted, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { alpacaSandboxBaseUrl, decodeBrokerConnection } from '../connection'
import { BrokerEnvironment, BrokerProvider } from '../identity'
import { BrokerReadErrorKind } from './failures'
import { make } from './http'
import { makeBrokerObservationBudget } from './poll-budget'

const connection = Result.getOrThrow(
  decodeBrokerConnection({
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: 'e6fe16f3-64a4-4921-8928-cadf02f92f98',
    key: Redacted.make('private-read-key'),
    secret: Redacted.make('private-read-secret'),
    proxyUrl: 'http://bayn-egress-proxy:3128',
    operationTimeoutMs: 30_000,
    retryAttempts: 2,
  }),
)

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>, client: HttpClient.HttpClient) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([])),
    ),
  )

test('cancels a stuck header attempt and retries the read before the observation freshness budget expires', async () => {
  let calls = 0
  let canceled = 0
  await run(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const budget = yield* makeBrokerObservationBudget
      yield* budget.beginCapture
      const startedAt = yield* Clock.currentTimeMillis
      const client = HttpClient.make((request) => {
        calls++
        if (calls === 1)
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => canceled++)),
          )
        expect(canceled).toBe(1)
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response('{"fractional_trading":true,"no_shorting":false}', {
              headers: { 'x-request-id': 'successful-retry' },
            }),
          ),
        )
      })
      const broker = yield* make(connection).pipe(Effect.provideService(HttpClient.HttpClient, budget.decorate(client)))
      const pending = yield* broker.accountConfiguration.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      yield* TestClock.adjust(4_999)
      expect(calls).toBe(1)
      expect(canceled).toBe(0)
      yield* TestClock.adjust(1)
      expect(calls).toBe(2)
      const result = yield* Fiber.join(pending)
      expect(result.value.noShorting).toBe(false)
      expect(result.evidence).toMatchObject({ status: 200, requestId: 'successful-retry' })
      expect(result.evidence.contentHash).toMatch(/^[a-f0-9]{64}$/)
      expect(canceled).toBe(1)
      expect(yield* budget.nextPollNotBeforeMs).toBe(startedAt + 1_200)
    }),
    HttpClient.make(() => Effect.die('test must provide its own client')),
  )
})

test('exhausts only the configured header retries and cancels every stuck attempt', async () => {
  let calls = 0
  let canceled = 0
  const client = HttpClient.make(() => {
    calls++
    return Effect.never.pipe(Effect.ensuring(Effect.sync(() => canceled++)))
  })
  await run(
    Effect.gen(function* () {
      const broker = yield* make(connection)
      const pending = yield* broker.accountConfiguration.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(calls).toBe(attempt)
        yield* TestClock.adjust(5_000)
      }
      const result = yield* Fiber.join(pending)
      if (Exit.isSuccess(result)) throw new Error('exhausted reads cannot succeed')
      expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({
        operation: 'account-configuration',
        kind: BrokerReadErrorKind.Transport,
        retryable: true,
      })
      expect(calls).toBe(3)
      expect(canceled).toBe(3)
    }),
    client,
  )
})

test('the whole-read deadline cancels a retry and prevents a later attempt', async () => {
  let calls = 0
  let canceled = 0
  const client = HttpClient.make(() => {
    calls++
    return Effect.never.pipe(Effect.ensuring(Effect.sync(() => canceled++)))
  })
  await run(
    Effect.gen(function* () {
      const broker = yield* make({ ...connection, operationTimeoutMs: 6_000 })
      const pending = yield* broker.accountConfiguration.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(5_000)
      expect(calls).toBe(2)
      yield* TestClock.adjust(1_000)
      const result = yield* Fiber.join(pending)
      if (Exit.isSuccess(result)) throw new Error('read exceeded its whole-operation budget')
      expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({
        kind: BrokerReadErrorKind.Timeout,
        message: 'Alpaca account-configuration exceeded its 6000ms deadline',
      })
      expect(calls).toBe(2)
      expect(canceled).toBe(2)
    }),
    client,
  )
})

test.each([
  {
    name: 'authentication',
    status: 401,
    body: '{"code":40110000,"message":"denied"}',
    kind: BrokerReadErrorKind.Authentication,
  },
  {
    name: 'malformed success',
    status: 200,
    body: '{"fractional_trading":"invalid"}',
    kind: BrokerReadErrorKind.InvalidResponse,
  },
])('does not retry a $name rejection', async ({ status, body, kind }) => {
  let calls = 0
  const client = HttpClient.make((request) => {
    calls++
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(body, { status, headers: { 'x-request-id': 'rejection' } })),
    )
  })
  await run(
    Effect.gen(function* () {
      const broker = yield* make(connection)
      const result = yield* broker.accountConfiguration.pipe(Effect.exit)
      if (Exit.isSuccess(result)) throw new Error('rejected read succeeded')
      expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({ kind, retryable: false })
      expect(calls).toBe(1)
    }),
    client,
  )
})

test('caller interruption aborts a stuck read without retrying', async () => {
  let calls = 0
  let canceled = 0
  const client = HttpClient.make(() => {
    calls++
    return Effect.never.pipe(Effect.ensuring(Effect.sync(() => canceled++)))
  })
  await run(
    Effect.gen(function* () {
      const broker = yield* make(connection)
      const pending = yield* broker.accountConfiguration.pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(1_000)
      yield* Fiber.interrupt(pending)
      yield* TestClock.adjust(30_000)
      expect(calls).toBe(1)
      expect(canceled).toBe(1)
    }),
    client,
  )
})
