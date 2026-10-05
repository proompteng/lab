import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

import { ExecutionControllerOutcome, ExecutionControllerStatusStore } from '../execution/controller-status'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { config as fixtureConfig } from '../testing/runtime-fixtures'
import { ExecutionControllerStatusStoreLive } from './execution-controller-status-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { makeCycleStore } from '../cycle/store/postgres'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { candidateObservationFixture } from '../testing/candidate-observation-fixture'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const config = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(ExecutionControllerStatusStoreLive, CandidateObservationStoreLive).pipe(
      Layer.provideMerge(PostgresClientLive(config)),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

const resetDatabase = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`DROP SCHEMA public CASCADE`
  yield* sql`CREATE SCHEMA public`
  yield* postgresMigrations
})

describePostgres('PostgreSQL execution controller diagnostics', () => {
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime()
  })

  beforeEach(async () => {
    await runtime.runPromise(resetDatabase)
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('records exact candidate evidence once and rejects conflicting replay, mutation, and orphaned cycles', async () => {
    const fixture = candidateObservationFixture()
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* CandidateObservationStore
        const cycles = yield* makeCycleStore()
        const orphan = yield* Effect.exit(store.record(fixture.observation))
        expect(orphan._tag).toBe('Failure')
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

  test('applies, replays, advances, and rejects conflicting controller projections', async () => {
    const activation = {
      schemaVersion: 1 as const,
      controllerKey: 'primary',
      planHash: 'f'.repeat(64),
      active: true,
      epoch: 3,
      nextSequence: 8,
    }
    const completion = {
      ...activation,
      nextSequence: 9,
      lastSequence: 8,
      lastOutcome: ExecutionControllerOutcome.Waiting,
      lastReceiptHash: 'a'.repeat(64),
      completedAt: '2026-08-13T17:00:00.000Z',
      nextDueAt: '2026-08-13T17:00:30.000Z',
      lastPass: {
        result: 'SUCCESS' as const,
        observedAt: '2026-08-13T17:00:00.000Z',
        outcome: 'RECOVERED' as const,
        recoveryAction: 'WAITING' as const,
        readiness: {
          reason: DecisionReadinessReason.SnapshotUnavailable,
          message: 'missing range-completion bar',
          symbol: 'IWM',
        },
      },
    }

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ExecutionControllerStatusStore
        const applied = yield* store.project(activation)
        const replayed = yield* store.project(activation)
        const conflict = yield* store.project({ ...activation, planHash: 'e'.repeat(64) }).pipe(Effect.flip)
        const completed = yield* store.project(completion)
        const altered = yield* store
          .project({
            ...completion,
            lastPass: { ...completion.lastPass, readiness: { ...completion.lastPass.readiness, symbol: 'SMH' } },
          })
          .pipe(Effect.flip)
        const stale = yield* store.project(activation)
        return { applied, replayed, conflict, completed, altered, stale, stored: yield* store.read('primary') }
      }),
    )

    expect(result.applied).toEqual({ _tag: 'Applied', status: activation })
    expect(result.replayed).toEqual({ _tag: 'Replayed', status: activation })
    expect(result.conflict).toMatchObject({ operation: 'project', failure: 'conflict' })
    expect(result.completed).toEqual({ _tag: 'Applied', status: completion })
    expect(result.altered).toMatchObject({ failure: 'conflict' })
    expect(result.stale).toEqual({ _tag: 'Stale', status: completion })
    expect(result.stored).toEqual(completion)
  })

  test('rotates plans only after the old controller is inactive and clears inherited completion evidence', async () => {
    const old = {
      schemaVersion: 1 as const,
      controllerKey: 'primary',
      planHash: 'f'.repeat(64),
      active: true,
      epoch: 3,
      nextSequence: 9,
      lastSequence: 8,
      lastOutcome: ExecutionControllerOutcome.Blocked,
      lastReceiptHash: 'a'.repeat(64),
      completedAt: '2026-08-13T17:00:00.000Z',
      nextDueAt: '2026-08-13T17:00:30.000Z',
    }
    const { nextDueAt: _nextDueAt, ...withoutDue } = old
    const inactive = { ...withoutDue, active: false, epoch: 4 }
    const next = {
      schemaVersion: 1 as const,
      controllerKey: 'primary',
      planHash: 'd'.repeat(64),
      active: true,
      epoch: 4,
      nextSequence: 9,
    }

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ExecutionControllerStatusStore
        yield* store.project(old)
        const deactivated = yield* store.project(inactive)
        const inherited = yield* store.project({ ...inactive, planHash: next.planHash, active: true }).pipe(Effect.flip)
        const activated = yield* store.project(next)
        return { deactivated, inherited, activated, stored: yield* store.read('primary') }
      }),
    )

    expect(result.deactivated).toEqual({ _tag: 'Applied', status: inactive })
    expect(result.inherited).toMatchObject({ operation: 'project', failure: 'conflict' })
    expect(result.activated).toEqual({ _tag: 'Applied', status: next })
    expect(result.stored).toEqual(next)
  })

  test('normalizes the exact pre-cutover every-session pass observation at the persistence boundary', async () => {
    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`
          INSERT INTO execution_controller_status (
            controller_key,
            plan_hash,
            active,
            epoch,
            next_sequence,
            last_sequence,
            last_outcome,
            last_receipt_hash,
            completed_at,
            next_due_at,
            last_pass
          ) VALUES (
            'historical',
            ${'f'.repeat(64)},
            true,
            3,
            9,
            8,
            'Blocked',
            ${'a'.repeat(64)},
            '2026-08-13T17:00:00.000Z',
            '2026-08-13T17:00:30.000Z',
            ${sql.json({
              result: 'SUCCESS',
              observedAt: '2026-08-13T17:00:00.000Z',
              outcome: 'RECOVERED',
              cadence: 'EVERY_SESSION',
            })}
          )
        `
        return yield* (yield* ExecutionControllerStatusStore).read('historical')
      }),
    )

    expect(stored).toEqual({
      schemaVersion: 1,
      controllerKey: 'historical',
      planHash: 'f'.repeat(64),
      active: true,
      epoch: 3,
      nextSequence: 9,
      lastSequence: 8,
      lastOutcome: ExecutionControllerOutcome.Blocked,
      lastReceiptHash: 'a'.repeat(64),
      completedAt: '2026-08-13T17:00:00.000Z',
      nextDueAt: '2026-08-13T17:00:30.000Z',
      lastPass: {
        result: 'SUCCESS',
        observedAt: '2026-08-13T17:00:00.000Z',
        outcome: 'RECOVERED',
      },
    })
  })
})
