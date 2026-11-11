import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import { ExecutionControllerOutcome, ExecutionControllerStatusStore } from '../execution/controller-status'
import { decideExecutionControllerDeactivation, type ExecutionControllerState } from '../execution/controller'
import { projectExecutionControllerState } from '../composition/native-execution-runtime'
import { readSystemControllerPasses } from '../system-assessment/capture-queries'
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
          reason: DecisionReadinessReason.SnapshotUnavailable as const,
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

  test.each([false, true])(
    'replays deactivation without rewriting an existing projection (retained pass: %s)',
    async (retainedPass) => {
      const controllerKey = 'a'.repeat(64)
      const completion = {
        schemaVersion: 1 as const,
        controllerKey,
        planHash: 'f'.repeat(64),
        active: true,
        epoch: 3,
        nextSequence: 9,
        lastSequence: 8,
        lastOutcome: ExecutionControllerOutcome.Waiting,
        lastReceiptHash: 'b'.repeat(64),
        completedAt: '2026-08-13T17:00:00.000Z',
        nextDueAt: '2026-08-13T17:00:30.000Z',
        lastPass: {
          result: 'SUCCESS' as const,
          observedAt: '2026-08-13T17:00:00.000Z',
          outcome: 'WINDOW_CLOSED' as const,
        },
      }
      const state: ExecutionControllerState = {
        schemaVersion: 1,
        active: true,
        epoch: completion.epoch,
        planHash: completion.planHash,
        sourceRevision: 'c'.repeat(40),
        initialSequence: 8,
        nextSequence: completion.nextSequence,
        nextDueAt: completion.nextDueAt,
        lastCompletion: {
          sequence: completion.lastSequence,
          outcome: completion.lastOutcome,
          receiptHash: completion.lastReceiptHash,
          completedAt: completion.completedAt,
        },
      }
      const request = {
        schemaVersion: 'bayn.execution-controller-deactivation.v1' as const,
        controllerKey,
        epoch: state.epoch,
        planHash: state.planHash,
        sourceRevision: state.sourceRevision,
      }
      const deactivated = Result.getOrThrow(decideExecutionControllerDeactivation(state, request))
      const replayed = Result.getOrThrow(decideExecutionControllerDeactivation(deactivated.state, request))
      expect(replayed._tag).toBe('Replayed')
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionControllerStatusStore
          yield* store.project(completion)
          if (retainedPass) {
            const { nextDueAt: _nextDueAt, ...withoutDue } = completion
            yield* store.project({ ...withoutDue, active: false, epoch: deactivated.state.epoch })
          } else {
            yield* projectExecutionControllerState(controllerKey, deactivated.state, store)
          }
          const before = yield* store.read(controllerKey)
          expect(before).toMatchObject({ active: false, epoch: 4 })
          if (retainedPass) expect(before).toHaveProperty('lastPass', completion.lastPass)
          else expect(before).not.toHaveProperty('lastPass')
          yield* projectExecutionControllerState(controllerKey, replayed.state, store)
          expect(yield* store.read(controllerKey)).toEqual(before)
          const passes = yield* readSystemControllerPasses(
            controllerKey,
            state.planHash,
            '2026-08-13T16:59:00.000Z',
            '2026-08-13T17:01:00.000Z',
            '2026-08-13T17:02:00.000Z',
          )
          expect(passes).toHaveLength(1)
          expect(passes[0]).toMatchObject({ epoch: state.epoch, receiptHash: completion.lastReceiptHash })
        }),
      )
    },
  )

  test('supports explicit inactive plan activation and clears inherited completion evidence', async () => {
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

  test('atomically projects a changed controller plan once without an inactive or inherited completion state', async () => {
    const controllerKey = 'a'.repeat(64)
    const old = {
      schemaVersion: 1 as const,
      controllerKey,
      planHash: 'f'.repeat(64),
      active: true,
      epoch: 3,
      nextSequence: 9,
      lastSequence: 8,
      lastOutcome: ExecutionControllerOutcome.Waiting,
      lastReceiptHash: 'b'.repeat(64),
      completedAt: '2026-11-09T18:00:00.000Z',
      nextDueAt: '2026-11-09T18:00:30.000Z',
    }
    const successor: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 4,
      planHash: 'd'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      initialSequence: 9,
      nextSequence: 9,
    }
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* ExecutionControllerStatusStore
        yield* store.project(old)
        yield* sql`
          CREATE TABLE controller_test_updates (
            active boolean NOT NULL,
            epoch bigint NOT NULL,
            plan_hash text NOT NULL,
            has_completion boolean NOT NULL
          )
        `
        yield* sql`
          CREATE FUNCTION record_controller_test_update() RETURNS trigger LANGUAGE plpgsql AS $function$
          BEGIN
            INSERT INTO controller_test_updates(active, epoch, plan_hash, has_completion)
            VALUES (
              NEW.active, NEW.epoch, NEW.plan_hash,
              NEW.last_sequence IS NOT NULL OR NEW.last_outcome IS NOT NULL OR NEW.last_receipt_hash IS NOT NULL
                OR NEW.completed_at IS NOT NULL OR NEW.next_due_at IS NOT NULL OR NEW.last_pass IS NOT NULL
            );
            RETURN NEW;
          END
          $function$
        `
        yield* sql`
          CREATE TRIGGER controller_test_update
          AFTER UPDATE ON execution_controller_status
          FOR EACH ROW EXECUTE FUNCTION record_controller_test_update()
        `
        yield* projectExecutionControllerState(controllerKey, successor, store)
        const expected = {
          schemaVersion: 1 as const,
          controllerKey,
          planHash: successor.planHash,
          active: true,
          epoch: 4,
          nextSequence: 9,
        }
        expect(yield* store.read(controllerKey)).toEqual(expected)
        yield* projectExecutionControllerState(controllerKey, successor, store)
        expect(yield* store.project(old)).toEqual({ _tag: 'Stale', status: expected })
        expect(
          yield* sql`SELECT active, epoch::integer AS epoch, plan_hash, has_completion FROM controller_test_updates`,
        ).toEqual([{ active: true, epoch: 4, plan_hash: successor.planHash, has_completion: false }])
      }),
    )
  })

  test('the database rejects plan rotations that skip epochs, move sequence, or retain completion evidence', async () => {
    const old = {
      schemaVersion: 1 as const,
      controllerKey: 'primary',
      planHash: 'f'.repeat(64),
      active: true,
      epoch: 3,
      nextSequence: 9,
      lastSequence: 8,
      lastOutcome: ExecutionControllerOutcome.Waiting,
      lastReceiptHash: 'a'.repeat(64),
      completedAt: '2026-11-09T18:00:00.000Z',
      nextDueAt: '2026-11-09T18:00:30.000Z',
    }
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* ExecutionControllerStatusStore
        yield* store.project(old)
        for (const candidate of [
          { epoch: 3, nextSequence: 9, active: true, retainCompletion: false },
          { epoch: 5, nextSequence: 9, active: true, retainCompletion: false },
          { epoch: 4, nextSequence: 8, active: true, retainCompletion: false },
          { epoch: 4, nextSequence: 10, active: true, retainCompletion: false },
          { epoch: 4, nextSequence: 9, active: false, retainCompletion: false },
          { epoch: 4, nextSequence: 9, active: true, retainCompletion: true },
        ]) {
          const rejected = yield* Effect.exit(sql`
            UPDATE execution_controller_status SET
              plan_hash = ${'d'.repeat(64)},
              active = ${candidate.active},
              epoch = ${candidate.epoch},
              next_sequence = ${candidate.nextSequence},
              last_sequence = ${candidate.retainCompletion ? old.lastSequence : null},
              last_outcome = ${candidate.retainCompletion ? old.lastOutcome : null},
              last_receipt_hash = ${candidate.retainCompletion ? old.lastReceiptHash : null},
              completed_at = ${candidate.retainCompletion ? old.completedAt : null}::timestamptz,
              next_due_at = ${candidate.retainCompletion ? old.nextDueAt : null}::timestamptz,
              last_pass = NULL
            WHERE controller_key = ${old.controllerKey}
          `)
          expect(rejected._tag).toBe('Failure')
          expect(yield* store.read(old.controllerKey)).toEqual(old)
        }
      }),
    )
  })

  test('does not silently rebind a retired unbound plan at the same epoch and sequence', async () => {
    const retired = {
      schemaVersion: 1 as const,
      controllerKey: 'retired',
      planHash: '0'.repeat(64),
      active: true,
      epoch: 3,
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
        yield* store.project(retired)
        const rebound = yield* store.project({ ...retired, planHash: 'f'.repeat(64) }).pipe(Effect.flip)
        return { rebound, stored: yield* store.read('retired') }
      }),
    )
    expect(result.rebound).toMatchObject({ operation: 'project', failure: 'conflict' })
    expect(result.stored).toEqual(retired)
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
