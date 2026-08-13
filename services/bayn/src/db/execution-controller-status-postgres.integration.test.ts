import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

import { config as fixtureConfig } from '../app-test-support'
import { ExecutionControllerOutcome, ExecutionControllerStatusStore } from '../execution/controller-status'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { EvidenceStore, EvidenceStoreFromPostgres, PostgresClientLive } from './evidence-store'
import { ExecutionControllerStatusStoreLive } from './execution-controller-status-postgres'

const postgresUrl = baynTestPostgresUrl
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe
const config = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const makeRuntime = () => {
  const postgres = PostgresClientLive(config)
  return ManagedRuntime.make(
    Layer.mergeAll(EvidenceStoreFromPostgres(config), ExecutionControllerStatusStoreLive).pipe(
      Layer.provideMerge(postgres),
      Layer.provide(NodeServices.layer),
    ),
  )
}

describePostgres('PostgreSQL execution controller status projection', () => {
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(async () => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime()
    await runtime.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))
  })

  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
      }),
    )
    await runtime.dispose()
    runtime = makeRuntime()
    await runtime.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('applies only monotonic projections and distinguishes replay, stale delivery, and conflicts', async () => {
    const initial = {
      schemaVersion: 1 as const,
      controllerKey: 'primary',
      epoch: 3,
      lastSequence: 8,
      lastOutcome: ExecutionControllerOutcome.Blocked,
      lastReceiptHash: 'a'.repeat(64),
      completedAt: '2026-08-13T17:00:00.000Z',
      nextDueAt: '2026-08-13T17:00:30.000Z',
    }

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ExecutionControllerStatusStore
        const applied = yield* store.project(initial)
        const replayed = yield* store.project(initial)
        const stale = yield* store.project({
          ...initial,
          lastSequence: 7,
          lastReceiptHash: 'b'.repeat(64),
        })
        const conflict = yield* store.project({ ...initial, lastReceiptHash: 'c'.repeat(64) }).pipe(Effect.flip)
        const nextEpoch = yield* store.project({
          ...initial,
          epoch: 4,
          lastSequence: 0,
          lastOutcome: ExecutionControllerOutcome.Completed,
          lastReceiptHash: 'd'.repeat(64),
          completedAt: '2026-08-13T17:01:00.000Z',
          nextDueAt: '2026-08-13T17:01:30.000Z',
        })
        const stored = yield* store.read('primary')
        return { applied, replayed, stale, conflict, nextEpoch, stored }
      }),
    )

    expect(result.applied).toEqual({ _tag: 'Applied', status: initial })
    expect(result.replayed).toEqual({ _tag: 'Replayed', status: initial })
    expect(result.stale).toEqual({ _tag: 'Stale', status: initial })
    expect(result.conflict).toMatchObject({
      _tag: 'ExecutionControllerStatusStoreError',
      operation: 'project',
      failure: 'conflict',
    })
    expect(result.nextEpoch).toMatchObject({
      _tag: 'Applied',
      status: { epoch: 4, lastSequence: 0, lastOutcome: 'Completed', lastReceiptHash: 'd'.repeat(64) },
    })
    expect(result.stored).toEqual(result.nextEpoch.status)
  })
})
