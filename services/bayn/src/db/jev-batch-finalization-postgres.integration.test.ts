import { beginRecordedJevBatch, evaluateRecordedJevBatch } from '../jev/batch-admission.test-support'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { evaluateAdmittedFixture } from '../jev/evaluation.test-support'
import {
  persistVisualClaimFixture,
  persistVisualTransitionFixture,
  persistHandoffFixture,
  persistEvaluationFixture,
} from '../jev/evaluation.test-support'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { entryCompletionFixture, stagedCheckpointFixture } from '../jev/entry-inference.test-support'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Deferred, Effect, Exit, Fiber, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import type { Statement } from 'effect/sql/Statement'
import {
  JevBatchPlanVersion,
  JevCandidateResultStatus,
  makeJevBatchResult,
  usableEntryBatchInferences,
} from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { JevEvaluationStore } from '../jev/evaluation'
import { JevResolutionStatus, makeJevResolution } from '../jev/resolution'
import { utcInstantFromEpochMillis } from '../time'
import { makeJevBatchStore } from './jev-batch-postgres'
import {
  describeJevBatchPostgres,
  atObservation,
  first,
  fixture,
  foreignFixture,
  immediateDispatches,
  observed,
  plan,
  requested,
  successful,
  withTestEvaluation,
} from './jev-batch-postgres.test-support'

setDefaultTimeout(30_000)

const databaseClock = Effect.runSync(Clock.clockWith(Effect.succeed))

describeJevBatchPostgres((postgres) => {
  test('finalizes recorded candidates before the deadline without serial evaluation reads', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const evaluations = yield* JevEvaluationStore
        const delayed = {
          ...evaluations,
          read: (requestId: string) =>
            evaluations.read(requestId).pipe(Effect.tap(() => TestClock.adjust('100 millis'))),
        }
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(JevEvaluationStore, delayed))
        yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload)
        for (const candidate of requested) {
          const journal = yield* EntryInferenceJournal
          const checkpoint = stagedCheckpointFixture(candidate.request, plan.observedAt)
          for (const claim of checkpoint.claims) {
            yield* persistVisualClaimFixture(journal, claim)
            const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
            if (terminal !== undefined)
              yield* persistVisualTransitionFixture(journal, { terminal: terminal, successor: { kind: 'NONE' } })
          }

          yield* persistHandoffFixture(
            yield* EntryInferenceJournal,
            entryCompletionFixture(candidate.request, plan.observedAt).handoff,
          )
          yield* persistEvaluationFixture(
            evaluations,
            candidate.request,
            Result.getOrThrow(
              makeJevEvaluationReceipt(candidate.request, {
                schemaVersion: 'bayn.jev-evaluation-receipt.v3',
                requestId: candidate.request.requestId,
                startedAt: plan.observedAt,
                completedAt: plan.observedAt,
                outcome: {
                  status: JevOutcome.Completed,
                  completion: entryCompletionFixture(candidate.request, plan.observedAt, 0.9),
                },
              }),
            ),
          )
        }
        yield* TestClock.setTime(observed + 4_700)
        const result = (yield* batches.finish(plan.batchId)).result
        if (result === null) throw new Error('Recorded batch did not finalize')
        expect(result.completedAt).toBe(utcInstantFromEpochMillis(observed + 4_700))
        expect(
          Result.getOrThrow(
            usableEntryBatchInferences(plan, result, yield* Clock.currentTimeMillis, JevBatchPlanVersion.V8),
          ),
        ).toHaveLength(requested.length)
      }).pipe(atObservation),
    )
  })

  test('concurrent finalizers seal already committed receipts into one immutable result', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const admission = yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload)
        yield* Effect.forEach(immediateDispatches(admission), evaluateAdmittedFixture, { concurrency: 'unbounded' })
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT result_hash FROM jev_batch_results`).toEqual([])
        const arrivals = yield* Deferred.make<void>()
        let inserting = 0
        const startedAt = databaseClock.currentTimeMillisUnsafe()
        const queryEvents: { query: string; event: string; elapsedMs: number }[] = []
        let eventCount = 0
        const recordQueryEvent = (query: string, event: string) => {
          eventCount += 1
          if (queryEvents.length < 64)
            queryEvents.push({ query, event, elapsedMs: databaseClock.currentTimeMillisUnsafe() - startedAt })
        }
        const simultaneous = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            const query = statement.compile()[0]
            const insertingResult = query.includes('INSERT INTO jev_batch_results')
            const category = insertingResult
              ? 'result-insert'
              : query.includes('FROM jev_batch_plans')
                ? 'batch-read'
                : query.includes('FROM jev_evaluation_requests')
                  ? 'evaluation-read'
                  : query.includes('JOIN intraday_candidate_observations')
                    ? 'observation-read'
                    : 'other'
            return withTestEvaluation(statement, () =>
              Effect.gen(function* () {
                if (insertingResult) {
                  inserting += 1
                  recordQueryEvent(category, 'barrier-arrival')
                  if (inserting === 4) yield* Deferred.succeed(arrivals, undefined)
                  yield* Deferred.await(arrivals)
                }
                recordQueryEvent(category, 'start')
                return yield* statement.pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => recordQueryEvent(category, Exit.isSuccess(exit) ? 'success' : 'failure')),
                  ),
                )
              }),
            )
          },
        })
        const competing = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, simultaneous))
        const finalized = yield* Effect.all(
          Array.from({ length: 4 }, () => competing.finish(plan.batchId)),
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.logError('Concurrent finalizer query phases', {
                  inserting,
                  eventCount,
                  queryEvents,
                  elapsedMs: databaseClock.currentTimeMillisUnsafe() - startedAt,
                })
              : Effect.void,
          ),
        )
        const saved = yield* batches.read(plan.batchId)
        if (saved === null || saved.result === null) throw new Error('Committed receipts did not finalize')
        for (const result of finalized) expect(result).toEqual(saved)
        expect(
          Result.getOrThrow(usableEntryBatchInferences(plan, saved.result, observed, JevBatchPlanVersion.V8)),
        ).toHaveLength(requested.length)
        expect(yield* sql`SELECT result_hash FROM jev_batch_results`).toEqual([
          { result_hash: saved.result.resultHash },
        ])
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_receipts`).toEqual([
          { count: requested.length },
        ])
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  test('recorded finalization races a pending recovery without a foreign-key deadlock', async () => {
    await postgres.runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const batches = yield* JevBatchStore
          const sql = yield* PgClient.PgClient
          const admission = yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload)
          const paused = yield* Deferred.make<void>()
          const resume = yield* Deferred.make<void>()
          const readyToBegin = yield* Deferred.make<void>()
          const begin = yield* Deferred.make<void>()
          const readyToInsert = yield* Deferred.make<void>()
          const insert = yield* Deferred.make<void>()
          const inserting = yield* Deferred.make<void>()
          const inserted = yield* Deferred.make<void>()
          const readyToRecord = yield* Deferred.make<void>()
          const record = yield* Deferred.make<void>()
          const evaluations = yield* JevEvaluationStore
          let prepared = 0
          // Complete authentic provider/checkpoint work before holding an idle SQL transaction.
          // Receipts remain absent until the pending finalizer selects recovery before BEGIN.
          const evaluating = yield* Effect.forEach(immediateDispatches(admission), evaluateAdmittedFixture, {
            concurrency: 'unbounded',
          }).pipe(
            Effect.provideService(JevEvaluationStore, {
              ...evaluations,
              recordAll: (entries) =>
                Effect.gen(function* () {
                  prepared += 1
                  if (prepared === immediateDispatches(admission).length)
                    yield* Deferred.succeed(readyToRecord, undefined)
                  yield* Deferred.await(record)
                  return yield* evaluations.recordAll(entries)
                }),
            }),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(readyToRecord)
          expect(prepared).toBe(immediateDispatches(admission).length)
          expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([])
          expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
          const held = new Proxy(sql, {
            get(target, property, receiver) {
              if (property === 'withTransaction')
                return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  Deferred.succeed(readyToBegin, undefined).pipe(
                    Effect.andThen(Deferred.await(begin)),
                    Effect.andThen(target.withTransaction(effect)),
                  )
              return Reflect.get(target, property, receiver)
            },
            apply(target, receiver, argumentsList) {
              const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
              const query = statement.compile()[0]
              return query.includes('SELECT request_id FROM jev_evaluation_requests') && query.includes('FOR UPDATE')
                ? Deferred.succeed(paused, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(statement),
                  )
                : statement
            },
          })
          const pending = yield* (yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, held)))
            .finish(plan.batchId)
            .pipe(Effect.forkScoped({ startImmediately: true }))
          // Keep the pending path selected while receipts are absent, but do not
          // open its transaction during expensive receipt/result reproduction.
          yield* Deferred.await(readyToBegin)
          yield* Deferred.succeed(record, undefined)
          yield* Fiber.join(evaluating)
          const monitored = new Proxy(sql, {
            apply(target, receiver, argumentsList) {
              const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
              return statement.compile()[0].includes('INSERT INTO jev_batch_results')
                ? Deferred.succeed(readyToInsert, undefined).pipe(
                    Effect.andThen(Deferred.await(insert)),
                    Effect.andThen(Deferred.succeed(inserting, undefined)),
                    Effect.andThen(statement),
                  )
                : statement
            },
          })
          const recorded = yield* (yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, monitored)))
            .finish(plan.batchId)
            .pipe(Effect.ensuring(Deferred.succeed(inserted, undefined)), Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.await(readyToInsert)
          yield* Deferred.succeed(begin, undefined)
          yield* Deferred.await(paused)
          yield* Deferred.succeed(insert, undefined)
          yield* Deferred.await(inserting)
          let observed = false
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (yield* Deferred.isDone(inserted)) {
              observed = true
              break
            }
            const [state] = yield* Schema.decodeUnknownEffect(
              Schema.Tuple([Schema.Struct({ waiting: Schema.Boolean })]),
            )(
              yield* sql`SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                AND wait_event_type='Lock' AND query LIKE ${'%INSERT INTO jev_batch_results%'}
            ) AS waiting`,
            )
            yield* Effect.sleep('5 millis').pipe(Effect.provideService(Clock.Clock, databaseClock))
            if (state?.waiting) {
              observed = true
              break
            }
          }
          yield* Deferred.succeed(resume, undefined)
          expect(observed).toBe(true)
          const results = yield* Effect.all([Fiber.join(pending), Fiber.join(recorded)], { concurrency: 'unbounded' })
          const saved = yield* batches.read(plan.batchId)
          if (saved === null || saved.result === null) throw new Error('Racing finalizers did not commit a result')
          for (const result of results) expect(result).toEqual(saved)
          expect(yield* sql`SELECT count(*)::integer AS count FROM jev_batch_results`).toEqual([{ count: 1 }])
        }),
      ).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  test('concurrent recovery commits one immutable result and seals every unattempted request', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const requests = yield* JevEvaluationStore
        yield* beginRecordedJevBatch(store, plan, fixture.observation.payload)

        yield* TestClock.adjust('10 seconds')
        const recovered = yield* Effect.all(
          Array.from({ length: 4 }, () => Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))),
          { concurrency: 'unbounded' },
        )
        const saved = yield* store.read(plan.batchId)
        if (saved?.result === null || saved === null) throw new Error('Concurrent recovery did not finalize')
        for (const result of recovered) expect(result).toEqual(saved)
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT result_hash FROM jev_batch_results`).toEqual([
          { result_hash: saved.result.resultHash },
        ])
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_resolutions`).toEqual([
          { count: requested.length },
        ])
        for (const candidate of requested.slice(1))
          expect((yield* requests.read(candidate.request.requestId))?.resolution?.status).toBe(
            JevResolutionStatus.Abandoned,
          )
      }).pipe(atObservation),
    )
  })

  test('normal completion rejects uncommitted receipt bytes, a different source and ambient transactions', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        const saved = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload)
        if (saved.result === null) throw new Error('Missing committed batch result')
        const original = saved.result.candidates.find(
          (candidate) =>
            candidate.status === JevCandidateResultStatus.Resolved && candidate.requestId === first.request.requestId,
        )
        if (original?.status !== JevCandidateResultStatus.Resolved || original.receipt === null)
          throw new Error('Missing recorded receipt')
        const { receiptHash: _receiptHash, ...material } = original.receipt
        const completedAt = utcInstantFromEpochMillis(observed + 1)
        const receipt = yield* Effect.fromResult(
          makeJevEvaluationReceipt(first.request, {
            ...material,
            completedAt,
            outcome:
              material.outcome.status === JevOutcome.Completed
                ? { ...material.outcome, completion: { ...material.outcome.completion, completedAt } }
                : material.outcome,
          }),
        )
        const resolution = yield* Effect.fromResult(
          makeJevResolution(first.request, receipt, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: first.request.requestId,
            status: JevResolutionStatus.Recorded,
            receiptHash: receipt.receiptHash,
          }),
        )
        const { resultHash: _resultHash, ...result } = saved.result
        const changed = yield* Effect.fromResult(
          makeJevBatchResult(plan, {
            ...result,
            completedAt,
            candidates: result.candidates.map((candidate) =>
              candidate === original ? { ...original, receipt, resolution } : candidate,
            ),
          }),
        )
        yield* TestClock.setTime(observed + 2)
        expect(
          Result.isFailure(yield* store.complete(plan, fixture.observation.payload, changed).pipe(Effect.result)),
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* store.complete(plan, foreignFixture.observation.payload, saved.result).pipe(Effect.result),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* sql
              .withTransaction(store.complete(plan, fixture.observation.payload, saved.result))
              .pipe(Effect.result),
          ),
        ).toBe(true)
        expect(yield* store.read(plan.batchId)).toEqual(saved)
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  test('a result that expires while its commit acknowledgement is delayed cannot supply usable inferences', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const delayed = {
          ...store,
          finish: (id: string) => store.finish(id).pipe(Effect.tap(() => TestClock.adjust('10 seconds'))),
          complete: (...args: Parameters<typeof store.complete>) =>
            store.complete(...args).pipe(Effect.tap(() => TestClock.adjust('10 seconds'))),
        }
        const saved = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, delayed),
        )
        if (saved.result === null) throw new Error('Delayed commit acknowledgement lost its result')
        expect(saved.result.completedAt).toBe(plan.observedAt)
        expect(
          Result.isFailure(
            usableEntryBatchInferences(plan, saved.result, yield* Clock.currentTimeMillis, JevBatchPlanVersion.V8),
          ),
        ).toBe(true)
        expect(yield* store.read(plan.batchId)).toEqual(saved)
      }).pipe(Effect.provideService(JevClient, entryProviderFixture(successful)), atObservation),
    )
  })

  test('a failed batch-result commit retains every paid receipt without repeating inference', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const batches = yield* JevBatchStore
        let calls = 0
        yield* sql`ALTER TABLE jev_batch_results ADD CONSTRAINT fail_cohort_completion CHECK (false)`
        const exit = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(
            JevClient,
            entryProviderFixture({
              evaluate: (request, budget) =>
                Effect.sync(() => {
                  calls++
                }).pipe(Effect.andThen(successful.evaluate(request, budget))),
            }),
          ),
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls).toBe(requested.length)
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_receipts`).toEqual([
          { count: requested.length },
        ])
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_resolutions`).toEqual([
          { count: requested.length },
        ])
        expect((yield* batches.read(plan.batchId))?.result).toBeNull()
        yield* sql`ALTER TABLE jev_batch_results DROP CONSTRAINT fail_cohort_completion`
        const recovered = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(
            JevClient,
            entryProviderFixture({ evaluate: () => Effect.die('Recovery cannot repeat paid inference') }),
          ),
        )
        expect(recovered.result).not.toBeNull()
      }).pipe(atObservation),
    )
  })
})
