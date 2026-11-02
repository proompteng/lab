import { ValkeyCache } from '../valkey-cache'
import { valkeyFixture } from '../testing/valkey-fixture'
import { mock } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Exit, Layer, Logger, References, Tracer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import type { ApplicationPlan } from '../app'
import * as actualHttp from '../broker/alpaca/http'
import * as actualSession from '../broker/alpaca/session'
import * as actualPostgres from '../db/postgres-client'
import * as actualRestateTelemetry from '../restate/restate-telemetry'
import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { BrokerEnvironment, BrokerProvider } from '../broker/identity'

const mode = process.argv[2] ?? 'timeout'
let attempts = 0
let settlements = 0
let mutationInvalidations = 0
const interruptedCaptures: {
  readonly accountId: unknown
  readonly sourceRevision: unknown
  readonly captureId: unknown
}[] = []
const spans: Tracer.NativeSpan[] = []
const tracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  },
})
const logs: { message: string; annotations: Readonly<Record<string, unknown>> }[] = []
const logger = Logger.make(({ message, fiber }) => {
  logs.push({
    message: Array.isArray(message) && typeof message[0] === 'string' ? message[0] : '',
    annotations: fiber.getRef(References.CurrentLogAnnotations),
  })
})
const loggers = new Set([logger])
const telemetry = Layer.mergeAll(Layer.succeed(Logger.CurrentLoggers, loggers), Layer.succeed(Tracer.Tracer, tracer))
let persistenceTelemetry: { loggerInherited: boolean; tracerInherited: boolean } | undefined
let brokerTelemetry: { loggerInherited: boolean; tracerInherited: boolean } | undefined
const releaseAcquisition = Promise.withResolvers<void>()
const acquisitionFinished = Promise.withResolvers<void>()
const sql = (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
  Effect.suspend<readonly unknown[], Error, never>(() => {
    const query = strings.join('')
    if (query.includes('RETURNING broker_observations.generation'))
      return Clock.currentTimeMillis.pipe(
        Effect.map((now) => [
          {
            status: 'RESERVED',
            generation: 1,
            startedAt: new Date(now).toISOString(),
            nextPollNotBeforeMs: Number(values[3]),
          },
        ]),
      )
    if (query.includes('WITH failed AS')) {
      settlements += 1
      return mode === 'timeout' ? Effect.fail(new Error('injected completed persistence failure')) : Effect.succeed([])
    }
    if (query.includes('unfinished AS'))
      interruptedCaptures.push({ accountId: values[0], sourceRevision: values[1], captureId: values[2] })
    else if (query.includes('SET generation = generation + 1, available = false')) mutationInvalidations += 1
    return Effect.succeed([])
  })

await mock.module('../restate/restate-telemetry', () => ({
  ...actualRestateTelemetry,
  currentOpenTelemetryParentSpan: () =>
    Tracer.externalSpan({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true }),
}))

await mock.module('../db/postgres-client', () => ({
  ...actualPostgres,
  PostgresClientLive: () =>
    Layer.effect(
      PgClient.PgClient,
      Effect.gen(function* () {
        persistenceTelemetry = {
          loggerInherited: (yield* Logger.CurrentLoggers) === loggers,
          tracerInherited: (yield* Tracer.Tracer) === tracer,
        }
        return sql as unknown as PgClient.PgClient
      }),
    ),
}))
await mock.module('../broker/alpaca/http', () => ({
  ...actualHttp,
  alpacaHttpLayer: () =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          attempts += 1
          return HttpClientResponse.fromWeb(request, new Response('{}'))
        }),
      ),
    ),
}))
await mock.module('../broker/alpaca/session', () => ({
  ...actualSession,
  layer: () =>
    Layer.effect(
      actualSession.BrokerSession,
      Effect.gen(function* () {
        brokerTelemetry = {
          loggerInherited: (yield* Logger.CurrentLoggers) === loggers,
          tracerInherited: (yield* Tracer.Tracer) === tracer,
        }
        const http = yield* HttpClient.HttpClient
        yield* http.get('https://example.invalid/fake')
        if (mode === 'invalid-response')
          return yield* new actualSession.BrokerSessionAcquisitionError({
            stage: actualSession.BrokerSessionAcquisitionStage.ReadSurface,
            provider: BrokerProvider.Alpaca,
            environment: BrokerEnvironment.Sandbox,
            baseUrl: 'https://paper-api.alpaca.markets',
            expectedAccountId: 'test-account',
            cause: new BrokerReadError({
              operation: 'positions',
              kind: BrokerReadErrorKind.InvalidResponse,
              retryable: false,
              status: 200,
              message: 'synthetic private response detail',
            }),
          })
        if (mode === 'defect') return yield* Effect.die(new Error('synthetic capture defect'))
        if (mode === 'interruption') return yield* Effect.interrupt
        yield* Effect.promise(() => releaseAcquisition.promise)
        yield* http.get('https://example.invalid/fake')
        return { read: {} } as unknown as typeof actualSession.BrokerSession.Service
      }).pipe(Effect.ensuring(Effect.sync(() => acquisitionFinished.resolve()))),
    ),
}))

const { acquireBrokerObservationRuntime } = await import('./broker-observation-runtime')
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime } = yield* acquireBrokerObservationRuntime({
        config: {
          operationTimeoutMs: mode === 'timeout' ? 25 : 5000,
          alpaca: { expectedAccountId: 'test-account' },
          build: { sourceRevision: 'b'.repeat(40) },
        },
      } as unknown as ApplicationPlan)
      const signal = new AbortController().signal
      const poll = yield* Effect.exit(
        Effect.promise(() =>
          runtime.poll(signal, {
            captureId: 'test-capture',
          }),
        ),
      )
      const attemptsAtReturn = attempts
      releaseAcquisition.resolve()
      yield* Effect.promise(() => acquisitionFinished.promise)
      return {
        poll: Exit.isSuccess(poll) ? poll.value.poll : undefined,
        failed: Exit.isFailure(poll),
        settlements,
        mutationInvalidations,
        interruptedCaptures,
        attemptsAtReturn,
        attemptsAfterReturn: attempts,
        persistenceTelemetry,
        brokerTelemetry,
      }
    }),
  ).pipe(Effect.provideService(ValkeyCache, valkeyFixture().cache), Effect.provide(telemetry)),
)
process.stdout.write(
  `BROKER_POLL_RESULT=${JSON.stringify({
    ...result,
    logs,
    spans: spans.map((span) => ({
      name: span.name,
      spanId: span.spanId,
      traceId: span.traceId,
      parentSpanId: span.parent._tag === 'Some' ? span.parent.value.spanId : undefined,
      sourceRevision: span.attributes.get('bayn.source.revision'),
    })),
  })}\n`,
)
