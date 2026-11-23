import { beginRecordedJevBatch, evaluateRecordedJevBatch } from '../jev/batch-admission.test-support'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { makeEntryInferenceJournal } from './entry-inference-postgres'
import { currentEquityMarketProfile as equityMarketProfile } from '../jev/markets'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Result } from 'effect'
import { TestClock } from 'effect/testing'
import type { Statement } from 'effect/sql/Statement'
import {
  JevBatchPlanVersion,
  JevCandidateResultStatus,
  makeJevBatchPlan,
  usableEntryBatchInferences,
} from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevEvaluationStore } from '../jev/evaluation'
import { JevResolutionStatus } from '../jev/resolution'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { utcInstantFromEpochMillis } from '../time'
import { makeJevBatchStore } from './jev-batch-postgres'
import { makeJevEvaluationStore } from './jev-evaluation-postgres'
import { streamingSnapshotReference } from '../market-data/streaming/reference'
import {
  describeJevBatchPostgres,
  atObservation,
  excludedFixture,
  excludedPlan,
  fixture,
  immediateDispatches,
  observed,
  plan,
  replayAccountId,
  requested,
  successful,
} from './jev-batch-postgres.test-support'

setDefaultTimeout(30_000)

describeJevBatchPostgres((postgres) => {
  test('expired enclosing admission cannot prepare a new inference job or expense claim', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(observed + 10)
        const outcome = yield* beginRecordedJevBatch(yield* JevBatchStore, plan, fixture.observation.payload, {
          deferProviderDispatch: true,
          sourceReference: streamingSnapshotReference(fixture.snapshot),
          admissionDeadlineAt: observed + 10,
        }).pipe(Effect.result)
        expect(outcome).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'JevBatchExpired', expiresAt: utcInstantFromEpochMillis(observed + 10) },
        })
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_inference_work`).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('admits the observation and plan together without a prior observation commit', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER USER`
        yield* sql`DELETE FROM intraday_candidate_observations WHERE content_hash=${plan.observationHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER USER`
        const admitted = yield* beginRecordedJevBatch(yield* JevBatchStore, plan, fixture.observation.payload)
        expect(admitted).toMatchObject({ plan, result: null })
        expect(immediateDispatches(admitted).map(({ request }) => request.requestId)).toEqual(
          requested.map(({ request }) => request.requestId),
        )
        const rows = yield* sql`SELECT observation.content_hash, batch.batch_id
          FROM intraday_candidate_observations observation JOIN jev_batch_plans batch
            ON batch.observation_hash=observation.content_hash WHERE batch.batch_id=${plan.batchId}`
        expect(rows).toEqual([{ content_hash: plan.observationHash, batch_id: plan.batchId }])
      }).pipe(atObservation),
    )
  })

  test('rolls back a new observation when its batch cannot be admitted', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER USER`
        yield* sql`DELETE FROM intraday_candidate_observations WHERE content_hash=${plan.observationHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER USER`
        yield* sql`CREATE FUNCTION reject_batch_admission() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected batch admission failure'; END $$`
        yield* sql`CREATE TRIGGER reject_batch_admission BEFORE INSERT ON jev_batch_plans
          FOR EACH ROW EXECUTE FUNCTION reject_batch_admission()`
        const result = yield* beginRecordedJevBatch(yield* JevBatchStore, plan, fixture.observation.payload).pipe(
          Effect.result,
        )
        expect(Result.isFailure(result)).toBe(true)
        expect(yield* sql`SELECT content_hash FROM intraday_candidate_observations`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('expiry during transactional observation work rolls back admission before inference', async () => {
    let providerCalls = 0
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER USER`
        yield* sql`DELETE FROM intraday_candidate_observations WHERE content_hash=${plan.observationHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER USER`
        const expiring = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            return statement.compile()[0].includes('INSERT INTO intraday_candidate_observations')
              ? statement.pipe(Effect.tap(() => TestClock.setTime(Date.parse(plan.expiresAt))))
              : statement
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, expiring))
        yield* TestClock.setTime(Date.parse(plan.expiresAt) - 1)
        const rejected = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, batches),
          Effect.result,
        )
        expect(Result.isFailure(rejected)).toBe(true)
        if (Result.isFailure(rejected))
          expect(rejected.failure).toMatchObject({ _tag: 'JevBatchExpired', checkedAt: plan.expiresAt })
        expect(yield* sql`SELECT content_hash FROM intraday_candidate_observations`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
      }).pipe(
        atObservation,
        Effect.provideService(
          JevClient,
          entryProviderFixture({
            evaluate: () =>
              Effect.sync(() => {
                providerCalls += 1
              }).pipe(Effect.andThen(Effect.die('Expired admission must not call the provider'))),
          }),
        ),
      ),
    )
    expect(providerCalls).toBe(0)
  })

  test('candidate claim failure rolls back its new observation and plan together', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER USER`
        yield* sql`DELETE FROM intraday_candidate_observations WHERE content_hash=${plan.observationHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER USER`
        yield* sql`ALTER TABLE jev_evaluation_requests ADD CONSTRAINT reject_candidate_claim CHECK (false)`
        expect(
          Result.isFailure(
            yield* beginRecordedJevBatch(yield* JevBatchStore, plan, fixture.observation.payload).pipe(Effect.result),
          ),
        ).toBe(true)
        expect(yield* sql`SELECT content_hash FROM intraday_candidate_observations`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
      }).pipe(
        atObservation,
        Effect.provideService(
          JevClient,
          entryProviderFixture({ evaluate: () => Effect.die('Uncommitted claims cannot dispatch') }),
        ),
      ),
    )
  })

  test('admission commit crossing expiry abandons every claim without provider I/O or a fabricated receipt', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const delayed = new Proxy(sql, {
          get(target, property, receiver) {
            if (property === 'withTransaction')
              return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                target.withTransaction(effect).pipe(Effect.tap(() => TestClock.setTime(Date.parse(plan.expiresAt))))
            return Reflect.get(target, property, receiver)
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, delayed))
        const saved = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, batches),
        )
        expect(
          saved.result?.candidates.filter(
            (candidate) =>
              candidate.status === JevCandidateResultStatus.Resolved &&
              candidate.receipt === null &&
              candidate.resolution.status === JevResolutionStatus.Abandoned,
          ),
        ).toHaveLength(requested.length)
        if (saved.result === null) throw new Error('Expired claims were not finalized')
        expect(
          Result.isFailure(
            usableEntryBatchInferences(plan, saved.result, Date.parse(plan.expiresAt), JevBatchPlanVersion.V8),
          ),
        ).toBe(true)
      }).pipe(
        atObservation,
        Effect.provideService(
          JevClient,
          entryProviderFixture({ evaluate: () => Effect.die('Late admission cannot dispatch') }),
        ),
      ),
    )
  })

  test('candidate batch admission commits every initial CHART claim with its request', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const admitted = yield* beginRecordedJevBatch(yield* JevBatchStore, plan, fixture.observation.payload)
        const claims = immediateDispatches(admitted).filter((dispatch) => dispatch.visualClaim !== null)
        expect(claims.length).toBeGreaterThan(1)
        const [proof] = yield* sql`
        SELECT count(*)::integer AS claims, count(DISTINCT claim.xmin::text)::integer AS transactions,
          bool_and(claim.xmin = request.xmin AND request.xmin = batch.xmin) AS shares_admission
        FROM jev_staged_dispatch_claims claim JOIN jev_evaluation_requests request USING(request_id)
        JOIN jev_batch_plans batch ON batch.cycle_id=request.cycle_id
          AND batch.authority_generation_hash=request.authority_generation_hash
        WHERE batch.batch_id=${plan.batchId} AND claim.stage='CHART'`
        expect(proof).toEqual({ claims: claims.length, transactions: 1, shares_admission: true })
      }).pipe(atObservation),
    )
  })

  test('the full candidate universe survives two-second durable commits without extending its deadline', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        let commits = 0
        const delayed = new Proxy(sql, {
          get(target, property, receiver) {
            if (property === 'withTransaction')
              return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                target
                  .withTransaction(
                    Effect.gen(function* () {
                      const now = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
                      yield* target`UPDATE simulated_execution_clocks SET observed_at=GREATEST(observed_at,${now}::timestamptz) WHERE account_id=${replayAccountId}`
                      return yield* effect
                    }),
                  )
                  .pipe(
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        commits++
                        yield* TestClock.setTime((yield* Clock.currentTimeMillis) + 2000)
                      }),
                    ),
                  )
            return Reflect.get(target, property, receiver)
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, delayed))
        const journal = yield* makeEntryInferenceJournal.pipe(Effect.provideService(PgClient.PgClient, delayed))
        const evaluations = yield* makeJevEvaluationStore.pipe(Effect.provideService(PgClient.PgClient, delayed))
        expect(requested).toHaveLength(equityMarketProfile.candidateSymbols.length)
        const saved = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, batches),
          Effect.provideService(EntryInferenceJournal, journal),
          Effect.provideService(JevEvaluationStore, evaluations),
        )
        if (saved.result === null) throw new Error('The full-universe batch did not complete')
        expect(commits).toBeLessThanOrEqual(4)
        expect(commits).toBeGreaterThanOrEqual(3)
        expect(yield* Clock.currentTimeMillis).toBe(observed + commits * 2000)
        expect(
          Result.getOrThrow(
            usableEntryBatchInferences(plan, saved.result, yield* Clock.currentTimeMillis, JevBatchPlanVersion.V8),
          ),
        ).toHaveLength(requested.length)
        expect(plan.expiresAt).toBe(utcInstantFromEpochMillis(observed + 10000))
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  test('persists the complete plan before any request and replays a completed batch without reinference', async () => {
    let calls = 0
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        expect(yield* (yield* JevBatchStore).read(plan.batchId)).toBeNull()
        const stored = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload)
        expect(stored.plan).toEqual(plan)
        expect(stored.result).not.toBeNull()
        if (stored.result === null) throw new Error('Batch did not finalize')
        expect(stored.result.candidates).toHaveLength(plan.candidates.length)
        const sql = yield* PgClient.PgClient
        const [proof] = yield* sql`
          SELECT count(*)::integer AS receipts,
            bool_and(receipt.xmin = resolution.xmin AND resolution.xmin = result.xmin) AS shares_completion
          FROM jev_evaluation_receipts receipt JOIN jev_evaluation_resolutions resolution USING(request_id)
          JOIN jev_evaluation_requests request USING(request_id)
          JOIN jev_batch_results result ON result.batch_id=${plan.batchId}
          WHERE request.cycle_id=${plan.cycleId}`
        expect(proof).toEqual({ receipts: requested.length, shares_completion: true })
        expect(
          Result.getOrThrow(usableEntryBatchInferences(plan, stored.result, observed, JevBatchPlanVersion.V8)),
        ).toHaveLength(requested.length)
        expect(yield* evaluateRecordedJevBatch(plan, fixture.observation.payload)).toEqual(stored)
        expect(calls).toBe(requested.length)
        expect(yield* (yield* JevBatchStore).read(plan.batchId)).toEqual(stored)
      }).pipe(
        Effect.provideService(
          JevClient,
          entryProviderFixture({
            evaluate: (request, budgetMs) =>
              Effect.sync(() => {
                calls += 1
              }).pipe(Effect.andThen(successful.evaluate(request, budgetMs))),
          }),
        ),
        atObservation,
      ),
    )
  })

  test('a changed deadline cannot replace the admitted batch or its result', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        const saved = yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload).pipe(
          Effect.map(({ plan, result }) => ({ plan, result })),
        )
        const { batchId: _batchId, ...material } = excludedPlan
        const conflicting = Result.getOrThrow(
          makeJevBatchPlan({
            ...material,
            expiresAt: utcInstantFromEpochMillis(Date.parse(excludedPlan.expiresAt) - 1),
          }),
        )
        expect(conflicting.batchId).not.toBe(excludedPlan.batchId)
        const rejected = yield* beginRecordedJevBatch(batches, conflicting, excludedFixture.observation.payload).pipe(
          Effect.result,
        )
        expect(Result.isFailure(rejected)).toBe(true)
        if (Result.isFailure(rejected))
          expect(rejected.failure.message).toContain('source-controlled validity interval')
        expect(yield* batches.read(conflicting.batchId)).toBeNull()
        expect(yield* batches.read(excludedPlan.batchId)).toEqual(saved)
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([{ batch_id: excludedPlan.batchId }])
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([{ batch_id: excludedPlan.batchId }])
      }).pipe(atObservation),
    )
  })

  for (const planVersion of [JevBatchPlanVersion.V8]) {
    test(`persists ${planVersion} under the expanded database constraint`, async () => {
      const { batchId: _, ...material } = plan
      const versioned = Result.getOrThrow(makeJevBatchPlan({ ...material, schemaVersion: planVersion }))
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* JevBatchStore
          const saved = yield* beginRecordedJevBatch(store, versioned, fixture.observation.payload).pipe(
            Effect.map(({ plan, result }) => ({ plan, result })),
          )
          expect(saved).toMatchObject({ plan: versioned, result: null })
          expect(yield* store.read(versioned.batchId)).toEqual(saved)
        }).pipe(atObservation),
      )
    })
  }

  test('concurrent admission grants every candidate to one owner and retries grant no dispatch rights', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const admissions = yield* Effect.all(
          Array.from({ length: 8 }, () => beginRecordedJevBatch(store, plan, fixture.observation.payload)),
          { concurrency: 8 },
        )
        expect(admissions.filter((admission) => immediateDispatches(admission).length > 0)).toHaveLength(1)
        expect(
          admissions
            .flatMap(immediateDispatches)
            .map(({ request }) => request.requestId)
            .sort(),
        ).toEqual(requested.map(({ request }) => request.requestId).sort())
        expect((yield* beginRecordedJevBatch(store, plan, fixture.observation.payload)).dispatches).toEqual([])
        expect(
          yield* (yield* PgClient.PgClient)`SELECT count(*)::integer AS count FROM jev_evaluation_requests`,
        ).toEqual([{ count: requested.length }])
      }).pipe(atObservation),
    )
  })
})
