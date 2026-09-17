import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer, ManagedRuntime, Redacted } from 'effect'

import { makeCycleStore } from '../cycle/store/postgres'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { candidateObservationFixture } from '../testing/candidate-observation-fixture'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const makeRuntime = () =>
  ManagedRuntime.make(
    CandidateObservationStoreLive.pipe(
      Layer.provideMerge(
        PostgresClientLive({
          operationTimeoutMs: 5000,
          postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

describePostgres('PostgreSQL candidate observation audit', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Candidate observation tests require a local _test database')
    runtime = makeRuntime()
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
      }),
    )
  })
  afterAll(async () => {
    await runtime?.dispose()
  })

  test('records exact evidence once and rejects conflicting replay, mutation, and orphaned cycles', async () => {
    const fixture = candidateObservationFixture()
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* CandidateObservationStore
        const cycles = yield* makeCycleStore()
        const orphan = yield* Effect.exit(store.record(fixture.observation))
        expect(Exit.isFailure(orphan)).toBe(true)
        yield* cycles.acquire(fixture.draft, fixture.cycle.createdAt)
        yield* store.record(fixture.observation)
        yield* store.record(fixture.observation)
        const persisted = yield* sql`SELECT content_hash, payload FROM intraday_candidate_observations`
        expect(persisted).toEqual([
          { content_hash: fixture.observation.contentHash, payload: fixture.observation.payload },
        ])
        const altered = yield* Effect.exit(
          store.record({
            ...fixture.observation,
            payload: { ...fixture.observation.payload, authorityGenerationHash: 'c'.repeat(64) },
          }),
        )
        const update = yield* Effect.exit(
          sql`UPDATE intraday_candidate_observations SET content_hash = ${'d'.repeat(64)}`,
        )
        const remove = yield* Effect.exit(sql`DELETE FROM intraday_candidate_observations`)
        const truncate = yield* Effect.exit(sql`TRUNCATE intraday_candidate_observations`)
        for (const failure of [altered, update, remove, truncate]) expect(failure._tag).toBe('Failure')
        expect(yield* sql`SELECT count(*)::integer AS count FROM intraday_candidate_observations`).toEqual([
          { count: 1 },
        ])
      }),
    )
  })
})
