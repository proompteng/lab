import { expect, test } from 'bun:test'
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Metric, Option, Redacted, Result } from 'effect'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http'
import { PrometheusMetrics } from 'effect/observability'
import { TestClock } from 'effect/testing'

import { ExecutionStageTimings, type ExecutionStageTiming } from '../../telemetry'
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
    operationTimeoutMs: 1000,
    retryAttempts: 0,
  }),
)
const read = Effect.flatMap(make(connection), (broker) => broker.accountConfiguration)
const headers = { 'x-request-id': 'private-request-id' }
const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>, client: HttpClient.HttpClient) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provide(Logger.layer([])),
    ),
  )
const sample = (metrics: string, phase: string, outcome: string, statistic = 'count') =>
  Number(
    metrics.match(
      new RegExp(
        `bayn_operation_duration_seconds_${statistic}\\{(?=[^\\n]*stage="bayn.alpaca.read.${phase}")(?=[^\\n]*outcome="${outcome}")(?=[^\\n]*operation="account-configuration")[^\\n]*\\} ([0-9.]+)`,
      ),
    )?.[1] ?? 0,
  )

test.each([
  { phase: 'headers', operationTimeoutMs: 30_000, deadlineMs: 5_000 },
  { phase: 'body', operationTimeoutMs: 30_000, deadlineMs: 5_000 },
  { phase: 'headers', operationTimeoutMs: 1_000, deadlineMs: 1_000 },
  { phase: 'body', operationTimeoutMs: 1_000, deadlineMs: 1_000 },
])(
  'calendar $phase waits cancel within $deadlineMs ms of the whole read',
  async ({ phase, operationTimeoutMs, deadlineMs }) => {
    let finalized = 0
    let calls = 0
    await Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const blocked = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => finalized++)),
      )
      const headerTimeMs = phase === 'body' ? 600 : 0
      const client = HttpClient.make((request) => {
        calls++
        if (phase === 'headers') return blocked
        return TestClock.adjust(headerTimeMs).pipe(
          Effect.map(() =>
            Object.defineProperty(HttpClientResponse.fromWeb(request, new Response('[]', { headers })), 'json', {
              value: blocked,
            }),
          ),
        )
      })
      yield* Effect.gen(function* () {
        const broker = yield* make({ ...connection, operationTimeoutMs })
        const pending = yield* broker
          .marketCalendar({ start: '2026-11-09', end: '2026-11-09' })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        yield* TestClock.adjust(deadlineMs - headerTimeMs - 1)
        expect(finalized).toBe(0)
        yield* TestClock.adjust(1)
        const exit = yield* Fiber.join(pending)
        if (Exit.isSuccess(exit)) throw new Error('calendar unexpectedly exceeded its read budget')
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          operation: 'market-calendar',
          kind: BrokerReadErrorKind.Timeout,
          retryable: true,
          message: `Alpaca market-calendar exceeded its ${deadlineMs}ms deadline`,
        })
        expect(finalized).toBe(1)
        expect(calls).toBe(1)
      }).pipe(Effect.provideService(HttpClient.HttpClient, client))
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([])), Effect.runPromise)
  },
)

test('headers and body timings remain separate and preserve complete response evidence', async () => {
  let calls = 0
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++
      yield* TestClock.adjust(200)
      const response = HttpClientResponse.fromWeb(
        request,
        new Response('{}', {
          headers: { 'x-request-id': 'private-request-id' },
        }),
      )
      return Object.defineProperty(response, 'json', {
        value: TestClock.adjust(300).pipe(Effect.as({ fractional_trading: true })),
      })
    }),
  )
  await run(
    Effect.gen(function* () {
      const result = yield* read
      expect(result.value.fractionalTrading).toBe(true)
      expect(Date.parse(result.evidence.observedAt)).toBe(500)
      expect(result.evidence.contentHash).toMatch(/^[a-f0-9]{64}$/)
      expect(calls).toBe(1)
      const metrics = yield* PrometheusMetrics.format()
      expect(sample(metrics, 'headers', 'succeeded')).toBe(1)
      expect(sample(metrics, 'headers', 'succeeded', 'sum')).toBe(0.2)
      expect(sample(metrics, 'body', 'succeeded')).toBe(1)
      expect(sample(metrics, 'body', 'succeeded', 'sum')).toBe(0.3)
      for (const secret of [
        'private-key',
        'private-secret',
        'private-request-id',
        connection.expectedAccountId,
        'fractional_trading',
        connection.baseUrl,
      ])
        expect(metrics).not.toContain(secret)
    }),
    client,
  )
})

test.each(['headers', 'body'] as const)(
  '%s interruption retains the one-second total deadline and finalizes once',
  async (phase) => {
    let finalized = 0
    let calls = 0
    await Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const blocked = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => finalized++)),
      )
      const client = HttpClient.make((request) => {
        calls++
        if (phase === 'headers') return blocked
        return TestClock.adjust(600).pipe(
          Effect.map(() =>
            Object.defineProperty(HttpClientResponse.fromWeb(request, new Response('{}', { headers })), 'json', {
              value: blocked,
            }),
          ),
        )
      })
      yield* Effect.gen(function* () {
        const fiber = yield* read.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        yield* TestClock.adjust(phase === 'headers' ? 1000 : 400)
        const exit = yield* Fiber.join(fiber)
        if (Exit.isSuccess(exit)) throw new Error('Expected deadline failure')
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          kind: BrokerReadErrorKind.Timeout,
        })
        expect(finalized).toBe(1)
        expect(calls).toBe(1)
        const metrics = yield* PrometheusMetrics.format()
        expect(sample(metrics, phase, 'interrupted')).toBe(1)
        expect(sample(metrics, phase, 'interrupted', 'sum')).toBe(phase === 'headers' ? 1 : 0.4)
        expect(sample(metrics, 'body', 'succeeded')).toBe(0)
        if (phase === 'body') expect(sample(metrics, 'headers', 'succeeded', 'sum')).toBe(0.6)
      }).pipe(Effect.provideService(HttpClient.HttpClient, client))
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provide(Logger.layer([])),
      Effect.runPromise,
    )
  },
)

test.each(['transport', 'json', 'schema', 'defect'] as const)(
  '%s failure retains its original classification',
  async (kind) => {
    const defect = { reason: 'private-defect' }
    const client = HttpClient.make((request) => {
      if (kind === 'defect') return Effect.die(defect)
      if (kind === 'transport')
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error('private-provider-error') }),
          }),
        )
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(kind === 'json' ? 'private-invalid-json' : '{"fractional_trading":null}', { headers }),
        ),
      )
    })
    await run(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(read)
        if (Exit.isSuccess(exit)) throw new Error('Expected read failure')
        if (kind === 'defect') {
          expect(exit.cause.reasons).toHaveLength(1)
          expect(exit.cause.reasons[0]).toMatchObject({ _tag: 'Die', defect })
        } else
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            kind: kind === 'transport' ? BrokerReadErrorKind.Transport : BrokerReadErrorKind.InvalidResponse,
          })
        const metrics = yield* PrometheusMetrics.format()
        expect(sample(metrics, 'headers', kind === 'transport' || kind === 'defect' ? 'failed' : 'succeeded')).toBe(1)
        expect(sample(metrics, 'body', kind === 'json' ? 'failed' : 'succeeded')).toBe(
          kind === 'transport' || kind === 'defect' ? 0 : 1,
        )
        expect(metrics).not.toContain('private-')
      }),
      client,
    )
  },
)

test('external cancellation during the body stays interruption and releases the operation once', async () => {
  let finalized = 0
  await Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const client = HttpClient.make((request) =>
      Effect.succeed(
        Object.defineProperty(HttpClientResponse.fromWeb(request, new Response('{}', { headers })), 'json', {
          value: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => finalized++)),
          ),
        }),
      ),
    )
    yield* Effect.gen(function* () {
      const fiber = yield* read.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(finalized).toBe(1)
      expect(sample(yield* PrometheusMetrics.format(), 'body', 'interrupted')).toBe(1)
    }).pipe(Effect.provideService(HttpClient.HttpClient, client))
  }).pipe(
    Effect.provide(TestClock.layer()),
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.provide(Logger.layer([])),
    Effect.runPromise,
  )
})

test.each(['success', 'failure'] as const)('phase diagnostic finalizer defects preserve %s', async (outcome) => {
  let diagnosticFailures = 0
  const timings = new (class extends Map<string, ExecutionStageTiming> {
    override set(key: string, value: ExecutionStageTiming) {
      if (key.startsWith('bayn.alpaca.read.')) {
        diagnosticFailures++
        throw new Error('private-diagnostic-defect')
      }
      return super.set(key, value)
    }
  })()
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(outcome === 'success' ? '{"fractional_trading":true}' : 'invalid-json', { headers }),
      ),
    ),
  )
  await run(
    Effect.gen(function* () {
      const exit = yield* read.pipe(Effect.provideService(ExecutionStageTimings, timings), Effect.exit)
      expect(diagnosticFailures).toBe(2)
      if (outcome === 'success') expect(Exit.isSuccess(exit)).toBe(true)
      else {
        if (Exit.isSuccess(exit)) throw new Error('Expected invalid JSON failure')
        expect(Cause.hasDies(exit.cause)).toBe(false)
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          kind: BrokerReadErrorKind.InvalidResponse,
        })
      }
    }),
    client,
  )
})
