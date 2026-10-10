import { mock } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer, Logger, References } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import type { ApplicationPlanFor } from '../app'
import * as actualHttp from '../broker/alpaca/http'
import * as actualPostgres from '../db/postgres-client'

let attempts = 0
let invalidations = 0
let invalidateOutcome: 'success' | 'failure' | 'interruption' | 'defect' = 'success'
const logs: { message: unknown; annotations: unknown }[] = []
const logger = Logger.make(({ message, fiber }) => {
  logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) })
})
const sql = (strings: TemplateStringsArray) =>
  Effect.suspend(() => {
    if (!strings.join('').includes('SET generation = generation + 1, available = false'))
      return Effect.die('unexpected observation query')
    invalidations += 1
    if (invalidateOutcome === 'failure') return Effect.fail(new Error('injected invalidation failure'))
    if (invalidateOutcome === 'interruption') return Effect.interrupt
    if (invalidateOutcome === 'defect') return Effect.die('injected invalidation defect')
    return Effect.succeed([])
  })

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

const { acquireBrokerObservationRuntime } = await import('./broker-observation-runtime')
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const plan = {
        config: {
          operationTimeoutMs: 30_000,
          alpaca: { expectedAccountId: 'test-account' },
          build: { sourceRevision: 'b'.repeat(40) },
        },
      } as unknown as ApplicationPlanFor<'AutonomousService'>
      const { runtime } = yield* acquireBrokerObservationRuntime(plan)
      const signal = new AbortController().signal
      const now = yield* Clock.currentTimeMillis
      const measuredDeadline = yield* Effect.promise(() => runtime.nextPollNotBeforeMs(signal))
      const reservation = {
        captureToken: yield* Effect.promise(() => runtime.preparePoll(signal)),
        captureStartDeadlineMs: now - 17_000,
        interruptedNotBeforeMs: now + 133_000,
      }
      const expired = yield* Effect.promise(() => runtime.poll(signal, reservation))
      const duplicate = yield* Effect.promise(() => runtime.poll(signal, reservation))
      const missing = yield* Effect.promise(() => runtime.poll(signal, { ...reservation, captureToken: 'missing' }))
      const { runtime: replacement } = yield* acquireBrokerObservationRuntime(plan)
      const replaced = yield* Effect.promise(() => replacement.poll(signal, reservation))
      const failures = []
      for (const outcome of ['failure', 'interruption', 'defect'] as const) {
        const captureToken = yield* Effect.promise(() => runtime.preparePoll(signal))
        invalidateOutcome = outcome
        const completion = yield* Effect.tryPromise({
          try: () => runtime.poll(signal, { ...reservation, captureToken }),
          catch: () => 'not completed',
        }).pipe(Effect.result)
        invalidateOutcome = 'success'
        const retry = yield* Effect.promise(() => runtime.poll(signal, { ...reservation, captureToken }))
        failures.push({ outcome, completion: completion._tag, retry })
      }
      return { expired, duplicate, missing, replaced, failures, measuredDeadline, reservation, attempts, invalidations }
    }),
  ).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger]))),
)
process.stdout.write(`CAPTURE_CLAIM_RESULT=${JSON.stringify({ ...result, logs })}\n`)
