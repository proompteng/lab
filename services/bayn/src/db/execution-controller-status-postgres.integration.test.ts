import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

import executionControllerPlanStatus from '../../migrations/0042_execution_controller_plan_status'
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
      planHash: 'f'.repeat(64),
      active: true,
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
        const planConflict = yield* store
          .project({ ...initial, planHash: 'e'.repeat(64), lastSequence: initial.lastSequence + 1 })
          .pipe(Effect.flip)
        const { nextDueAt: _nextDueAt, ...initialWithoutDue } = initial
        const deactivated = yield* store.project({
          ...initialWithoutDue,
          active: false,
          epoch: 4,
        })
        const rebound = yield* store.project({
          ...initial,
          planHash: 'd'.repeat(64),
          epoch: 4,
          lastSequence: 9,
          lastOutcome: ExecutionControllerOutcome.Completed,
          lastReceiptHash: 'd'.repeat(64),
          completedAt: '2026-08-13T17:01:00.000Z',
          nextDueAt: '2026-08-13T17:01:30.000Z',
        })
        const stored = yield* store.read('primary')
        const sql = yield* PgClient.PgClient
        const truncate = yield* Effect.exit(sql`TRUNCATE execution_controller_status`)
        const retainedAfterTruncate = yield* store.read('primary')
        return {
          applied,
          replayed,
          stale,
          conflict,
          planConflict,
          deactivated,
          rebound,
          stored,
          truncate,
          retainedAfterTruncate,
        }
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
    expect(result.planConflict).toMatchObject({
      _tag: 'ExecutionControllerStatusStoreError',
      operation: 'project',
      failure: 'conflict',
    })
    expect(result.deactivated).toMatchObject({
      _tag: 'Applied',
      status: { active: false, planHash: 'f'.repeat(64), epoch: 4, lastSequence: 8 },
    })
    expect(result.rebound).toMatchObject({
      _tag: 'Applied',
      status: {
        active: true,
        planHash: 'd'.repeat(64),
        epoch: 4,
        lastSequence: 9,
        lastOutcome: 'Completed',
        lastReceiptHash: 'd'.repeat(64),
      },
    })
    expect(result.stored).toEqual(result.rebound.status)
    expect(result.truncate._tag).toBe('Failure')
    expect(result.retainedAfterTruncate).toEqual(result.rebound.status)
  })

  test('upgrades and binds a status row projected before plan identity existed', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP TRIGGER execution_controller_status_transition ON execution_controller_status`
        yield* sql`DROP FUNCTION enforce_execution_controller_status_transition()`
        yield* sql`ALTER TABLE execution_controller_status DROP COLUMN plan_hash`
        yield* sql`
          INSERT INTO execution_controller_status (
            controller_key,
            active,
            epoch,
            last_sequence,
            last_outcome,
            last_receipt_hash,
            completed_at,
            next_due_at
          ) VALUES (
            'primary',
            true,
            3,
            8,
            'Blocked',
            ${'a'.repeat(64)},
            '2026-08-13T17:00:00.000Z',
            '2026-08-13T17:00:30.000Z'
          )
        `
        yield* executionControllerPlanStatus
        yield* sql`
          INSERT INTO execution_controller_status (
            controller_key,
            active,
            epoch,
            last_sequence,
            last_outcome,
            last_receipt_hash,
            completed_at,
            next_due_at
          ) VALUES (
            'draining-worker',
            true,
            4,
            2,
            'Blocked',
            ${'c'.repeat(64)},
            '2026-08-13T17:00:00.000Z',
            '2026-08-13T17:00:30.000Z'
          )
        `

        const store = yield* ExecutionControllerStatusStore
        const legacy = yield* store.read('primary')
        const drainingWorker = yield* store.read('draining-worker')
        const bound = yield* store.project({
          schemaVersion: 1,
          controllerKey: 'primary',
          planHash: 'f'.repeat(64),
          active: true,
          epoch: 3,
          lastSequence: 9,
          lastOutcome: ExecutionControllerOutcome.Completed,
          lastReceiptHash: 'b'.repeat(64),
          completedAt: '2026-08-13T17:01:00.000Z',
          nextDueAt: '2026-08-13T17:01:30.000Z',
        })
        const drainingWorkerBound = yield* store.project({
          schemaVersion: 1,
          controllerKey: 'draining-worker',
          planHash: 'e'.repeat(64),
          active: true,
          epoch: 4,
          lastSequence: 3,
          lastOutcome: ExecutionControllerOutcome.Completed,
          lastReceiptHash: 'd'.repeat(64),
          completedAt: '2026-08-13T17:01:00.000Z',
          nextDueAt: '2026-08-13T17:01:30.000Z',
        })
        return {
          bound,
          drainingWorker,
          drainingWorkerBound,
          legacy,
          stored: yield* store.read('primary'),
        }
      }),
    )

    expect(result.legacy).toMatchObject({ planHash: '0'.repeat(64), active: true, epoch: 3, lastSequence: 8 })
    expect(result.drainingWorker).toMatchObject({
      planHash: '0'.repeat(64),
      active: true,
      epoch: 4,
      lastSequence: 2,
    })
    expect(result.bound).toMatchObject({
      _tag: 'Applied',
      status: { planHash: 'f'.repeat(64), active: true, epoch: 3, lastSequence: 9 },
    })
    expect(result.drainingWorkerBound).toMatchObject({
      _tag: 'Applied',
      status: { planHash: 'e'.repeat(64), active: true, epoch: 4, lastSequence: 3 },
    })
    expect(result.stored).toEqual(result.bound.status)
  })
})
