import { mock } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer, Logger, References } from 'effect'
import { HttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'

import type { ApplicationPlan } from '../app'
import * as actualHttp from '../broker/alpaca/http'
import * as actualSession from '../broker/alpaca/session'
import * as actualCapture from '../broker/alpaca/snapshot-cache'
import * as actualPostgres from '../db/postgres-client'
import * as actualStore from '../db/broker-observations'
import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import { ValkeyCache, ValkeyCacheError, ValkeyFailureCategory } from '../valkey-cache'
import { valkeyFixture } from '../testing/valkey-fixture'

const makeStore = actualStore.makeBrokerObservationStore
const privateDetail = 'private-account-key-value-credential-fixture'
const rawCause = new Error(privateDetail)
const failures = Object.values(ValkeyFailureCategory).map(
  (category) => new ValkeyCacheError({ operation: 'put', category, message: privateDetail, cause: rawCause }),
)
failures.push(
  new ValkeyCacheError({
    operation: 'put',
    category: ValkeyFailureCategory.OperationDeadline,
    causeCategory: ValkeyFailureCategory.ReplicaAcknowledgement,
    message: privateDetail,
    cause: rawCause,
  }),
  new ValkeyCacheError({ operation: privateDetail, message: privateDetail, cause: rawCause }),
)
let currentFailure = failures[0]
let invalidations = 0
let publications = 0
let startedAt = ''
const retainedCauses: boolean[] = []
const logs: { message: unknown; annotations: unknown }[] = []
const logger = Logger.make(({ message, fiber }) => {
  logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) })
})
const sql = (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
  Effect.gen(function* () {
    const query = strings.join('')
    if (query.includes('RETURNING broker_observations.generation')) {
      startedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
      return [{ status: 'RESERVED', generation: 1, startedAt, nextPollNotBeforeMs: Number(values[3]) }]
    }
    if (query.includes('WITH failed AS')) invalidations++
    if (query.includes('WITH published AS')) publications++
    return []
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
      HttpClient.make(() => Effect.die('no HTTP expected')),
    ),
}))
await mock.module('../broker/alpaca/session', () => ({
  ...actualSession,
  layer: () =>
    Layer.succeed(actualSession.BrokerSession, { read: {} } as unknown as actualSession.BrokerSession['Service']),
}))
await mock.module('../broker/alpaca/snapshot-cache', () => ({
  ...actualCapture,
  captureBrokerObservation: () => Effect.succeed(observedBrokerSnapshotFixture(privateDetail, startedAt)),
}))
await mock.module('../db/broker-observations', () => ({
  ...actualStore,
  makeBrokerObservationStore: (...args: Parameters<typeof actualStore.makeBrokerObservationStore>) => {
    const store = makeStore(...args)
    return {
      ...store,
      publish: (...args: Parameters<typeof store.publish>) =>
        store.publish(...args).pipe(
          Effect.tapError((failure) =>
            Effect.sync(() => {
              retainedCauses.push(failure.cause === currentFailure && currentFailure?.cause === rawCause)
            }),
          ),
        ),
    }
  },
}))

const { acquireBrokerObservationRuntime } = await import('./broker-observation-runtime')
const polls = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-10-14T14:00:00.000Z'))
      const { runtime } = yield* acquireBrokerObservationRuntime({
        config: {
          operationTimeoutMs: 30_000,
          alpaca: { expectedAccountId: privateDetail },
          build: { sourceRevision: 'b'.repeat(40) },
        },
      } as unknown as ApplicationPlan)
      const polls = []
      for (const failure of failures) {
        currentFailure = failure
        const result = yield* Effect.promise(() =>
          runtime.poll(new AbortController().signal, { captureId: privateDetail }),
        )
        polls.push(result.poll)
      }
      return polls
    }),
  ).pipe(
    Effect.provideService(ValkeyCache, {
      ...valkeyFixture().cache,
      put: () => (currentFailure === undefined ? Effect.die('missing failure fixture') : Effect.fail(currentFailure)),
    }),
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.provide(TestClock.layer()),
  ),
)
process.stdout.write(
  `PUBLICATION_RESULT=${JSON.stringify({ polls, logs, retainedCauses, invalidations, publications })}\n`,
)
