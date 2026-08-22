import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import accountNeutralRuntimeCompatibility from '../../migrations/0037_account_neutral_runtime_compatibility'
import executionControllerPlanStatus from '../../migrations/0042_execution_controller_plan_status'
import executionControllerActivationProjection from '../../migrations/0043_execution_controller_activation_projection'
import executionControllerPassObservation from '../../migrations/0044_execution_controller_pass_observation'
import { config as fixtureConfig } from '../app-test-support'
import { projectExecutionControllerState } from '../composition/native-execution-runtime'
import { ExecutionControllerStatusResourceLive } from '../composition/resources'
import { ExecutionControllerOutcome, ExecutionControllerStatusStore } from '../execution/controller-status'
import { decideExecutionControllerActivation, decideExecutionControllerDeactivation } from '../execution/controller'
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
      lastPass: {
        result: 'SUCCESS' as const,
        observedAt: '2026-08-13T17:00:00.000Z',
        outcome: 'NOT_DUE' as const,
      },
    }

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ExecutionControllerStatusStore
        const applied = yield* store.project(activation)
        const replayed = yield* store.project(activation)
        const conflict = yield* store.project({ ...activation, planHash: 'e'.repeat(64) }).pipe(Effect.flip)
        const completed = yield* store.project(firstCompletion)
        const passConflict = yield* store
          .project({
            ...firstCompletion,
            lastPass: { ...firstCompletion.lastPass, outcome: 'NO_PUBLICATION' as const },
          })
          .pipe(Effect.flip)
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
          passConflict,
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
    expect(result.passConflict).toMatchObject({
      _tag: 'ExecutionControllerStatusStoreError',
      operation: 'project',
      failure: 'conflict',
    })
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
          DROP COLUMN last_pass,
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
        yield* executionControllerPassObservation

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

  test('controller persistence bootstraps current pass projection before rotating an active v42 binding', async () => {
    const controllerKey = 'primary'
    const oldPlanHash = '04221d3f591bcf064ed41d9c1ddd95b445bd5aa05840caab20bc8508625a169e'
    const oldSourceRevision = '9101af1d4e51da3d68f0a0a8b4928404f4566fb3'
    const newPlanHash = '5c27ef4302777b2ec91d6ecebc4c4f847fd01a0384a8a71042415ce28eaa8893'
    const newSourceRevision = 'f32e781ef2ec7a5bf45bcd2f8645316d40909f7f'
    const lastReceiptHash = 'a'.repeat(64)
    const completedAt = '2026-08-15T10:20:00.000Z'
    const nextDueAt = '2026-08-15T10:20:30.000Z'

    const v42 = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`
          ALTER TABLE execution_controller_status
          DROP CONSTRAINT execution_controller_status_completion_evidence,
          DROP COLUMN last_pass,
          DROP COLUMN next_sequence,
          ALTER COLUMN last_sequence SET NOT NULL,
          ALTER COLUMN last_outcome SET NOT NULL,
          ALTER COLUMN last_receipt_hash SET NOT NULL,
          ALTER COLUMN completed_at SET NOT NULL
        `
        yield* sql`ALTER TABLE execution_controller_status DROP COLUMN plan_hash`
        yield* accountNeutralRuntimeCompatibility
        yield* executionControllerPlanStatus
        yield* sql`
          DROP TABLE
            opening_drive_qualification_session_replays,
            opening_drive_qualification_replay_versions,
            opening_drive_qualification_results,
            opening_drive_qualification_locks
        `
        yield* sql`DELETE FROM schema_migrations WHERE migration_id IN (43, 44, 45, 46, 47, 48)`
        yield* sql`
          INSERT INTO execution_controller_status (
            controller_key,
            plan_hash,
            active,
            epoch,
            last_sequence,
            last_outcome,
            last_receipt_hash,
            completed_at,
            next_due_at
          ) VALUES (
            ${controllerKey},
            ${oldPlanHash},
            true,
            3,
            8,
            'Blocked',
            ${lastReceiptHash},
            ${completedAt},
            ${nextDueAt}
          )
        `
        const [migration] = yield* sql<{ migration_id: number; name: string }>`
          SELECT migration_id, name FROM schema_migrations ORDER BY migration_id DESC LIMIT 1
        `
        const [trigger] = yield* sql<{ definition: string }>`
          SELECT pg_get_functiondef(oid) AS definition
          FROM pg_proc
          WHERE proname = 'enforce_execution_controller_status_transition'
        `
        return { migration, triggerDefinition: trigger?.definition ?? '' }
      }),
    )

    expect(v42.migration).toEqual({ migration_id: 42, name: 'execution_controller_plan_status' })
    expect(v42.triggerDefinition).toContain('NEW.last_sequence <= OLD.last_sequence')
    expect(v42.triggerDefinition).not.toContain('OLD.next_sequence IS NULL')

    const projectionRuntime = ManagedRuntime.make(ExecutionControllerStatusResourceLive(config))
    try {
      const store = await projectionRuntime.runPromise(ExecutionControllerStatusStore)
      const migrated = await projectionRuntime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const [migration] = yield* sql<{ migration_id: number; name: string }>`
            SELECT migration_id, name FROM schema_migrations ORDER BY migration_id DESC LIMIT 1
          `
          const [column] = yield* sql<{ is_nullable: string }>`
            SELECT is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'execution_controller_status'
              AND column_name = 'next_sequence'
          `
          const [row] = yield* sql<{ next_sequence: string }>`
            SELECT next_sequence::text AS next_sequence
            FROM execution_controller_status
            WHERE controller_key = ${controllerKey}
          `
          const [trigger] = yield* sql<{ definition: string }>`
            SELECT pg_get_functiondef(oid) AS definition
            FROM pg_proc
            WHERE proname = 'enforce_execution_controller_status_transition'
          `
          return { column, migration, row, triggerDefinition: trigger?.definition ?? '' }
        }),
      )

      expect(migrated.migration).toEqual({ migration_id: 48, name: 'research_reconciliation_rearm' })
      expect(migrated.column).toEqual({ is_nullable: 'NO' })
      expect(migrated.row).toEqual({ next_sequence: '9' })
      expect(migrated.triggerDefinition).toContain('NEW.last_pass')

      const oldState = {
        schemaVersion: 1 as const,
        active: true,
        epoch: 3,
        planHash: oldPlanHash,
        sourceRevision: oldSourceRevision,
        initialSequence: 0,
        nextSequence: 9,
        lastCompletion: {
          sequence: 8,
          outcome: ExecutionControllerOutcome.Blocked,
          receiptHash: lastReceiptHash,
          completedAt,
        },
        nextDueAt,
      }
      const deactivation = Result.getOrThrow(
        decideExecutionControllerDeactivation(oldState, {
          schemaVersion: 'bayn.execution-controller-deactivation.v1',
          controllerKey,
          epoch: 3,
          planHash: oldPlanHash,
          sourceRevision: oldSourceRevision,
        }),
      )
      expect(deactivation._tag).toBe('Deactivated')
      await Effect.runPromise(projectExecutionControllerState(controllerKey, deactivation.state, store))

      const activation = Result.getOrThrow(
        decideExecutionControllerActivation(deactivation.state, {
          schemaVersion: 'bayn.execution-controller-activation.v1',
          controllerKey,
          epoch: deactivation.state.epoch,
          firstSequence: deactivation.state.nextSequence,
          planHash: newPlanHash,
          sourceRevision: newSourceRevision,
        }),
      )
      expect(activation._tag).toBe('Activated')
      await Effect.runPromise(projectExecutionControllerState(controllerKey, activation.state, store))

      const stored = await Effect.runPromise(store.read(controllerKey))
      expect(stored).toEqual({
        schemaVersion: 1,
        controllerKey,
        planHash: newPlanHash,
        active: true,
        epoch: 4,
        nextSequence: 9,
      })

      const monotonicViolation = await projectionRuntime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* Effect.exit(sql`
            UPDATE execution_controller_status
            SET next_sequence = 8
            WHERE controller_key = ${controllerKey}
          `)
        }),
      )
      expect(monotonicViolation._tag).toBe('Failure')
      expect(await Effect.runPromise(store.read(controllerKey))).toEqual(stored)
    } finally {
      await projectionRuntime.dispose()
    }
  })
})
