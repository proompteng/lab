import { mock } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import type { ApplicationPlanFor } from '../app'
import * as actualHttp from '../broker/alpaca/http'
import * as actualSession from '../broker/alpaca/session'
import * as actualPostgres from '../db/postgres-client'

let attempts = 0
const releaseAcquisition = Promise.withResolvers<void>()
const acquisitionFinished = Promise.withResolvers<void>()
const sql = (strings: TemplateStringsArray) => {
  const query = strings.join('')
  if (query.includes('RETURNING generation'))
    return Clock.currentTimeMillis.pipe(
      Effect.map((now) => [{ generation: 1, startedAt: new Date(now).toISOString() }]),
    )
  if (query.includes('SET available = false')) return Effect.fail(new Error('injected completed persistence failure'))
  return Effect.succeed([])
}

await mock.module('../db/postgres-client', () => ({
  ...actualPostgres,
  PostgresClientLive: () => Layer.succeed(PgClient.PgClient, sql as unknown as PgClient.PgClient),
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
        const http = yield* HttpClient.HttpClient
        yield* http.get('https://example.invalid/fake')
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
          operationTimeoutMs: 25,
          alpaca: { expectedAccountId: 'test-account' },
          build: { sourceRevision: 'b'.repeat(40) },
        },
      } as unknown as ApplicationPlanFor<'AutonomousService'>)
      const signal = new AbortController().signal
      const captureToken = yield* Effect.promise(() => runtime.preparePoll(signal))
      const now = yield* Clock.currentTimeMillis
      const poll = yield* Effect.promise(() =>
        runtime.poll(signal, {
          captureToken,
          captureStartDeadlineMs: now + 1_000,
          interruptedNotBeforeMs: now + 180_000,
        }),
      )
      const attemptsAtReturn = attempts
      releaseAcquisition.resolve()
      yield* Effect.promise(() => acquisitionFinished.promise)
      const nextPollNotBeforeMs = yield* Effect.promise(() => runtime.nextPollNotBeforeMs(signal))
      return { poll, attemptsAtReturn, attemptsAfterReturn: attempts, nextPollNotBeforeMs }
    }),
  ),
)
process.stdout.write(`BROKER_POLL_RESULT=${JSON.stringify(result)}\n`)
