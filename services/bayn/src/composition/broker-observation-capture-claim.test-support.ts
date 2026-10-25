import { ValkeyCache } from '../valkey-cache'
import { valkeyFixture } from '../testing/valkey-fixture'
import { mock } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer, Logger, References } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import type { ApplicationPlan } from '../app'
import * as actualHttp from '../broker/alpaca/http'
import * as actualPostgres from '../db/postgres-client'

let attempts = 0
let invalidations = 0
let invalidateOutcome: 'success' | 'failure' | 'interruption' | 'defect' = 'success'
const logs: { message: unknown; annotations: unknown }[] = []
const logger = Logger.make(({ message, fiber }) => {
  logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) })
})
let now = 1_800_000_000_000
const liveClock = Clock.Clock.defaultValue()
const clock: Clock.Clock = {
  currentTimeMillis: Effect.sync(() => now),
  currentTimeMillisUnsafe: () => now,
  currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  monotonicTimeNanos: liveClock.monotonicTimeNanos,
  monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
  sleep: (duration) => liveClock.sleep(duration),
}
const claims = new Map<unknown, number>()
const sql = (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
  Effect.suspend<readonly unknown[], Error, never>(() => {
    if (strings.join('').includes('RETURNING broker_observations.generation')) {
      if (claims.has(values[2]))
        return Effect.succeed([
          { status: 'ALREADY_CLAIMED', generation: null, startedAt: null, nextPollNotBeforeMs: claims.get(values[2]) },
        ])
      claims.set(values[2], Number(values[3]))
      now += values[2] === 'clock-regression' ? -1 : 47_000
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
    }
    if (
      !strings.join('').includes('WITH failed AS') &&
      !strings.join('').includes('SET generation = generation + 1, available = false')
    )
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
      } as unknown as ApplicationPlan
      const { runtime } = yield* acquireBrokerObservationRuntime(plan)
      const signal = new AbortController().signal
      const reservation = {
        captureId: 'test-capture',
      }
      const expired = yield* Effect.promise(() => runtime.poll(signal, reservation))
      const duplicate = yield* Effect.promise(() => runtime.poll(signal, reservation))
      const { runtime: replacement } = yield* acquireBrokerObservationRuntime(plan)
      const replaced = yield* Effect.promise(() => replacement.poll(signal, reservation))
      const failures = []
      for (const outcome of ['failure', 'interruption', 'defect'] as const) {
        const captureId = `failed-${outcome}`
        invalidateOutcome = outcome
        const completion = yield* Effect.tryPromise({
          try: () => runtime.poll(signal, { ...reservation, captureId }),
          catch: () => 'not completed',
        }).pipe(Effect.result)
        invalidateOutcome = 'success'
        const retry = yield* Effect.promise(() => runtime.poll(signal, { ...reservation, captureId }))
        failures.push({ outcome, completion: completion._tag, retry })
      }
      const regression = yield* Effect.tryPromise({
        try: () => runtime.poll(signal, { captureId: 'clock-regression' }),
        catch: () => 'not completed',
      }).pipe(Effect.result)
      const regressionRetry = yield* Effect.promise(() => runtime.poll(signal, { captureId: 'clock-regression' }))
      return {
        regression: regression._tag,
        regressionRetry: regressionRetry.poll,
        regressionDeadline: claims.get('clock-regression'),
        expired: expired.poll,
        duplicate: duplicate.poll,
        replaced: replaced.poll,
        failures: failures.map((f) => ({ ...f, retry: f.retry.poll, deadline: claims.get(`failed-${f.outcome}`) })),
        reservation: { ...reservation, interruptedNotBeforeMs: claims.get(reservation.captureId) },
        attempts,
        invalidations,
        claims: claims.size,
      }
    }),
  ).pipe(
    Effect.provideService(ValkeyCache, valkeyFixture().cache),
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.provideService(Clock.Clock, clock),
  ),
)
process.stdout.write(`CAPTURE_CLAIM_RESULT=${JSON.stringify({ ...result, logs })}\n`)
