import { beginRecordedJevBatch, evaluateRecordedJevBatch } from '../jev/batch-admission.test-support'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import {
  persistVisualClaimFixture,
  persistVisualTransitionFixture,
  persistHandoffFixture,
  persistEvaluationFixture,
} from '../jev/evaluation.test-support'
import { EntryInferenceJournal, type EntryHandoff } from '../jev/entry-inference'
import { entryCompletionFixture, stagedCheckpointFixture } from '../jev/entry-inference.test-support'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import type { Statement } from 'effect/sql/Statement'
import { Cause, Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { utcInstantFromEpochMillis } from '../time'
import { CycleStore } from '../cycle/store/model'
import {
  JevBatchPlanVersion,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  makeJevBatchResult,
  type JevBatchPlan,
  type JevBatchResult,
  usableEntryBatchInferences,
} from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevEvaluationStore } from '../jev/evaluation'
import {
  JevOutcome,
  makeJevEvaluationReceipt,
  type JevEvaluationRequest,
  type JevEvaluationReceipt,
} from '../jev/evidence'
import { JevResolutionStatus, makeJevResolution } from '../jev/resolution'
import { JevFailure } from '../jev/contract'
import { JevPurpose } from '../jev/portfolio'
import {
  nativeJevFixture as fixtureForAccount,
  nativeJevInference,
  withObservedEntryBars,
} from '../jev/native.test-support'
import { currentEquityMarketProfile as equityMarketProfile } from '../jev/markets'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { makeJevObservation } from '../jev/observation'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { makeJevBatchStore } from './jev-batch-postgres'
import { makeJevEvaluationStore } from './jev-evaluation-postgres'
import { describeNativeJevPostgres, replayAccountId, observed, atObservation } from './jev-native-postgres.test-support'

const commitStagedHandoff = (request: JevEvaluationRequest, handoff: EntryHandoff) =>
  Effect.gen(function* () {
    const journal = yield* EntryInferenceJournal
    const checkpoint = stagedCheckpointFixture(request, handoff.recordedAt)
    for (const claim of checkpoint.claims) {
      yield* persistVisualClaimFixture(journal, claim)
      const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
      if (terminal !== undefined)
        yield* persistVisualTransitionFixture(journal, { terminal: terminal, successor: { kind: 'NONE' } })
    }

    yield* persistHandoffFixture(journal, handoff)
  })

const recordJevFixtureObservation = (input: Parameters<typeof makeJevObservation>[0]) =>
  Effect.gen(function* () {
    const observation = yield* Effect.fromResult(makeJevObservation(input))
    yield* (yield* CandidateObservationStore).record(observation)
    return observation
  })

const prepareEntryBatch = (symbols: readonly string[]) =>
  Effect.gen(function* () {
    const entry = fixtureForAccount(
      JevPurpose.Entry,
      undefined,
      replayAccountId,
      { ...defaultJevProtocolDocument, maximumSymbolWeight: 0.19 },
      '4'.repeat(64),
    )
    const sql = yield* PgClient.PgClient
    yield* sql`UPDATE simulated_execution_clocks SET observed_at = ${entry.observation.payload.observedAt}
      WHERE account_id = ${replayAccountId}`
    yield* (yield* CycleStore).acquire(entry.draft, entry.observation.payload.observedAt)
    const raw = withObservedEntryBars(
      makeIntradayMomentumTestSnapshot(
        entry.protocol,
        { ...entry.query, archiveWatermarks: [] },
        Object.fromEntries(symbols.map((symbol) => [symbol, 0.02])),
      ),
      entry.protocol,
    )
    const snapshot = streamingFixtureFromRaw(
      {
        ...raw,
        quotes: raw.quotes.map((quote) =>
          quote.symbol === 'SPY' || symbols.includes(quote.symbol)
            ? quote
            : { ...quote, askPrice: quote.bidPrice * 1.01 },
        ),
      },
      entry.query,
    ).snapshot
    const observation = yield* recordJevFixtureObservation({
      cycleId: entry.draft.identity.cycleId,
      authorityGenerationHash: entry.observation.payload.authorityGenerationHash,
      protocol: entry.protocol,
      portfolio: entry.portfolio,
      snapshot,
    })
    const plan = yield* Effect.fromResult(
      makeJevTradingSignalBatch({
        observation: observation.payload,
        expiresAt: utcInstantFromEpochMillis(observed + entry.protocol.inferenceValidityMs),
        planVersion: JevBatchPlanVersion.V8,
      }),
    )
    const requested = plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested)
    expect(plan.candidates).toHaveLength(equityMarketProfile.candidateSymbols.length)
    expect(requested.map((candidate) => candidate.symbol)).toEqual([...symbols].sort())
    const admission = yield* beginRecordedJevBatch(yield* JevBatchStore, plan, observation.payload)
    return { plan, requested, observation: observation.payload, admission }
  })

const prepareSingleEntryBatch = (symbol = 'NFLX') =>
  Effect.gen(function* () {
    const { plan, requested, observation, admission } = yield* prepareEntryBatch([symbol])
    const candidate = requested[0]
    if (candidate === undefined) throw new Error('Entry fixture requires exactly one requested candidate')
    const request = candidate.request
    const receipt = yield* Effect.fromResult(
      makeJevEvaluationReceipt(request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v3',
        requestId: request.requestId,
        startedAt: plan.observedAt,
        completedAt: plan.observedAt,
        outcome: { status: JevOutcome.Completed, completion: entryCompletionFixture(request, plan.observedAt, 0.9) },
      }),
    )
    return { plan, request, receipt, observation, admission }
  })

const singleEntryBatchResult = (plan: JevBatchPlan, request: JevEvaluationRequest, receipt: JevEvaluationReceipt) => {
  const resolution = Result.getOrThrow(
    makeJevResolution(request, receipt, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Recorded,
      receiptHash: receipt.receiptHash,
    }),
  )
  return Result.getOrThrow(
    makeJevBatchResult(plan, {
      schemaVersion: 'bayn.jev-batch-result.v1',
      batchId: plan.batchId,
      completedAt: receipt.completedAt,
      candidates: plan.candidates.map((candidate) =>
        candidate.status === JevCandidatePlanStatus.Excluded
          ? { symbol: candidate.symbol, status: JevCandidateResultStatus.Excluded }
          : {
              symbol: request.symbol,
              status: JevCandidateResultStatus.Resolved,
              requestId: request.requestId,
              receipt,
              resolution,
            },
      ),
    }),
  )
}

const monitorSql = (sql: PgClient.PgClient) => {
  const queries: string[] = []
  let transactions = 0
  const monitored = new Proxy(sql, {
    apply(target, receiver, argumentsList) {
      const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
      const [query] = statement.compile()
      // SQL fragments are composed but never executed independently.
      return /^(SELECT|INSERT|WITH)\b/.test(query.trimStart())
        ? statement.pipe(Effect.tap(() => Effect.sync(() => queries.push(query))))
        : statement
    },
    get(target, property, receiver) {
      if (property === 'withTransaction')
        return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.sync(() => {
            transactions += 1
          }).pipe(Effect.andThen(target.withTransaction(effect)))
      return Reflect.get(target, property, receiver)
    },
  })
  return { sql: monitored, queries, transactionCount: () => transactions }
}

const waitForPostgresLock = (sql: PgClient.PgClient, pid: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = yield* sql<{ blocked: boolean }>`SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked`
      if (rows[0]?.blocked) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die('Expected the concurrent batch statement to wait on its PostgreSQL lock')
  })

setDefaultTimeout(30_000)

describeNativeJevPostgres((postgres) => {
  const prepareSingleRequestBatch = prepareSingleEntryBatch()

  test(`ENTRY receipt commits its complete batch atomically and finished reads open no transaction`, async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const { plan, request, receipt, observation } = yield* prepareSingleRequestBatch
        if (receipt.outcome.status !== JevOutcome.Completed) throw new Error('Expected completed fixture')
        yield* commitStagedHandoff(request, receipt.outcome.completion.handoff)
        const requests = yield* JevEvaluationStore
        expect((yield* requests.read(request.requestId))?.resolution).toBeNull()
        const sql = yield* PgClient.PgClient
        const monitored = monitorSql(sql)
        const finishing = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, monitored.sql))
        const expected = singleEntryBatchResult(plan, request, receipt)
        yield* finishing.complete(plan, observation, expected)
        const resolution = (yield* requests.read(request.requestId))?.resolution
        if (resolution === undefined || resolution === null) throw new Error('Completed fixture has no resolution')
        expect(monitored.transactionCount()).toBe(1)
        const batch = yield* finishing.finish(plan.batchId)
        expect(monitored.transactionCount()).toBe(1)
        expect(
          yield* sql`SELECT receipt.xmin = resolution.xmin AND resolution.xmin = result.xmin AS same_transaction
          FROM jev_evaluation_receipts receipt JOIN jev_evaluation_resolutions resolution USING(request_id)
          JOIN jev_batch_results result ON result.batch_id=${plan.batchId}
          WHERE receipt.request_id=${request.requestId}`,
        ).toEqual([{ same_transaction: true }])
        if (batch === null) throw new Error('Single-request batch did not persist')
        expect(batch.result?.candidates).toEqual(
          plan.candidates.map((candidate) =>
            candidate.status === JevCandidatePlanStatus.Excluded
              ? { symbol: candidate.symbol, status: JevCandidateResultStatus.Excluded }
              : {
                  symbol: request.symbol,
                  status: JevCandidateResultStatus.Resolved,
                  requestId: request.requestId,
                  receipt,
                  resolution,
                },
          ),
        )
        const noTransaction = new Proxy(sql, {
          get(target, property, receiver) {
            if (property === 'withTransaction') return () => Effect.die('A committed batch must not open a transaction')
            return Reflect.get(target, property, receiver)
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, noTransaction))
        expect(yield* batches.finish(plan.batchId)).toEqual(batch)
        expect(yield* persistEvaluationFixture(requests, request, receipt)).toEqual(resolution)
        expect(yield* batches.finish(plan.batchId)).toEqual(batch)
      }).pipe(atObservation),
    )
  })

  test(`ENTRY batch insertion failure rolls back its receipt and resolution but retains the pre-call claim`, async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const { plan, request, receipt, observation } = yield* prepareSingleRequestBatch
        if (receipt.outcome.status !== JevOutcome.Completed) throw new Error('Expected completed fixture')
        yield* commitStagedHandoff(request, receipt.outcome.completion.handoff)
        const requests = yield* JevEvaluationStore
        const batches = yield* JevBatchStore
        const expected = singleEntryBatchResult(plan, request, receipt)

        const sql = yield* PgClient.PgClient
        yield* sql`ALTER TABLE jev_batch_results ADD CONSTRAINT fail_atomic_finalization CHECK (false)`
        expect(Result.isFailure(yield* batches.complete(plan, observation, expected).pipe(Effect.result))).toBe(true)
        expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_resolutions`).toEqual([])
        expect((yield* requests.read(request.requestId))?.resolution).toBeNull()
        expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).toBeNull()
        expect((yield* beginRecordedJevBatch(yield* JevBatchStore, plan, observation)).dispatches).toEqual([])
        yield* sql`ALTER TABLE jev_batch_results DROP CONSTRAINT fail_atomic_finalization`
        yield* batches.complete(plan, observation, expected)
        expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).not.toBeNull()
      }).pipe(atObservation),
    )
  })

  test.each(['interruption', 'defect'] as const)(
    `%s rolls back the ENTRY receipt and batch together`,
    async (failure) => {
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const { plan, request, receipt, observation } = yield* prepareSingleRequestBatch
          if (receipt.outcome.status !== JevOutcome.Completed) throw new Error('Expected completed fixture')
          yield* commitStagedHandoff(request, receipt.outcome.completion.handoff)
          const requests = yield* JevEvaluationStore

          const sql = yield* PgClient.PgClient
          const interruptedSql = new Proxy(sql, {
            get(target, property, receiver) {
              if (property === 'withTransaction')
                return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  target.withTransaction(
                    effect.pipe(
                      Effect.andThen(
                        failure === 'interruption'
                          ? Effect.interrupt
                          : Effect.die('Synthetic atomic persistence defect'),
                      ),
                    ),
                  )
              return Reflect.get(target, property, receiver)
            },
          })
          const interrupted = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, interruptedSql))
          const exit = yield* interrupted
            .complete(plan, observation, singleEntryBatchResult(plan, request, receipt))
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(failure === 'interruption')
          expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([])
          expect(yield* sql`SELECT request_id FROM jev_evaluation_resolutions`).toEqual([])
          expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).toBeNull()
          expect((yield* requests.read(request.requestId))?.resolution).toBeNull()
        }).pipe(atObservation),
      )
    },
  )

  test(`concurrent ENTRY receipt retries and finalization preserve one exact result`, async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const { plan, request, receipt, observation } = yield* prepareSingleRequestBatch
        if (receipt.outcome.status !== JevOutcome.Completed) throw new Error('Expected completed fixture')
        yield* commitStagedHandoff(request, receipt.outcome.completion.handoff)
        const requests = yield* JevEvaluationStore
        const batches = yield* JevBatchStore

        yield* Effect.all(
          [
            persistEvaluationFixture(requests, request, receipt),
            persistEvaluationFixture(requests, request, receipt),
            batches.complete(plan, observation, singleEntryBatchResult(plan, request, receipt)),
          ],
          { concurrency: 3 },
        )
        const saved = yield* batches.finish(plan.batchId)
        expect(saved.result?.candidates).toHaveLength(plan.candidates.length)
        expect((yield* requests.read(request.requestId))?.receipt).toEqual(receipt)
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([{ batch_id: plan.batchId }])
      }).pipe(atObservation),
    )
  })

  test(`a failed ENTRY inference commits complete unusable evidence without another request`, async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const { plan, request } = yield* prepareSingleRequestBatch
        const requests = yield* JevEvaluationStore
        const completion = entryCompletionFixture(request, plan.observedAt)
        yield* commitStagedHandoff(request, completion.handoff)
        const receipt = yield* Effect.fromResult(
          makeJevEvaluationReceipt(request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v3',
            requestId: request.requestId,
            startedAt: plan.observedAt,
            completedAt: plan.observedAt,
            outcome: {
              status: JevOutcome.Completed,
              completion: {
                ...completion,
                jev: {
                  status: 'FAILED',
                  failure: JevFailure.Timeout,
                  httpStatus: null,
                  responseHash: null,
                  usage: null,
                },
              },
            },
          }),
        )
        yield* persistEvaluationFixture(requests, request, receipt)
        const saved = yield* (yield* JevBatchStore).finish(plan.batchId)
        if (saved === null || saved.result === null) throw new Error('Failed inference batch did not commit')
        expect(Result.isFailure(usableEntryBatchInferences(plan, saved.result, observed, JevBatchPlanVersion.V8))).toBe(
          true,
        )
        expect((yield* requests.read(request.requestId))?.resolution?.status).toBe(JevResolutionStatus.Recorded)
      }).pipe(atObservation),
    )
  })

  test(`a late ENTRY receipt cannot replace an abandoned batch result`, async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const { plan, request, receipt } = yield* prepareSingleRequestBatch
        if (receipt.outcome.status !== JevOutcome.Completed) throw new Error('Expected completed fixture')
        yield* commitStagedHandoff(request, receipt.outcome.completion.handoff)
        const requests = yield* JevEvaluationStore
        const batches = yield* JevBatchStore

        yield* TestClock.setTime(Date.parse(plan.expiresAt))
        const abandoned = yield* batches.finish(plan.batchId)
        expect((yield* persistEvaluationFixture(requests, request, receipt)).status).toBe(JevResolutionStatus.Abandoned)
        expect(yield* batches.finish(plan.batchId)).toEqual(abandoned)
        expect((yield* requests.read(request.requestId))?.receipt).toEqual(receipt)
      }).pipe(atObservation),
    )
  })

  test(`ENTRY evidence that expires during the atomic commit stays unusable without another inference`, async () => {
    let calls = 0
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const { plan, request, observation, admission } = yield* prepareSingleRequestBatch
        const requests = yield* JevEvaluationStore
        const batches = yield* JevBatchStore
        const delayed = {
          ...batches,
          begin: () => Effect.succeed(admission),
          complete: (...args: Parameters<typeof batches.complete>) =>
            batches.complete(...args).pipe(Effect.tap(() => TestClock.setTime(Date.parse(plan.expiresAt)))),
        }
        const saved = yield* evaluateRecordedJevBatch(plan, observation).pipe(
          Effect.provideService(JevBatchStore, delayed),
          Effect.provideService(
            JevClient,
            entryProviderFixture({
              evaluate: (input) =>
                Effect.sync(() => {
                  calls += 1
                  return nativeJevInference(input, plan.observedAt, true)
                }),
            }),
          ),
        )
        if (saved.result === null) throw new Error('Atomic single-request batch did not commit')
        expect(
          Result.isFailure(
            usableEntryBatchInferences(plan, saved.result, Date.parse(plan.expiresAt), JevBatchPlanVersion.V8),
          ),
        ).toBe(true)
        expect((yield* requests.read(request.requestId))?.resolution?.status).toBe(JevResolutionStatus.Recorded)
        expect(calls).toBe(1)
      }).pipe(atObservation),
    )
  })

  test.each(['record', 'finish'] as const)(
    `ENTRY preserves the exact result when %s wins the batch lock`,
    async (winner) => {
      await postgres.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { plan, request, receipt } = yield* prepareSingleRequestBatch
            if (receipt.outcome.status !== JevOutcome.Completed) throw new Error('Expected completed fixture')
            yield* commitStagedHandoff(request, receipt.outcome.completion.handoff)
            const requests = yield* JevEvaluationStore
            const batches = yield* JevBatchStore

            if (winner === 'finish') yield* TestClock.setTime(Date.parse(plan.expiresAt))
            const sql = yield* PgClient.PgClient
            const locked = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const waiting = yield* Deferred.make<number>()
            const synchronize = (leader: boolean) =>
              new Proxy(sql, {
                apply(target, receiver, argumentsList) {
                  const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
                  const [query] = statement.compile()
                  if (!query.includes('FROM jev_batch_plans') || !/\bFOR (?:NO KEY )?UPDATE\b/.test(query))
                    return statement
                  return Effect.gen(function* () {
                    if (!leader) {
                      const rows = yield* target<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
                      const pid = rows[0]?.pid
                      if (pid === undefined) return yield* Effect.die('Expected the finalizer transaction backend')
                      yield* Deferred.succeed(waiting, pid)
                    }
                    const rows = yield* statement
                    if (leader) {
                      yield* Deferred.succeed(locked, undefined)
                      yield* Deferred.await(release)
                    }
                    return rows
                  })
                },
              })
            const recording = yield* makeJevEvaluationStore.pipe(
              Effect.provideService(PgClient.PgClient, synchronize(winner === 'record')),
            )
            const finishing = yield* makeJevBatchStore.pipe(
              Effect.provideService(PgClient.PgClient, synchronize(winner === 'finish')),
            )
            const record = persistEvaluationFixture(recording, request, receipt).pipe(Effect.asVoid)
            const finish = finishing.finish(plan.batchId).pipe(Effect.asVoid)
            const leader = yield* (winner === 'record' ? record : finish).pipe(
              Effect.forkScoped({ startImmediately: true }),
            )
            yield* Deferred.await(locked)
            const follower = yield* (winner === 'record' ? finish : record).pipe(
              Effect.forkScoped({ startImmediately: true }),
            )
            yield* waitForPostgresLock(sql, yield* Deferred.await(waiting))
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(leader)
            yield* Fiber.join(follower)
            const saved = yield* batches.finish(plan.batchId)
            const evidence = yield* requests.read(request.requestId)
            if (evidence === null || evidence.resolution === null)
              throw new Error('Concurrent persistence must retain the request resolution')
            const expectedStatus = winner === 'record' ? JevResolutionStatus.Recorded : JevResolutionStatus.Abandoned
            expect(evidence?.resolution?.status).toBe(expectedStatus)
            expect(evidence?.receipt).toEqual(receipt)
            expect(
              saved.result?.candidates.filter((candidate) => candidate.status === JevCandidateResultStatus.Excluded),
            ).toHaveLength(plan.candidates.length - 1)
            expect(
              saved.result?.candidates.find((candidate) => candidate.status === JevCandidateResultStatus.Resolved),
            ).toMatchObject({
              requestId: request.requestId,
              receipt: winner === 'record' ? receipt : null,
              resolution: evidence?.resolution,
            })
            expect(yield* persistEvaluationFixture(requests, request, receipt)).toEqual(evidence.resolution)
            expect(yield* batches.finish(plan.batchId)).toEqual(saved)
            expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([{ batch_id: plan.batchId }])
          }),
        ).pipe(atObservation, Effect.timeout('10 seconds')),
      )
    },
  )

  test.each(['AAPL', 'TSLA'])(
    'single-request ENTRY preserves exclusions when %s is at a plan boundary',
    async (symbol) => {
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const { plan, request, receipt, observation } = yield* prepareSingleEntryBatch(symbol)
          if (receipt.outcome.status !== JevOutcome.Completed) throw new Error('Expected completed fixture')
          yield* commitStagedHandoff(request, receipt.outcome.completion.handoff)
          const requests = yield* JevEvaluationStore

          yield* (yield* JevBatchStore).complete(plan, observation, singleEntryBatchResult(plan, request, receipt))
          const resolution = (yield* requests.read(request.requestId))?.resolution
          if (resolution === undefined || resolution === null) throw new Error('Completed fixture has no resolution')
          const saved = yield* (yield* JevBatchStore).read(plan.batchId)
          expect(saved?.result?.candidates.map((candidate) => candidate.symbol)).toEqual(
            plan.candidates.map((candidate) => candidate.symbol),
          )
          expect(
            saved?.result?.candidates.filter((candidate) => candidate.status === JevCandidateResultStatus.Excluded),
          ).toHaveLength(equityMarketProfile.candidateSymbols.length - 1)
          expect(
            saved?.result?.candidates[symbol === 'AAPL' ? 0 : equityMarketProfile.candidateSymbols.length - 1],
          ).toEqual({
            symbol,
            status: JevCandidateResultStatus.Resolved,
            requestId: request.requestId,
            receipt,
            resolution,
          })
        }).pipe(atObservation),
      )
    },
  )

  test('multi-request ENTRY completion waits for the batch lock and commits all final evidence together', async () => {
    await postgres.runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { plan, requested, observation } = yield* prepareEntryBatch(['AAPL', 'TSLA'])

          const sql = yield* PgClient.PgClient
          const monitored = monitorSql(sql)
          const finishing = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, monitored.sql))
          const completed = new Map<string, JevBatchResult['candidates'][number]>()
          for (const candidate of requested) {
            const request = candidate.request
            const completion = entryCompletionFixture(request, plan.observedAt, 0.9)
            yield* commitStagedHandoff(request, completion.handoff)
            const receipt = Result.getOrThrow(
              makeJevEvaluationReceipt(request, {
                schemaVersion: 'bayn.jev-evaluation-receipt.v3',
                requestId: request.requestId,
                startedAt: plan.observedAt,
                completedAt: plan.observedAt,
                outcome: { status: JevOutcome.Completed, completion },
              }),
            )
            const resolution = Result.getOrThrow(
              makeJevResolution(request, receipt, {
                schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                requestId: request.requestId,
                status: JevResolutionStatus.Recorded,
                receiptHash: receipt.receiptHash,
              }),
            )
            completed.set(request.requestId, {
              symbol: request.symbol,
              status: JevCandidateResultStatus.Resolved,
              requestId: request.requestId,
              receipt,
              resolution,
            })
          }
          const expected = Result.getOrThrow(
            makeJevBatchResult(plan, {
              schemaVersion: 'bayn.jev-batch-result.v1',
              batchId: plan.batchId,
              completedAt: plan.observedAt,
              candidates: plan.candidates.map((candidate) => {
                if (candidate.status === JevCandidatePlanStatus.Excluded)
                  return { symbol: candidate.symbol, status: JevCandidateResultStatus.Excluded }
                const entry = completed.get(candidate.request.requestId)
                if (entry === undefined) throw new Error('Missing completed fixture')
                return entry
              }),
            }),
          )
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
          const started = yield* Deferred.make<void>()
          const completing = yield* Deferred.succeed(started, undefined).pipe(
            Effect.andThen(finishing.complete(plan, observation, expected)),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(started)
          yield* Effect.yieldNow
          expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([])
          expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(holder)
          const saved = yield* Fiber.join(completing)
          expect(monitored.transactionCount()).toBe(1)
          expect(
            yield* sql`SELECT count(*)::integer AS receipts,
            bool_and(receipt.xmin=resolution.xmin AND resolution.xmin=result.xmin) AS same_transaction
            FROM jev_evaluation_receipts receipt JOIN jev_evaluation_resolutions resolution USING(request_id)
            JOIN jev_batch_results result ON result.batch_id=${plan.batchId}`,
          ).toEqual([{ receipts: 2, same_transaction: true }])
          if (saved.result === null) throw new Error('Multi-request batch did not finalize')
          expect(
            Result.getOrThrow(usableEntryBatchInferences(plan, saved.result, observed, JevBatchPlanVersion.V8)),
          ).toHaveLength(2)
        }),
      ).pipe(atObservation, Effect.timeout('10 seconds')),
    )
  })
})
