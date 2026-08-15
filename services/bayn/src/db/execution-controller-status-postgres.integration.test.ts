import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

import executionControllerPlanStatus from '../../migrations/0042_execution_controller_plan_status'
import executionControllerActivationProjection from '../../migrations/0043_execution_controller_activation_projection'
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

  test('persists activation without completion evidence, replays it exactly, and records the first real completion', async () => {
    const activation = {
      schemaVersion: 1 as const,
      controllerKey: 'primary',
      planHash: 'f'.repeat(64),
      active: true,
      epoch: 3,
      nextSequence: 8,
    }
    const firstCompletion = {
      ...activation,
      nextSequence: 9,
      lastSequence: 8,
      lastOutcome: ExecutionControllerOutcome.Blocked,
      lastReceiptHash: 'a'.repeat(64),
      completedAt: '2026-08-13T17:00:00.000Z',
      nextDueAt: '2026-08-13T17:00:30.000Z',
    }

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ExecutionControllerStatusStore
        const applied = yield* store.project(activation)
        const replayed = yield* store.project(activation)
        const conflict = yield* store.project({ ...activation, planHash: 'e'.repeat(64) }).pipe(Effect.flip)
        const completed = yield* store.project(firstCompletion)
        const stale = yield* store.project(activation)
        const stored = yield* store.read('primary')
        const sql = yield* PgClient.PgClient
        const truncate = yield* Effect.exit(sql`TRUNCATE execution_controller_status`)
        const retainedAfterTruncate = yield* store.read('primary')
        return {
          applied,
          replayed,
          conflict,
          completed,
          stale,
          stored,
          truncate,
          retainedAfterTruncate,
        }
      }),
    )

    expect(result.applied).toEqual({ _tag: 'Applied', status: activation })
    expect(result.replayed).toEqual({ _tag: 'Replayed', status: activation })
    expect(result.conflict).toMatchObject({
      _tag: 'ExecutionControllerStatusStoreError',
      operation: 'project',
      failure: 'conflict',
    })
    expect(result.completed).toEqual({ _tag: 'Applied', status: firstCompletion })
    expect(result.stale).toEqual({ _tag: 'Stale', status: firstCompletion })
    expect(result.stored).toEqual(firstCompletion)
    expect(result.truncate._tag).toBe('Failure')
    expect(result.retainedAfterTruncate).toEqual(firstCompletion)
  })

  test('rotates a completed inactive old plan without attributing its completion to the new plan', async () => {
    const oldCompleted = {
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
    const { nextDueAt: _nextDueAt, ...oldWithoutDue } = oldCompleted
    const inactiveOld = { ...oldWithoutDue, active: false, epoch: 4 }
    const newActivation = {
      schemaVersion: 1 as const,
      controllerKey: 'primary',
      planHash: 'd'.repeat(64),
      active: true,
      epoch: 4,
      nextSequence: 9,
    }
    const newCompletion = {
      ...newActivation,
      nextSequence: 10,
      lastSequence: 9,
      lastOutcome: ExecutionControllerOutcome.Completed,
      lastReceiptHash: 'd'.repeat(64),
      completedAt: '2026-08-13T17:01:00.000Z',
      nextDueAt: '2026-08-13T17:01:30.000Z',
    }

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ExecutionControllerStatusStore
        yield* store.project(oldCompleted)
        const deactivated = yield* store.project(inactiveOld)
        const inheritedCompletion = yield* store
          .project({
            ...inactiveOld,
            planHash: newActivation.planHash,
            active: true,
          })
          .pipe(Effect.flip)
        const activated = yield* store.project(newActivation)
        const activationReplay = yield* store.project(newActivation)
        const afterActivation = yield* store.read('primary')
        const completed = yield* store.project(newCompletion)
        return {
          deactivated,
          inheritedCompletion,
          activated,
          activationReplay,
          afterActivation,
          completed,
          stored: yield* store.read('primary'),
        }
      }),
    )

    expect(result.deactivated).toEqual({ _tag: 'Applied', status: inactiveOld })
    expect(result.inheritedCompletion).toMatchObject({
      _tag: 'ExecutionControllerStatusStoreError',
      operation: 'project',
      failure: 'conflict',
    })
    expect(result.activated).toEqual({ _tag: 'Applied', status: newActivation })
    expect(result.activationReplay).toEqual({ _tag: 'Replayed', status: newActivation })
    expect(result.afterActivation).toEqual(newActivation)
    expect(result.completed).toEqual({ _tag: 'Applied', status: newCompletion })
    expect(result.stored).toEqual(newCompletion)
  })

  test('upgrades populated v42 rows and binds reserved plan identity without advancing the cursor', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP TRIGGER execution_controller_status_transition ON execution_controller_status`
        yield* sql`DROP FUNCTION enforce_execution_controller_status_transition()`
        yield* sql`
          ALTER TABLE execution_controller_status
          DROP CONSTRAINT execution_controller_status_completion_evidence,
          DROP COLUMN next_sequence,
          ALTER COLUMN last_sequence SET NOT NULL,
          ALTER COLUMN last_outcome SET NOT NULL,
          ALTER COLUMN last_receipt_hash SET NOT NULL,
          ALTER COLUMN completed_at SET NOT NULL
        `
        yield* sql`ALTER TABLE execution_controller_status DROP COLUMN plan_hash`
        yield* sql`
          CREATE FUNCTION enforce_execution_controller_status_transition()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $function$
          BEGIN
            IF TG_OP = 'DELETE' THEN
              RAISE EXCEPTION 'execution controller status cannot be deleted' USING ERRCODE = '55000';
            END IF;
            IF TG_OP = 'INSERT' THEN
              RETURN NEW;
            END IF;
            IF NEW.controller_key <> OLD.controller_key THEN
              RAISE EXCEPTION 'execution controller identity is immutable' USING ERRCODE = '55000';
            END IF;
            IF NEW.epoch < OLD.epoch OR (NEW.epoch = OLD.epoch AND NEW.last_sequence <= OLD.last_sequence) THEN
              RAISE EXCEPTION 'execution controller status must advance monotonically' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
          END
          $function$
        `
        yield* sql`
          CREATE TRIGGER execution_controller_status_transition
          BEFORE INSERT OR UPDATE OR DELETE ON execution_controller_status
          FOR EACH ROW EXECUTE FUNCTION enforce_execution_controller_status_transition()
        `
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
        const v42SameCursorUpdate = yield* Effect.exit(sql`
          UPDATE execution_controller_status
          SET plan_hash = plan_hash
          WHERE controller_key = 'primary'
        `)
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
        yield* executionControllerActivationProjection

        const store = yield* ExecutionControllerStatusStore
        const legacy = yield* store.read('primary')
        const drainingWorker = yield* store.read('draining-worker')
        const legacyEvidenceConflict = yield* store
          .project({
            schemaVersion: 1,
            controllerKey: 'primary',
            planHash: 'f'.repeat(64),
            active: true,
            epoch: 3,
            nextSequence: 9,
            lastSequence: 8,
            lastOutcome: ExecutionControllerOutcome.Blocked,
            lastReceiptHash: 'b'.repeat(64),
            completedAt: '2026-08-13T17:00:00.000Z',
            nextDueAt: '2026-08-13T17:00:30.000Z',
          })
          .pipe(Effect.flip)
        const sameCursorBound = yield* store.project({
          schemaVersion: 1,
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
        })
        const bound = yield* store.project({
          schemaVersion: 1,
          controllerKey: 'primary',
          planHash: 'f'.repeat(64),
          active: true,
          epoch: 3,
          nextSequence: 10,
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
          nextSequence: 4,
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
          legacyEvidenceConflict,
          sameCursorBound,
          stored: yield* store.read('primary'),
          v42SameCursorUpdate,
        }
      }),
    )

    expect(result.v42SameCursorUpdate._tag).toBe('Failure')
    expect(result.legacy).toMatchObject({
      planHash: '0'.repeat(64),
      active: true,
      epoch: 3,
      nextSequence: 9,
      lastSequence: 8,
    })
    expect(result.drainingWorker).toMatchObject({
      planHash: '0'.repeat(64),
      active: true,
      epoch: 4,
      nextSequence: 3,
      lastSequence: 2,
    })
    expect(result.legacyEvidenceConflict).toMatchObject({
      _tag: 'ExecutionControllerStatusStoreError',
      operation: 'project',
      failure: 'conflict',
    })
    expect(result.sameCursorBound).toMatchObject({
      _tag: 'Applied',
      status: {
        planHash: 'f'.repeat(64),
        active: true,
        epoch: 3,
        nextSequence: 9,
        lastSequence: 8,
        lastReceiptHash: 'a'.repeat(64),
      },
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
