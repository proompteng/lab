import { beginRecordedJevBatch, evaluateRecordedJevBatch } from '../jev/batch-admission.test-support'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Context, Deferred, Effect, ManagedRuntime, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { makeExecutionCycleDriverLive, makeNativeEntryInferenceRuntime } from '../composition/native-execution-runtime'
import { operationalError } from '../errors'
import { Authority, KillState } from '../execution/contracts'
import { JevCandidatePlanStatus } from '../jev/batch'
import { JevBatchStore, retainedJevBatchPreparation } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevEvaluationStore } from '../jev/evaluation'
import { executeJevInferenceWork, JevInferenceWorkStore } from '../jev/inference-work'
import { streamingSnapshotReference, recoverStreamingSnapshotReference } from '../market-data/streaming/reference'
import {
  describeJevBatchPostgres,
  atObservation,
  fixture,
  immediateDispatches,
  observed,
  plan,
  successful,
} from './jev-batch-postgres.test-support'

setDefaultTimeout(30_000)

describeJevBatchPostgres((postgres) => {
  test('deferred inference survives admission before send and grants exactly one dispatch claim', async () => {
    let finishCalls = 0
    let providerCalls = 0
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const work = yield* JevInferenceWorkStore
        const admissionDeadlineAt = observed + 15_000
        const admitted = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload, {
          admissionDeadlineAt,
        }).pipe(
          Effect.provideService(JevBatchStore, {
            ...batches,
            begin: (batch, options) =>
              batches.begin(batch, {
                ...options,
                deferProviderDispatch: true,
                sourceReference: streamingSnapshotReference(fixture.snapshot),
              }),
            finish: (batchId) =>
              Effect.sync(() => {
                finishCalls += 1
              }).pipe(Effect.andThen(batches.finish(batchId))),
          }),
        )
        expect(finishCalls).toBe(0)
        expect(providerCalls).toBe(0)
        expect(admitted.plan).toEqual(plan)
        expect(admitted.result).toBeNull()
        const replayed = yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload, {
          deferProviderDispatch: true,
          sourceReference: streamingSnapshotReference(fixture.snapshot),
          admissionDeadlineAt,
        })
        expect(replayed.dispatches).toEqual([])
        expect(replayed.result).toBeNull()
        expect((yield* recoverStreamingSnapshotReference(fixture.snapshot.manifest)).manifest).toEqual(
          fixture.snapshot.manifest,
        )
        // A fresh adapter sees work even if the owner crashed before sending it.
        expect(yield* work.pending(plan.authorityGenerationHash)).toEqual([
          {
            schemaVersion: 'bayn.jev-inference-job.v1',
            jobId: plan.batchId,
            batchId: plan.batchId,
            cycleId: plan.cycleId,
            authorityGenerationHash: plan.authorityGenerationHash,
            expiresAt: plan.expiresAt,
            admissionDeadlineAt,
            status: 'Prepared',
          },
        ])
        const claims = yield* Effect.all([work.claim(plan.batchId), work.claim(plan.batchId)], { concurrency: 2 })
        const claimed = claims.find((value) => value !== null)
        expect(claims.filter((value) => value !== null)).toHaveLength(1)
        if (claimed === undefined || claimed === null) throw new Error('Expected one durable dispatch claim')
        expect(immediateDispatches(claimed.admission).length).toBe(
          plan.candidates.filter(({ status }) => status === JevCandidatePlanStatus.Requested).length,
        )
        expect(yield* work.claim(plan.batchId)).toBeNull()
        expect((yield* work.read(plan.batchId))?.status).toBe('Claimed')
        const sql = yield* PgClient.PgClient
        expect(
          Result.isFailure(
            yield* sql`UPDATE jev_inference_work SET claimed_at = NULL
          WHERE batch_id = ${plan.batchId}`.pipe(Effect.result),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* sql`UPDATE jev_inference_work SET admission_deadline_at = NULL
          WHERE batch_id = ${plan.batchId}`.pipe(Effect.result),
          ),
        ).toBe(true)
      }).pipe(
        atObservation,
        Effect.provideService(JevClient, {
          evaluate: () =>
            Effect.sync(() => {
              providerCalls += 1
            }).pipe(Effect.andThen(Effect.die('Admission cannot dispatch provider work'))),
        }),
      ),
    )
  })

  test('a compact job read cannot authorize dispatch from a changed stored plan', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const work = yield* JevInferenceWorkStore
        const sql = yield* PgClient.PgClient
        yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload, {
          deferProviderDispatch: true,
          sourceReference: streamingSnapshotReference(fixture.snapshot),
        })
        yield* sql`ALTER TABLE jev_batch_plans DISABLE TRIGGER jev_batch_plans_immutable`
        yield* sql`UPDATE jev_batch_plans SET payload = jsonb_set(payload, '{questionSetHash}', to_jsonb(${'0'.repeat(64)}::text))
          WHERE batch_id = ${plan.batchId}`
        yield* sql`ALTER TABLE jev_batch_plans ENABLE TRIGGER jev_batch_plans_immutable`
        expect((yield* work.read(plan.batchId))?.status).toBe('Prepared')
        expect(yield* work.claim(plan.batchId).pipe(Effect.result)).toMatchObject({ _tag: 'Failure' })
        expect((yield* work.read(plan.batchId))?.status).toBe('Claimed')
        expect(yield* work.claim(plan.batchId)).toBeNull()
      }).pipe(atObservation),
    )
  })

  test('source tampering after durable admission burns the claim without granting provider dispatch', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const work = yield* JevInferenceWorkStore
        const sql = yield* PgClient.PgClient
        yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload, {
          deferProviderDispatch: true,
          sourceReference: streamingSnapshotReference(fixture.snapshot),
        })
        expect(
          yield* sql`UPDATE jev_inference_work
            SET source_sha256=decode(repeat('00',32),'hex'), claimed_at=clock_timestamp()
            WHERE batch_id=${plan.batchId}`.pipe(Effect.result),
        ).toMatchObject({ _tag: 'Failure' })
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER intraday_candidate_observations_immutable`
        yield* sql`UPDATE intraday_candidate_observations SET payload=payload || '{"sourceChanged": true}'::jsonb
          WHERE content_hash = ${plan.observationHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER intraday_candidate_observations_immutable`
        expect(yield* work.claim(plan.batchId).pipe(Effect.result)).toMatchObject({ _tag: 'Failure' })
        expect((yield* work.read(plan.batchId))?.status).toBe('Claimed')
        expect(yield* work.claim(plan.batchId)).toBeNull()
      }).pipe(atObservation),
    )
  })

  test('completion rejects a copied source claim and a source changed after dispatch', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const work = yield* JevInferenceWorkStore
        const sql = yield* PgClient.PgClient
        yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload, {
          deferProviderDispatch: true,
          sourceReference: streamingSnapshotReference(fixture.snapshot),
        })
        let attemptedCompletion = false
        const run = yield* executeJevInferenceWork(plan.batchId).pipe(
          Effect.provideService(JevBatchStore, {
            ...batches,
            complete: (sourcePlan, source, result) =>
              Effect.gen(function* () {
                if (typeof source !== 'object' || source === null) throw new Error('Missing claimed source')
                expect(yield* batches.complete(sourcePlan, { ...source }, result).pipe(Effect.result)).toMatchObject({
                  _tag: 'Failure',
                })
                yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER intraday_candidate_observations_immutable`
                yield* sql`UPDATE intraday_candidate_observations SET payload=payload || '{"sourceChanged": true}'::jsonb
                    WHERE content_hash = ${plan.observationHash}`
                yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER intraday_candidate_observations_immutable`
                yield* sql`ALTER TABLE jev_inference_work DISABLE TRIGGER guard_jev_inference_work`
                yield* sql`UPDATE jev_inference_work
                  SET source_sha256 = sha256(convert_to(observation.payload::text, 'UTF8'))
                  FROM intraday_candidate_observations observation
                  WHERE batch_id = ${plan.batchId} AND observation.content_hash = ${plan.observationHash}`
                yield* sql`ALTER TABLE jev_inference_work ENABLE TRIGGER guard_jev_inference_work`
                attemptedCompletion = true
                return yield* batches.complete(sourcePlan, source, result)
              }).pipe(
                Effect.mapError((cause) =>
                  operationalError({ component: 'database', operation: 'test', message: 'Completion rejected', cause }),
                ),
              ),
          }),
          Effect.result,
        )
        expect(attemptedCompletion).toBe(true)
        expect(run).toMatchObject({ _tag: 'Failure' })
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
        expect(yield* work.claim(plan.batchId)).toBeNull()
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  test('a lost claimed worker never redispatches provider work and settles at the original expiry', async () => {
    let providerCalls = 0
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const work = yield* JevInferenceWorkStore
        yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload, {
          deferProviderDispatch: true,
          sourceReference: streamingSnapshotReference(fixture.snapshot),
        })
        yield* work.claim(plan.batchId)
        const pending = yield* executeJevInferenceWork(plan.batchId)
        expect(pending).toMatchObject({ status: 'Pending', expiresAt: plan.expiresAt })
        expect(providerCalls).toBe(0)
        yield* TestClock.setTime(Date.parse(plan.expiresAt))
        const settled = yield* executeJevInferenceWork(plan.batchId)
        expect(settled).toMatchObject({ status: 'Completed', expiresAt: plan.expiresAt })
        expect(providerCalls).toBe(0)
        expect(yield* work.pending()).toEqual([])
      }).pipe(
        atObservation,
        Effect.provideService(JevClient, {
          evaluate: () =>
            Effect.sync(() => {
              providerCalls += 1
            }).pipe(Effect.andThen(Effect.die('Claimed work cannot redispatch'))),
        }),
      ),
    )
  })

  test('the native worker settles admitted inference during a stalled financial startup and reuses its exact result', async () => {
    let providerCalls = 0
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const work = yield* JevInferenceWorkStore
        const sql = yield* PgClient.PgClient
        const scope = {
          controllerKey: '1'.repeat(64),
          planHash: '2'.repeat(64),
          accountId: fixture.portfolio.brokerState.account.accountId,
        }
        yield* sql`INSERT INTO execution_controller_status (controller_key, plan_hash, epoch, next_sequence, active)
          VALUES (${scope.controllerKey}, ${scope.planHash}, 1, 0, true)`
        yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload, {
          deferProviderDispatch: true,
          sourceReference: streamingSnapshotReference(fixture.snapshot),
          admissionDeadlineAt: observed + 15_000,
        })
        yield* sql`INSERT INTO authority_state (schema_version, generation_hash, maximum, effective, kill_state, version, updated_at)
          VALUES ('bayn.paper-authority.v1', ${plan.authorityGenerationHash}, ${Authority.Observe}, ${Authority.Observe},
            ${KillState.Clear}, 1, ${plan.observedAt})`
        const services = yield* Effect.context<
          | JevBatchStore
          | JevEvaluationStore
          | JevClient
          | EntryInferenceJournal
          | JevInferenceWorkStore
          | PgClient.PgClient
        >()
        const clock = yield* Clock.Clock
        const inference = makeNativeEntryInferenceRuntime(
          {
            runPromise: Effect.runPromiseWith(Context.add(services, Clock.Clock, clock)),
          },
          scope,
        )
        const initializing = yield* Deferred.make<void>()
        const financial = yield* Effect.acquireRelease(
          Effect.sync(() =>
            ManagedRuntime.make(
              makeExecutionCycleDriverLive(
                5_000,
                Deferred.succeed(initializing, undefined).pipe(Effect.andThen(Effect.never)),
              ),
            ),
          ),
          (runtime) => runtime.disposeEffect,
        )
        const startup = yield* Effect.promise((signal) => financial.runPromiseExit(Effect.void, { signal })).pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(initializing)
        const oldCommand = {
          schemaVersion: 'bayn.inference-dispatch.v1',
          controllerKey: scope.controllerKey,
          epoch: 1,
          sourceRevision: 'a'.repeat(40),
          jobId: plan.batchId,
        } as const
        const dispatched = yield* Effect.promise((signal) => inference.awaitDispatch(oldCommand, [], signal))
        expect(dispatched).toEqual({ active: true, pending: [plan.batchId], dispatch: [plan.batchId] })
        yield* sql`UPDATE execution_controller_status SET epoch=2 WHERE controller_key=${scope.controllerKey}`
        expect(yield* Effect.promise((signal) => inference.awaitDispatch(oldCommand, [], signal))).toEqual({
          active: false,
        })
        expect(yield* Effect.promise((signal) => inference.executeInference(oldCommand, signal))).toMatchObject({
          status: 'Pending',
        })
        expect(providerCalls).toBe(0)
        expect((yield* work.read(plan.batchId))?.status).toBe('Prepared')
        const execute = Effect.promise((signal) => inference.executeInference({ ...oldCommand, epoch: 2 }, signal))
        const completed = yield* execute
        expect(completed).toMatchObject({ status: 'Completed', expiresAt: plan.expiresAt })
        expect(startup.pollUnsafe()).toBeUndefined()
        const recorded = yield* batches.read(plan.batchId)
        expect(recorded?.result?.resultHash).toBe(completed?.status === 'Completed' ? completed.resultHash : undefined)
        expect(recorded && retainedJevBatchPreparation(recorded)?.plan).toEqual(plan)
        const firstCalls = providerCalls
        expect(firstCalls).toBeGreaterThan(0)
        expect(yield* execute).toEqual(completed)
        expect(providerCalls).toBe(firstCalls)
        const resumed = yield* work.resume(plan.cycleId, plan.authorityGenerationHash)
        expect(resumed?.batchId).toBe(plan.batchId)
        if (resumed === null) throw Error('expected committed inference to resume')
        expect(yield* resumed.loadSource).toEqual({
          observation: fixture.observation.payload,
          snapshot: fixture.snapshot,
          contentHash: plan.observationHash,
        })
        expect(yield* work.resume(plan.cycleId, 'e'.repeat(64))).toBeNull()
        expect(yield* work.pending()).toEqual([])
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER intraday_candidate_observations_immutable`
        yield* sql`UPDATE intraday_candidate_observations SET payload = payload || '{"changedAfterCompletion":true}'::jsonb
          WHERE content_hash = ${plan.observationHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER intraday_candidate_observations_immutable`
        expect(yield* work.resume(plan.cycleId, plan.authorityGenerationHash).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
        })
        yield* TestClock.setTime(observed + 15_000)
        expect(yield* work.resume(plan.cycleId, plan.authorityGenerationHash)).toBeNull()
      }).pipe(
        Effect.scoped,
        atObservation,
        Effect.provideService(JevClient, {
          evaluate: (...args) =>
            Effect.sync(() => {
              providerCalls += 1
            }).pipe(Effect.andThen(entryProviderFixture(successful).evaluate(...args))),
        }),
      ),
    )
  })

  test('inference outbox failure rolls back plan and initial paid-work claims atomically', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE FUNCTION reject_inference_work() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected work admission failure'; END $$`
        yield* sql`CREATE TRIGGER reject_inference_work BEFORE INSERT ON jev_inference_work
          FOR EACH ROW EXECUTE FUNCTION reject_inference_work()`
        const batches = yield* JevBatchStore
        expect(
          Result.isFailure(
            yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload, {
              deferProviderDispatch: true,
              sourceReference: streamingSnapshotReference(fixture.snapshot),
            }).pipe(Effect.result),
          ),
        ).toBe(true)
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_staged_dispatch_claims`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_inference_work`).toEqual([])
        expect(yield* sql`SELECT snapshot_id FROM streaming_snapshot_references`).toEqual([])
      }).pipe(atObservation),
    )
  })

  test.each(['operator kill', 'safety restriction', 'different account', 'different authority generation'])(
    'ineligible dispatch keeps committed work prepared: %s',
    async (policy) => {
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const work = yield* JevInferenceWorkStore
          const sql = yield* PgClient.PgClient
          yield* beginRecordedJevBatch(yield* JevBatchStore, plan, fixture.observation.payload, {
            deferProviderDispatch: true,
            sourceReference: streamingSnapshotReference(fixture.snapshot),
          })
          const controller = {
            controllerKey: '3'.repeat(64),
            planHash: '4'.repeat(64),
            accountId: fixture.portfolio.brokerState.account.accountId,
            epoch: 1,
          }
          yield* sql`INSERT INTO execution_controller_status (controller_key, plan_hash, epoch, next_sequence, active)
          VALUES (${controller.controllerKey}, ${controller.planHash}, ${controller.epoch}, 0, true)`
          yield* sql`INSERT INTO authority_state (schema_version, generation_hash, maximum, effective, kill_state, version, updated_at)
          VALUES ('bayn.paper-authority.v1', ${plan.authorityGenerationHash}, ${Authority.Observe}, ${Authority.Observe},
            ${KillState.Clear}, 1, ${plan.observedAt})`
          if (policy === 'operator kill') {
            yield* sql`UPDATE authority_state SET kill_state=${KillState.Active}, reason='fixture',
            version=2, updated_at=updated_at+interval '1 millisecond'`
          }
          if (policy === 'different authority generation') {
            const successor = 'e'.repeat(64)
            yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, previous_generation_hash,
            maximum, authority_version, activated_at)
            VALUES (${successor}, 'bayn.authority-generation-history.v1', ${plan.authorityGenerationHash},
              ${Authority.Observe}, 2, ${plan.observedAt}::timestamptz+interval '1 millisecond')`
            yield* sql`UPDATE authority_state SET generation_hash=${successor}, version=2,
            updated_at=updated_at+interval '1 millisecond'`
          }
          if (policy === 'safety restriction') {
            // Seed the already-restricted state without creating unrelated capital-grant evidence.
            yield* sql`ALTER TABLE authority_state DISABLE TRIGGER authority_transition_only`
            yield* sql`UPDATE authority_state SET maximum=${Authority.Execution}, version=2,
            updated_at=updated_at+interval '1 millisecond'`
            yield* sql`ALTER TABLE authority_state ENABLE TRIGGER authority_transition_only`
          }
          const outcome = yield* executeJevInferenceWork(
            plan.batchId,
            policy === 'different account' ? { ...controller, accountId: 'different-account' } : controller,
          )
          expect(outcome?.status).toBe('Pending')
          expect((yield* work.read(plan.batchId))?.status).toBe('Prepared')
        }).pipe(
          atObservation,
          Effect.provideService(JevClient, { evaluate: () => Effect.die('Withdrawn authority cannot spend') }),
        ),
      )
    },
  )
})
