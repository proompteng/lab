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

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const config = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const makeRuntime = () =>
  ManagedRuntime.make(
    ExecutionControllerStatusStoreLive.pipe(
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

describePostgres('PostgreSQL execution controller status', () => {
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
      lastOutcome: ExecutionControllerOutcome.Blocked,
      lastReceiptHash: 'a'.repeat(64),
      completedAt: '2026-08-13T17:00:00.000Z',
      nextDueAt: '2026-08-13T17:00:30.000Z',
      lastPass: {
        result: 'SUCCESS' as const,
        observedAt: '2026-08-13T17:00:00.000Z',
        outcome: 'WINDOW_CLOSED' as const,
      },
    }

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ExecutionControllerStatusStore
        const applied = yield* store.project(activation)
        const replayed = yield* store.project(activation)
        const conflict = yield* store.project({ ...activation, planHash: 'e'.repeat(64) }).pipe(Effect.flip)
        const completed = yield* store.project(completion)
        const stale = yield* store.project(activation)
        return { applied, replayed, conflict, completed, stale, stored: yield* store.read('primary') }
      }),
    )

    expect(result.applied).toEqual({ _tag: 'Applied', status: activation })
    expect(result.replayed).toEqual({ _tag: 'Replayed', status: activation })
    expect(result.conflict).toMatchObject({ operation: 'project', failure: 'conflict' })
    expect(result.completed).toEqual({ _tag: 'Applied', status: completion })
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
})
