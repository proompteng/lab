import { beginRecordedJevBatch, evaluateRecordedJevBatch } from '../jev/batch-admission.test-support'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Deferred, Effect, Exit, Fiber, FileSystem, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { operationalError } from '../errors'
import { JevBatchPlanVersion, JevCandidateResultStatus, usableEntryBatchInferences } from '../jev/batch'
import { JevBatchExpired, JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { prepareJevRequest } from '../jev/contract'
import { JevOutcome } from '../jev/evidence'
import { JevResolutionStatus } from '../jev/resolution'
import { utcInstantFromEpochMillis } from '../time'
import {
  describeJevBatchPostgres,
  atObservation,
  first,
  fixture,
  observed,
  plan,
  replayAccountId,
  requested,
  successful,
} from './jev-batch-postgres.test-support'

setDefaultTimeout(30_000)

describeJevBatchPostgres((postgres) => {
  test('expired verified admission makes no claim or provider call and preserves committed recovery', async () => {
    let calls = 0
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* TestClock.setTime(observed + 16000)
        const result = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(JevBatchExpired)
          expect(result.failure).toMatchObject({
            batchId: plan.batchId,
            observedAt: plan.observedAt,
            expiresAt: plan.expiresAt,
            checkedAt: utcInstantFromEpochMillis(observed + 16000),
          })
        }
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
        expect(calls).toBe(0)
        yield* TestClock.setTime(observed)
        const saved = yield* beginRecordedJevBatch(store, plan, fixture.observation.payload).pipe(
          Effect.map(({ plan, result }) => ({ plan, result })),
        )
        yield* TestClock.setTime(observed + 16000)
        expect(yield* beginRecordedJevBatch(store, plan, fixture.observation.payload)).toMatchObject({
          plan: saved.plan,
          result: saved.result,
          dispatches: [],
        })
        expect((yield* Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))).result).not.toBeNull()
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_requests`).toEqual([
          { count: requested.length },
        ])
        expect(calls).toBe(0)
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

  test.each(['admission', 'result'] as const)('lost %s acknowledgement cannot repeat inference', async (stage) => {
    let calls = 0
    const failure = operationalError({ component: 'database', operation: 'test', message: 'lost acknowledgement' })
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const uncertain = {
          ...store,
          begin: (...input: Parameters<typeof store.begin>) =>
            stage === 'admission'
              ? store.begin(...input).pipe(Effect.andThen(Effect.fail(failure)))
              : store.begin(...input),
          finish: (id: string) =>
            stage === 'result' ? store.finish(id).pipe(Effect.andThen(Effect.fail(failure))) : store.finish(id),
          complete: (...input: Parameters<typeof store.complete>) =>
            stage === 'result'
              ? store.complete(...input).pipe(Effect.andThen(Effect.fail(failure)))
              : store.complete(...input),
        }
        expect(
          Result.isFailure(
            yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
              Effect.provideService(JevBatchStore, uncertain),
              Effect.result,
            ),
          ),
        ).toBe(true)
        expect(calls).toBe(stage === 'admission' ? 0 : requested.length)
        const retry = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload)
        expect(retry.result === null).toBe(stage === 'admission')
        expect(calls).toBe(stage === 'admission' ? 0 : requested.length)
        yield* TestClock.setTime(Date.parse(plan.expiresAt))
        const recovered = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload)
        expect(recovered.result).not.toBeNull()
        expect(yield* evaluateRecordedJevBatch(plan, fixture.observation.payload)).toEqual(recovered)
        expect(calls).toBe(stage === 'admission' ? 0 : requested.length)
      }).pipe(
        Effect.provideService(
          JevClient,
          entryProviderFixture({
            evaluate: (input, budgetMs) =>
              Effect.sync(() => {
                calls += 1
              }).pipe(Effect.andThen(successful.evaluate(input, budgetMs))),
          }),
        ),
        atObservation,
      ),
    )
  })

  test('starts every eligible inference concurrently before finalizing the complete batch', async () => {
    let calls = 0,
      active = 0,
      maximum = 0
    await postgres.runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wave = yield* Deferred.make<void>()
          const all = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const fiber = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
            Effect.provideService(
              JevClient,
              entryProviderFixture({
                evaluate: (request, budgetMs) =>
                  Effect.gen(function* () {
                    expect(budgetMs).toBeGreaterThan(0)
                    expect(budgetMs).toBeLessThanOrEqual(Date.parse(plan.expiresAt) - (yield* Clock.currentTimeMillis))
                    calls += 1
                    active += 1
                    maximum = Math.max(maximum, active)
                    if (calls === 4) yield* Deferred.succeed(wave, undefined)
                    if (calls === requested.length) yield* Deferred.succeed(all, undefined)
                    yield* Deferred.await(release)
                    return yield* successful.evaluate(request, budgetMs)
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        active -= 1
                      }),
                    ),
                  ),
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(wave)
          expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).toBeNull()
          yield* Deferred.await(all)
          expect(active).toBe(requested.length)
          expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).toBeNull()
          yield* TestClock.adjust('200 millis')
          yield* Deferred.succeed(release, undefined)
          const result = (yield* Fiber.join(fiber)).result
          if (result === null) throw new Error('Complete batch not finalized')
          expect(Date.parse(result.completedAt)).toBeLessThan(Date.parse(plan.expiresAt))
          expect(calls).toBe(requested.length)
          expect(maximum).toBe(requested.length)
          expect(active).toBe(0)
        }),
      ).pipe(atObservation),
    )
  })

  test('timely multi-candidate approvals remain usable without another recovery pass', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        expect(requested.length).toBeGreaterThan(1)
        const sql = yield* PgClient.PgClient
        const delayed = {
          ...store,
          finish: (id: string) => store.finish(id).pipe(Effect.tap(() => TestClock.adjust('1200 millis'))),
          complete: (...args: Parameters<typeof store.complete>) =>
            store.complete(...args).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  const acknowledgedAt = utcInstantFromEpochMillis(observed + 9100)
                  yield* sql`UPDATE simulated_execution_clocks SET observed_at=${acknowledgedAt}
                WHERE account_id=${replayAccountId}`
                  yield* TestClock.setTime(observed + 9100)
                }),
              ),
            ),
        }
        const saved = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, delayed),
          Effect.provideService(JevClient, entryProviderFixture(successful)),
        )
        if (saved.result === null) throw new Error('Committed approvals lost their batch result')
        expect(
          Result.isSuccess(
            usableEntryBatchInferences(plan, saved.result, yield* Clock.currentTimeMillis, JevBatchPlanVersion.V8),
          ),
        ).toBe(true)
        expect(yield* store.read(plan.batchId)).toEqual(saved)
      }).pipe(atObservation),
    )
  })

  test('interruption leaves recoverable claims and cancels every active provider call', async () => {
    let calls = 0,
      stopped = 0
    await postgres.runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const fiber = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
            Effect.provideService(
              JevClient,
              entryProviderFixture({
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
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
          expect(calls).toBeGreaterThan(0)
          expect(stopped).toBe(calls)
          expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).toBeNull()
          yield* TestClock.adjust('10 seconds')
          expect((yield* Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))).result).not.toBeNull()
          expect(stopped).toBe(calls)
        }),
      ).pipe(atObservation),
    )
  })

  test('provider defects propagate and recovery requires no provider capability', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const exit = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevClient, entryProviderFixture({ evaluate: () => Effect.die('provider defect') })),
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        yield* TestClock.adjust('10 seconds')
        const saved = yield* Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))
        expect(saved.result).not.toBeNull()
      }).pipe(atObservation),
    )
  })

  test('a completed sibling response remains durable when the rest of the cohort is interrupted', async () => {
    let calls = 0
    await postgres.runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const waiting = yield* Deferred.make<void>()
          const batches = yield* JevBatchStore
          const sql = yield* PgClient.PgClient
          const fiber = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
            Effect.provideService(
              JevClient,
              entryProviderFixture({
                evaluate: (request, budget) =>
                  Effect.suspend(() => {
                    if (++calls === 1) return successful.evaluate(request, budget)
                    return Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))
                  }),
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(waiting)
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
          expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_receipts`).toEqual([{ count: 1 }])
          expect((yield* batches.read(plan.batchId))?.result).toBeNull()
          const dispatched = calls
          yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
            Effect.provideService(
              JevClient,
              entryProviderFixture({ evaluate: () => Effect.die('An interrupted cohort cannot redispatch') }),
            ),
          )
          expect(calls).toBe(dispatched)
          yield* TestClock.setTime(Date.parse(plan.expiresAt))
          const recovered = yield* batches.finish(plan.batchId)
          expect(
            recovered.result?.candidates.filter(
              (candidate) => candidate.status === JevCandidateResultStatus.Resolved && candidate.receipt !== null,
            ),
          ).toHaveLength(1)
        }),
      ).pipe(atObservation),
    )
  })

  test('a timed-out candidate is canceled and retained beside successful peers without authorizing an entry', async () => {
    let calls = 0,
      stopped = 0
    await postgres.runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const allStarted = yield* Deferred.make<void>()
          const fiber = yield* evaluateRecordedJevBatch(plan, fixture.observation.payload).pipe(
            Effect.provideService(
              JevClient,
              entryProviderFixture({
                evaluate: (request, budgetMs) =>
                  Effect.gen(function* () {
                    calls += 1
                    if (calls === requested.length) yield* Deferred.succeed(allStarted, undefined)
                    const { symbol } = yield* Schema.decodeUnknownEffect(Schema.Struct({ symbol: Schema.String }))(
                      Result.getOrThrow(prepareJevRequest(request)).request.state,
                    ).pipe(Effect.orDie)
                    if (symbol === first.symbol)
                      return yield* Effect.never.pipe(
                        Effect.ensuring(
                          Effect.sync(() => {
                            stopped += 1
                          }),
                        ),
                      )
                    return yield* successful.evaluate(request, budgetMs)
                  }),
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(allStarted)
          yield* TestClock.adjust('10 seconds')
          const saved = yield* Fiber.join(fiber)
          if (saved.result === null) throw new Error('Timed-out batch did not finalize')
          const outcomes = saved.result.candidates.flatMap((candidate) =>
            candidate.status === JevCandidateResultStatus.Resolved &&
            candidate.receipt?.outcome.status === JevOutcome.Completed
              ? [candidate.receipt.outcome.completion.jev.status]
              : [],
          )
          expect(outcomes.filter((status) => status === 'FAILED')).toHaveLength(1)
          expect(outcomes.filter((status) => status === 'RECEIVED')).toHaveLength(requested.length - 1)
          expect(stopped).toBe(1)
          expect(calls).toBe(requested.length)
          expect(
            Result.isFailure(
              usableEntryBatchInferences(
                plan,
                saved.result,
                observed + fixture.protocol.inferenceValidityMs,
                JevBatchPlanVersion.V8,
              ),
            ),
          ).toBe(true)
        }),
      ).pipe(atObservation),
    )
  })

  for (const mode of ['claim', 'record'])
    test(`a killed batch owner after ${mode} recovers in another process from database evidence only`, async () => {
      await postgres.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* TestClock.setTime(observed).pipe(
              Effect.andThen(beginRecordedJevBatch(yield* JevBatchStore, plan, fixture.observation.payload)),
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
                {
                  stdin: 'ignore',
                  stdout: 'inherit',
                  stderr: 'inherit',
                  killSignal: 'SIGKILL',
                  env: { BAYN_TEST_POSTGRES_URL: Redacted.make(postgres.database.url) },
                  extendEnv: true,
                },
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
            ).toHaveLength(0)
          }),
        ).pipe(Effect.timeout('25 seconds')),
      )
    }, 30000)
})
