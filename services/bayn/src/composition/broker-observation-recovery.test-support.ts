import { postgresQueryFixture } from '../testing/postgres-fixture.test-support'
import { mock } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Cause, Clock, Effect, Exit, Fiber, Layer, Logger, References } from 'effect'
import { HttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'

import type { ApplicationPlan } from '../app'
import * as actualHttp from '../broker/alpaca/http'
import * as actualSession from '../broker/alpaca/session'
import * as actualCapture from '../broker/alpaca/snapshot-cache'
import * as actualPostgres from '../db/postgres-client'
import { BrokerPollFailureReason, BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import { observationUnavailable } from '../broker/alpaca/observed-snapshot'
import { BrokerEnvironment, BrokerProvider } from '../broker/identity'
import { ValkeyCache } from '../valkey-cache'
import { valkeyFixture } from '../testing/valkey-fixture'

const mode = process.argv[2] ?? 'retryable'
let acquisitions = 0
let disposed = 0
let captures = 0
let finalized = 0
let settlements = 0
let publications = 0
let startedAt = ''
let generation = 0
const entered = Promise.withResolvers<void>()
const logs: { message: unknown; annotations: unknown }[] = []
const logger = Logger.make(({ message, fiber }) => {
  logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) })
})
const sql = (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
  Effect.gen(function* () {
    const query = strings.join('')
    if (query.includes('RETURNING broker_observations.generation')) {
      generation++
      startedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
      return [{ status: 'RESERVED', generation, startedAt, nextPollNotBeforeMs: Number(values[3]) }]
    }
    if (query.includes('WITH failed AS')) settlements++
    if (query.includes('WITH published AS')) {
      publications++
      return [{ account_id: 'test-account' }]
    }
    return []
  })

await mock.module('../db/postgres-client', () => ({
  ...actualPostgres,
  PostgresClientLive: () => Layer.succeed(PgClient.PgClient, postgresQueryFixture(sql)),
}))
await mock.module('../broker/alpaca/http', () => ({
  ...actualHttp,
  alpacaHttpLayer: () =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die('no HTTP expected')),
    ),
}))
await mock.module('../broker/alpaca/session', () => ({
  ...actualSession,
  layer: () =>
    Layer.effect(
      actualSession.BrokerSession,
      Effect.acquireRelease(
        Effect.gen(function* () {
          acquisitions++
          if (mode === 'acquisition' && acquisitions === 1)
            return yield* new actualSession.BrokerSessionAcquisitionError({
              stage: actualSession.BrokerSessionAcquisitionStage.ReadSurface,
              provider: BrokerProvider.Alpaca,
              environment: BrokerEnvironment.Sandbox,
              baseUrl: 'https://paper-api.alpaca.markets',
              expectedAccountId: 'test-account',
              cause: observationUnavailable('unavailable startup'),
            })
          return { read: {} } as unknown as actualSession.BrokerSession['Service']
        }),
        () => Effect.sync(() => disposed++),
      ),
    ),
}))
await mock.module('../broker/alpaca/snapshot-cache', () => ({
  ...actualCapture,
  makeBrokerObservationCapture: Effect.succeed(() =>
    Effect.gen(function* () {
      captures++
      if (captures === 1 && mode !== 'acquisition') {
        entered.resolve()
        if (mode === 'timeout') return yield* Effect.never
        if (mode === 'defect') return yield* Effect.die(new Error('capture fixture defect'))
        if (mode === 'interruption') return yield* Effect.interrupt
        if (mode === 'retryable')
          return yield* observationUnavailable(
            'pending fill history',
            undefined,
            BrokerPollFailureReason.SnapshotRejected,
          )
        const failure = new BrokerReadError({
          operation: 'account',
          kind: mode === 'identity' ? BrokerReadErrorKind.AccountMismatch : BrokerReadErrorKind.Forbidden,
          retryable: false,
          message: 'broker authority unavailable',
        })
        return yield* mode === 'mixed'
          ? Effect.failCause(Cause.combine(Cause.fail(observationUnavailable('retryable read')), Cause.fail(failure)))
          : Effect.fail(failure)
      }
      return observedBrokerSnapshotFixture('test-account', startedAt)
    }).pipe(Effect.ensuring(Effect.sync(() => finalized++))),
  ),
}))

const { acquireBrokerObservationRuntime } = await import('./broker-observation-runtime')
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-11-09T14:30:00.000Z'))
      const { runtime } = yield* acquireBrokerObservationRuntime({
        config: {
          operationTimeoutMs: 1_000,
          alpaca: { expectedAccountId: 'test-account' },
          build: { sourceRevision: 'b'.repeat(40) },
        },
      } as unknown as ApplicationPlan)
      const first = yield* Effect.promise(() =>
        runtime.poll(new AbortController().signal, { captureId: 'first-capture' }),
      ).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      if (mode === 'timeout') {
        yield* Effect.promise(() => entered.promise)
        yield* TestClock.adjust(1_000)
      }
      const failed = yield* Fiber.join(first)
      const disposedAfterFirst = disposed
      yield* TestClock.adjust(60_000)
      const recovered = yield* Effect.promise(() =>
        runtime.poll(new AbortController().signal, { captureId: 'second-capture' }),
      )
      return {
        first: Exit.isSuccess(failed) ? failed.value.poll._tag : 'Failed',
        recovered: recovered.poll._tag,
        acquisitions,
        disposedAfterFirst,
        captures,
        finalized,
        settlements,
        publications,
      }
    }),
  ).pipe(
    Effect.provideService(ValkeyCache, valkeyFixture().cache),
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.provide(TestClock.layer()),
  ),
)
process.stdout.write(`BROKER_RECOVERY_RESULT=${JSON.stringify({ ...result, disposed, logs })}\n`)
