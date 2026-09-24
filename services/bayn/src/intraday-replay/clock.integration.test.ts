import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Clock, Deferred, Effect, Exit, Fiber, Redacted, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { canonicalHashV1OrThrow } from '../hash'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { utcInstantFromEpochMillis } from '../time'
import { operationCurrentTimeMillis } from '../operation-timeout'
import { ReplayBrokerFailure } from './broker'
import { makeSimulatedExecutionClock } from './clock'

const postgresTest = baynTestPostgresUrl === undefined ? test.skip : test
const initialAt = Date.parse('2026-09-04T14:00:00.000Z')
const fixture = Effect.gen(function* () {
  yield* postgresMigrations
  yield* TestClock.setTime(initialAt)
  const sql = yield* PgClient.PgClient
  const providerClock = yield* TestClock.withLive(Clock.clockWith(Effect.succeed))
  const runId = canonicalHashV1OrThrow({ test: 'source-clock-exclusion', run: randomUUID() })
  const clock = yield* makeSimulatedExecutionClock(runId, runId, providerClock)
  const commitNow =
    sql`SELECT extract(epoch FROM execution_account_commit_now(${clock.accountId}))::double precision * 1000 AS at`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ at: Schema.Number })]))),
      Effect.map(([row]) => row.at),
    )
  const stopped = sql`SELECT measured_at, measured_observed_at, source_read_started_at
    FROM simulated_execution_clocks WHERE account_id = ${clock.accountId}`
  return { clock, sql, commitNow, stopped }
})

const run = <A, E>(operation: Effect.Effect<A, E, Effect.Services<typeof fixture>>) => {
  if (baynTestPostgresUrl === undefined) throw new Error('Missing isolated replay database')
  const url = new URL(baynTestPostgresUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
    throw new Error('Clock acceptance requires an isolated local test database')
  return Effect.runPromise(
    operation.pipe(
      Effect.scoped,
      Effect.provide(
        PostgresClientLive({
          operationTimeoutMs: 30000,
          postgres: { url: Redacted.make(baynTestPostgresUrl), tls: false, caPath: '/unused' },
        }),
      ),
      Effect.provide(TestClock.layer()),
      Effect.provide(NodeServices.layer),
    ),
  )
}

postgresTest.each(['success', 'typed failure', 'defect'] as const)(
  'database clock excludes source work and resumes persistence measurement after %s',
  async (outcome) => {
    await run(
      Effect.gen(function* () {
        const { clock, sql, commitNow, stopped } = yield* fixture
        yield* clock.measure(
          Effect.gen(function* () {
            const source = yield* clock
              .excludeSourceTime(
                Effect.gen(function* () {
                  const before = yield* commitNow
                  const workBefore = yield* operationCurrentTimeMillis
                  yield* sql`SELECT pg_sleep(0.06)`
                  expect(yield* commitNow).toBe(before)
                  expect(yield* operationCurrentTimeMillis).toBe(workBefore)
                  expect(
                    Exit.isFailure(yield* Effect.exit(clock.advanceTo(utcInstantFromEpochMillis(initialAt + 1)))),
                  ).toBe(true)
                  expect(Exit.isFailure(yield* Effect.exit(clock.excludeSourceTime(Effect.void)))).toBe(true)
                  if (outcome === 'typed failure')
                    return yield* new ReplayBrokerFailure({ message: 'Source unavailable' })
                  if (outcome === 'defect') return yield* Effect.die(new Error('Source parser defect'))
                  return 'retained'
                }),
              )
              .pipe(Effect.exit)
            expect(Exit.isSuccess(source)).toBe(outcome === 'success')
            expect(yield* clock.excludedSourceMillis).toBeGreaterThanOrEqual(50)
            const before = yield* commitNow
            yield* sql`SELECT pg_sleep(0.04)`
            expect((yield* commitNow) - before).toBeGreaterThanOrEqual(35)
            yield* clock.advanceTo(utcInstantFromEpochMillis(initialAt + 1))
          }),
        )
        expect(yield* stopped).toEqual([
          { measured_at: null, measured_observed_at: null, source_read_started_at: null },
        ])
        const frozen = yield* commitNow
        expect(frozen).toBeGreaterThan(initialAt + 35)
        yield* sql`SELECT pg_sleep(0.01)`
        expect(yield* commitNow).toBe(frozen)
        expect(yield* Clock.currentTimeMillis).toBe(frozen)
        expect(Exit.isFailure(yield* Effect.exit(clock.advanceTo(utcInstantFromEpochMillis(initialAt))))).toBe(true)
      }),
    )
  },
)

postgresTest('interruption resumes and finalizes a paused database measurement', async () => {
  await run(
    Effect.gen(function* () {
      const { clock, sql, commitNow, stopped } = yield* fixture
      expect(
        yield* sql`SELECT abs(extract(epoch FROM (execution_account_commit_now('paper-account') - clock_timestamp()))) < 0.01 AS current`,
      ).toEqual([{ current: true }])
      const entered = yield* Deferred.make<void>()
      const worker = yield* clock
        .measure(clock.excludeSourceTime(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const pausedAt = yield* commitNow
      yield* sql`SELECT pg_sleep(0.06)`
      expect(yield* commitNow).toBe(pausedAt)
      yield* Fiber.interrupt(worker)
      expect(yield* stopped).toEqual([{ measured_at: null, measured_observed_at: null, source_read_started_at: null }])
      expect(yield* clock.excludedSourceMillis).toBeGreaterThanOrEqual(50)
      const frozen = yield* commitNow
      yield* sql`SELECT pg_sleep(0.01)`
      expect(yield* commitNow).toBe(frozen)
      yield* clock.measure(sql`SELECT pg_sleep(0.02)`)
      expect(yield* commitNow).toBeGreaterThan(frozen)
    }),
  )
})
