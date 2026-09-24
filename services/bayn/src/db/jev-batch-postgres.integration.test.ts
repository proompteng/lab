import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  ManagedRuntime,
  Redacted,
  Result,
  Schema,
} from 'effect'
import { TestClock } from 'effect/testing'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { CycleStore, CycleStoreLive } from '../cycle/store'
import { operationalError } from '../errors'
import { canonicalHashV1 } from '../hash'
import { Authority } from '../execution/contracts'
import {
  JevCandidatePlanStatus,
  JevBatchPlanVersion,
  JevCandidateResultStatus,
  makeJevBatchPlan,
  usableJevBatchInferences,
} from '../jev/batch'
import { evaluateJevBatch, JevBatchStore, recoverJevBatch } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { JevClaim, JevEvaluationStore } from '../jev/evaluation'
import { JevResolutionStatus } from '../jev/resolution'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { tradingSignalInferenceFixture } from '../jev/trading-signal.test-support'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { candidateObservationFixture } from '../testing/candidate-observation-fixture'
import { utcInstantFromEpochMillis } from '../time'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { JevBatchStoreLive, makeJevBatchStore } from './jev-batch-postgres'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_jev_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const fixture = candidateObservationFixture()
const observed = Date.parse(fixture.input.observedAt)
const plan = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: fixture.observation.payload,
    expiresAt: utcInstantFromEpochMillis(observed + 5000),
    planVersion: JevBatchPlanVersion.V1,
  }),
)
const requested = plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested)
const first = requested[0]
if (first === undefined) throw new Error('Jev batch fixture requires a candidate')
const successful: typeof JevClient.Service = {
  evaluate: (request) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => tradingSignalInferenceFixture(request, utcInstantFromEpochMillis(now))),
    ),
}
const atObservation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(observed).pipe(Effect.andThen(effect), Effect.provide(TestClock.layer()))
const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(CycleStoreLive, CandidateObservationStoreLive, JevBatchStoreLive).pipe(
      Layer.provideMerge(JevEvaluationStoreLive),
      Layer.provideMerge(
        PostgresClientLive({
          operationTimeoutMs: 5000,
          postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

describePostgres('PostgreSQL complete Jev batches', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Jev batch tests require a local _test database')
    runtime = makeRuntime()
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
        yield* (yield* CycleStore).acquire(fixture.draft, fixture.cycle.createdAt)
        yield* (yield* CandidateObservationStore).record(fixture.observation)
        yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
        VALUES (${plan.authorityGenerationHash}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 1, ${plan.observedAt})`
      }),
    )
  })
  afterAll(async () => {
    await runtime?.dispose()
  })

  test('persists the complete plan before any request and replays a completed batch without reinference', async () => {
    let calls = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        const requests = yield* JevEvaluationStore
        expect(Result.isFailure(yield* requests.begin(first.request).pipe(Effect.result))).toBe(true)
        const stored = yield* evaluateJevBatch(plan)
        expect(stored.plan).toEqual(plan)
        expect(stored.result).not.toBeNull()
        if (stored.result === null) throw new Error('Batch did not finalize')
        expect(stored.result.candidates).toHaveLength(plan.candidates.length)
        expect(Result.getOrThrow(usableJevBatchInferences(plan, stored.result, observed))).toHaveLength(
          requested.length,
        )
        expect(yield* evaluateJevBatch(plan)).toEqual(stored)
        expect(calls).toBe(requested.length)
        expect(yield* (yield* JevBatchStore).read(plan.batchId)).toEqual(stored)
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (request) =>
            Effect.sync(() => {
              calls += 1
            }).pipe(Effect.andThen(successful.evaluate(request))),
        }),
        atObservation,
      ),
    )
  })

  for (const planVersion of [JevBatchPlanVersion.V2, JevBatchPlanVersion.V3]) {
    test(`persists ${planVersion} under the expanded database constraint`, async () => {
      const { batchId: _, ...material } = plan
      const versioned = Result.getOrThrow(makeJevBatchPlan({ ...material, schemaVersion: planVersion }))
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* JevBatchStore
          const saved = yield* store.begin(versioned)
          expect(saved).toEqual({ plan: versioned, result: null })
          expect(yield* store.read(versioned.batchId)).toEqual(saved)
        }).pipe(atObservation),
      )
    })
  }

  test('a candidate can claim a planned request while another claim holds the batch share lock', async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const batches = yield* JevBatchStore
          const evaluations = yield* JevEvaluationStore
          yield* batches.begin(plan)
          const locked = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const holder = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT batch_id FROM jev_batch_plans WHERE batch_id = ${plan.batchId} FOR SHARE`
                yield* Deferred.succeed(locked, undefined)
                yield* Deferred.await(release)
              }),
            )
            .pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.await(locked)
          expect(yield* evaluations.begin(first.request).pipe(Effect.timeout('2 seconds'))).toEqual({
            status: JevClaim.Acquired,
          })
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(holder)
          expect((yield* batches.finish(plan.batchId)).result).toBeNull()
        }),
      ).pipe(atObservation, Effect.timeout('10 seconds')),
    )
  })

  test('finalizes recorded candidates before the deadline without serial evaluation reads', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const evaluations = yield* JevEvaluationStore
        const delayed = {
          ...evaluations,
          read: (requestId: string) =>
            evaluations.read(requestId).pipe(Effect.tap(() => TestClock.adjust('100 millis'))),
        }
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(JevEvaluationStore, delayed))
        yield* batches.begin(plan)
        for (const candidate of requested) {
          yield* evaluations.begin(candidate.request)
          yield* evaluations.record(
            candidate.request,
            Result.getOrThrow(
              makeJevEvaluationReceipt(candidate.request, {
                schemaVersion: 'bayn.jev-evaluation-receipt.v1',
                requestId: candidate.request.requestId,
                startedAt: plan.observedAt,
                completedAt: plan.observedAt,
                outcome: {
                  status: JevOutcome.Received,
                  inference: tradingSignalInferenceFixture(candidate.request.request, plan.observedAt),
                },
              }),
            ),
          )
        }
        yield* TestClock.setTime(observed + 4_700)
        const result = (yield* batches.finish(plan.batchId)).result
        if (result === null) throw new Error('Recorded batch did not finalize')
        expect(result.completedAt).toBe(utcInstantFromEpochMillis(observed + 4_700))
        expect(Result.getOrThrow(usableJevBatchInferences(plan, result, yield* Clock.currentTimeMillis))).toHaveLength(
          requested.length,
        )
      }).pipe(atObservation),
    )
  })

  test('rejects a forged matching candidate observation before sealing the batch', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* batches.begin(plan)
        yield* sql`INSERT INTO intraday_candidate_observations (content_hash, cycle_id, observed_at, payload)
          VALUES (${'f'.repeat(64)}, ${plan.cycleId}, ${plan.observedAt}::timestamptz, ${sql.json(fixture.observation.payload)})`
        expect(Result.isFailure(yield* batches.finish(plan.batchId).pipe(Effect.result))).toBe(true)
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('rejects omitted candidates, unrelated source identities and a second deadline for the same observation', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const { batchId: _, ...material } = plan
        for (const change of [
          { observationHash: 'f'.repeat(64) },
          { protocolHash: 'f'.repeat(64) },
          { candidates: plan.candidates.slice(1) },
        ]) {
          const altered = Result.getOrThrow(makeJevBatchPlan({ ...material, ...change }))
          expect(Result.isFailure(yield* store.begin(altered).pipe(Effect.result))).toBe(true)
        }
        const saved = yield* store.begin(plan)
        expect(yield* store.begin(plan)).toEqual(saved)
        const second = Result.getOrThrow(
          makeJevTradingSignalBatch({
            observation: fixture.observation.payload,
            expiresAt: utcInstantFromEpochMillis(observed + 6000),
            planVersion: JevBatchPlanVersion.V1,
          }),
        )
        expect(Result.isFailure(yield* store.begin(second).pipe(Effect.result))).toBe(true)
        expect(yield* (yield* PgClient.PgClient)`SELECT batch_id FROM jev_batch_plans`).toEqual([
          { batch_id: plan.batchId },
        ])
      }).pipe(atObservation),
    )
  })

  test('expired recovery seals pending and unattempted candidates and preserves later response evidence separately', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const requests = yield* JevEvaluationStore
        yield* store.begin(plan)
        yield* requests.begin(first.request)
        expect((yield* recoverJevBatch(plan.batchId)).result).toBeNull()
        yield* TestClock.adjust('5 seconds')
        const sealed = yield* recoverJevBatch(plan.batchId)
        const result = sealed.result
        if (result === null) throw new Error('Expired batch did not finalize')
        expect(
          result.candidates.filter((candidate) => candidate.status === JevCandidateResultStatus.Unattempted),
        ).toHaveLength(requested.length - 1)
        const resolved = result.candidates.find((candidate) => candidate.symbol === first.symbol)
        if (resolved?.status !== JevCandidateResultStatus.Resolved) throw new Error('Missing abandoned candidate')
        expect(resolved.resolution.status).toBe(JevResolutionStatus.Abandoned)
        expect(resolved.receipt).toBeNull()
        const late = Result.getOrThrow(
          makeJevEvaluationReceipt(first.request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v1',
            requestId: first.request.requestId,
            startedAt: plan.observedAt,
            completedAt: plan.expiresAt,
            outcome: {
              status: JevOutcome.Received,
              inference: tradingSignalInferenceFixture(first.request.request, plan.observedAt),
            },
          }),
        )
        yield* requests.record(first.request, late)
        expect((yield* requests.read(first.request.requestId))?.receipt).toEqual(late)
        expect(yield* store.read(plan.batchId)).toEqual(sealed)
        expect(yield* recoverJevBatch(plan.batchId)).toEqual(sealed)
        for (const candidate of requested.slice(1))
          expect(Result.isFailure(yield* requests.begin(candidate.request).pipe(Effect.result))).toBe(true)
        expect(Result.isFailure(usableJevBatchInferences(plan, result, observed + 5000))).toBe(true)
      }).pipe(atObservation),
    )
  })

  test('does not invent a plan after its deadline or start one before observation', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        for (const now of [observed - 1, observed + 5000]) {
          yield* TestClock.setTime(now)
          expect(Result.isFailure(yield* store.begin(plan).pipe(Effect.result))).toBe(true)
        }
        expect(yield* store.read(plan.batchId)).toBeNull()
      }).pipe(atObservation),
    )
  })

  test('losing a plan or final-result commit acknowledgement never repeats an inference', async () => {
    let calls = 0
    const failure = operationalError({ component: 'database', operation: 'test', message: 'lost acknowledgement' })
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const lostPlan = {
          ...store,
          begin: (value: typeof plan) => store.begin(value).pipe(Effect.andThen(Effect.fail(failure))),
        }
        expect(
          Result.isFailure(
            yield* evaluateJevBatch(plan).pipe(Effect.provideService(JevBatchStore, lostPlan), Effect.result),
          ),
        ).toBe(true)
        expect(calls).toBe(0)
        const lostResult = {
          ...store,
          finish: (id: string) => store.finish(id).pipe(Effect.andThen(Effect.fail(failure))),
        }
        expect(
          Result.isFailure(
            yield* evaluateJevBatch(plan).pipe(Effect.provideService(JevBatchStore, lostResult), Effect.result),
          ),
        ).toBe(true)
        expect(calls).toBe(requested.length)
        const saved = yield* store.read(plan.batchId)
        if (saved === null || saved.result === null) throw new Error('Lost acknowledgement did not preserve result')
        expect(yield* evaluateJevBatch(plan)).toEqual(saved)
        expect(calls).toBe(requested.length)
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (request) =>
            Effect.sync(() => {
              calls += 1
            }).pipe(Effect.andThen(successful.evaluate(request))),
        }),
        atObservation,
      ),
    )
  })

  test('starts every eligible inference concurrently before finalizing the complete batch', async () => {
    let calls = 0,
      active = 0,
      maximum = 0
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wave = yield* Deferred.make<void>()
          const all = yield* Deferred.make<void>()
          const fiber = yield* evaluateJevBatch(plan).pipe(
            Effect.provideService(JevClient, {
              evaluate: (request) =>
                Effect.gen(function* () {
                  calls += 1
                  active += 1
                  maximum = Math.max(maximum, active)
                  if (calls === 4) yield* Deferred.succeed(wave, undefined)
                  if (calls === requested.length) yield* Deferred.succeed(all, undefined)
                  yield* Effect.sleep('1 second')
                  return yield* successful.evaluate(request)
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      active -= 1
                    }),
                  ),
                ),
            }),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(wave)
          expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).toBeNull()
          yield* TestClock.adjust('200 millis')
          yield* Deferred.await(all)
          yield* TestClock.adjust('1 second')
          const result = (yield* Fiber.join(fiber)).result
          if (result === null) throw new Error('Complete batch not finalized')
          expect(calls).toBe(requested.length)
          expect(maximum).toBe(requested.length)
          expect(active).toBe(0)
        }),
      ).pipe(atObservation),
    )
  })

  test('concurrent recovery commits one immutable result and seals every unattempted request', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const requests = yield* JevEvaluationStore
        yield* store.begin(plan)
        yield* requests.begin(first.request)
        yield* TestClock.adjust('5 seconds')
        const recovered = yield* Effect.all(
          Array.from({ length: 4 }, () => recoverJevBatch(plan.batchId)),
          { concurrency: 'unbounded' },
        )
        const saved = yield* store.read(plan.batchId)
        if (saved?.result === null || saved === null) throw new Error('Concurrent recovery did not finalize')
        for (const result of recovered) expect(result).toEqual(saved)
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT result_hash FROM jev_batch_results`).toEqual([
          { result_hash: saved.result.resultHash },
        ])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_resolutions`).toEqual([
          { request_id: first.request.requestId },
        ])
        for (const candidate of requested.slice(1))
          expect(Result.isFailure(yield* requests.begin(candidate.request).pipe(Effect.result))).toBe(true)
      }).pipe(atObservation),
    )
  })

  test('a result that expires while its commit acknowledgement is delayed cannot supply usable inferences', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const delayed = {
          ...store,
          finish: (id: string) => store.finish(id).pipe(Effect.tap(() => TestClock.adjust('5 seconds'))),
        }
        const saved = yield* evaluateJevBatch(plan).pipe(Effect.provideService(JevBatchStore, delayed))
        if (saved.result === null) throw new Error('Delayed commit acknowledgement lost its result')
        expect(saved.result.completedAt).toBe(plan.observedAt)
        expect(Result.isFailure(usableJevBatchInferences(plan, saved.result, yield* Clock.currentTimeMillis))).toBe(
          true,
        )
        expect(yield* store.read(plan.batchId)).toEqual(saved)
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  test('interruption leaves recoverable claims and cancels every active provider call', async () => {
    let calls = 0,
      stopped = 0
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const fiber = yield* evaluateJevBatch(plan).pipe(
            Effect.provideService(JevClient, {
              evaluate: () =>
                Effect.sync(() => {
                  calls += 1
                }).pipe(
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      stopped += 1
                    }),
                  ),
                ),
            }),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
          expect(calls).toBeGreaterThan(0)
          expect(stopped).toBe(calls)
          expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).toBeNull()
          yield* TestClock.adjust('5 seconds')
          expect((yield* recoverJevBatch(plan.batchId)).result).not.toBeNull()
          expect(stopped).toBe(calls)
        }),
      ).pipe(atObservation),
    )
  })

  test('provider defects propagate and recovery requires no provider capability', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const exit = yield* evaluateJevBatch(plan).pipe(
          Effect.provideService(JevClient, { evaluate: () => Effect.die('provider defect') }),
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        yield* TestClock.adjust('5 seconds')
        const saved = yield* recoverJevBatch(plan.batchId)
        expect(saved.result).not.toBeNull()
      }).pipe(atObservation),
    )
  })

  test('a timed-out candidate is canceled and retained beside successful peers without authorizing an entry', async () => {
    let calls = 0,
      stopped = 0
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const allStarted = yield* Deferred.make<void>()
          const fiber = yield* evaluateJevBatch(plan).pipe(
            Effect.provideService(JevClient, {
              evaluate: (request) =>
                Effect.gen(function* () {
                  calls += 1
                  if (calls === requested.length) yield* Deferred.succeed(allStarted, undefined)
                  if (canonicalHashV1(request) === first.request.requestHash)
                    return yield* Effect.never.pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          stopped += 1
                        }),
                      ),
                    )
                  return yield* successful.evaluate(request)
                }),
            }),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(allStarted)
          yield* TestClock.adjust('5 seconds')
          const saved = yield* Fiber.join(fiber)
          if (saved.result === null) throw new Error('Timed-out batch did not finalize')
          const outcomes = saved.result.candidates.flatMap((candidate) =>
            candidate.status === JevCandidateResultStatus.Resolved && candidate.receipt !== null
              ? [candidate.receipt.outcome.status]
              : [],
          )
          expect(outcomes.filter((status) => status === JevOutcome.Failed)).toHaveLength(1)
          expect(outcomes.filter((status) => status === JevOutcome.Received)).toHaveLength(requested.length - 1)
          expect(stopped).toBe(1)
          expect(calls).toBe(requested.length)
          expect(Result.isFailure(usableJevBatchInferences(plan, saved.result, observed + 5000))).toBe(true)
        }),
      ).pipe(atObservation),
    )
  })

  for (const mode of ['claim', 'record'])
    test(`a killed batch owner after ${mode} recovers in another process from database evidence only`, async () => {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* TestClock.setTime(observed).pipe(
              Effect.andThen((yield* JevBatchStore).begin(plan)),
              Effect.provide(TestClock.layer()),
            )
            const fs = yield* FileSystem.FileSystem
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const directory = yield* fs.makeTempDirectoryScoped()
            const checkpoint = `${directory}/checkpoint`,
              resultPath = `${directory}/result.json`
            const command = (mode: string) =>
              ChildProcess.make(
                process.execPath,
                [
                  `${import.meta.dir}/../jev/batch-restart-worker.test-support.ts`,
                  mode,
                  plan.batchId,
                  checkpoint,
                  resultPath,
                ],
                { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', killSignal: 'SIGKILL' },
              )
            const firstProcess = yield* spawner.spawn(command(mode))
            while (!(yield* fs.exists(checkpoint))) {
              if (!(yield* firstProcess.isRunning)) throw new Error('Batch worker died before the expected commit')
              yield* Effect.sleep('25 millis')
            }
            yield* firstProcess.kill({ killSignal: 'SIGKILL' })
            yield* Effect.exit(firstProcess.exitCode)
            yield* fs.remove(checkpoint)
            const secondProcess = yield* spawner.spawn(command('recover'))
            expect(secondProcess.pid).not.toBe(firstProcess.pid)
            expect(Number(yield* secondProcess.exitCode)).toBe(0)
            const recovered = yield* fs
              .readFileString(resultPath)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))))
            const saved = yield* (yield* JevBatchStore).read(plan.batchId)
            expect(recovered).toEqual(saved)
            const result = saved?.result?.candidates.find((candidate) => candidate.symbol === first.symbol)
            if (result?.status !== JevCandidateResultStatus.Resolved) throw new Error('Missing recovered candidate')
            expect(result.resolution.status).toBe(
              mode === 'record' ? JevResolutionStatus.Recorded : JevResolutionStatus.Abandoned,
            )
            expect(
              saved?.result?.candidates.filter(
                (candidate) => candidate.status === JevCandidateResultStatus.Unattempted,
              ),
            ).toHaveLength(requested.length - 1)
          }),
        ).pipe(Effect.timeout('25 seconds')),
      )
    }, 30000)

  test('batch mutation rejects ambient transactions and every evidence table rejects mutation', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* JevBatchStore
        expect(Result.isFailure(yield* sql.withTransaction(store.begin(plan)).pipe(Effect.result))).toBe(true)
        const stored = yield* evaluateJevBatch(plan)
        expect(Result.isFailure(yield* sql.withTransaction(store.finish(plan.batchId)).pipe(Effect.result))).toBe(true)
        for (const operation of [
          sql`UPDATE jev_batch_plans SET payload = payload`,
          sql`DELETE FROM jev_batch_plans`,
          sql`TRUNCATE jev_batch_plans CASCADE`,
          sql`UPDATE jev_batch_results SET payload = payload`,
          sql`DELETE FROM jev_batch_results`,
          sql`TRUNCATE jev_batch_results`,
        ])
          expect(Result.isFailure(yield* operation.pipe(Effect.result))).toBe(true)
        expect(yield* store.read(plan.batchId)).toEqual(stored)
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })
})
