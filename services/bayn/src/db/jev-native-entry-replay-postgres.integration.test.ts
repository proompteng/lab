import { beginRecordedJevBatch } from '../jev/batch-admission.test-support'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { chartProviderFixture } from '../jev/entry-inference.test-support'
import { makeReplayInferenceBudget } from '../intraday-replay/inference-timing'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Deferred, Effect, Fiber, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { makeReplayInferenceTiming, type ReplayInferenceCall } from '../intraday-replay/inference-timing'
import { makeSimulatedExecutionClock } from '../intraday-replay/clock'
import { utcInstantFromEpochMillis } from '../time'
import { CycleStore } from '../cycle/store/model'
import { canonicalHashV1Result } from '../hash'
import { JevBatchPlanVersion, JevEntryExclusion, makeJevBatchPlan } from '../jev/batch'
import { decideJevEntry } from '../jev/decision'
import { JevBatchStore, recoverPendingJevBatches } from '../jev/batch-evaluation'
import { JevClient, JevError } from '../jev/client'
import { JevFailure } from '../jev/contract'
import { JevPurpose } from '../jev/portfolio'
import {
  nativeJevFixture as fixtureForAccount,
  nativeJevInference,
  withObservedEntryBars,
} from '../jev/native.test-support'
import {
  evaluateJevObservation,
  evaluateJevObservationFromSnapshot,
  evaluateJevPositionManagement,
} from '../jev/runtime'
import { JevExitReason } from '../jev/exit'
import { currentEquityMarketProfile as equityMarketProfile } from '../jev/markets'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { fixtureStreamingReference, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import {
  describeNativeJevPostgres,
  replayAccountId,
  premiums,
  nativeJevFixture,
  fixture,
  observed,
  atObservation,
  nativeInput,
  acquireEntryCycle,
  seedManagedPosition,
} from './jev-native-postgres.test-support'

setDefaultTimeout(30_000)

describeNativeJevPostgres((postgres) => {
  test('current model trade policy requires its own cycle and persists every eligible candidate', async () => {
    const candidate = fixtureForAccount(
      JevPurpose.Entry,
      undefined,
      replayAccountId,
      { ...defaultJevProtocolDocument, maximumSymbolWeight: 0.19 },
      '4'.repeat(64),
    )
    const { protocol } = candidate
    const calls: string[] = []
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        // A changed policy must acquire its own bound cycle.
        expect(Result.isFailure(yield* evaluateJevObservation({ ...nativeInput, protocol }).pipe(Effect.result))).toBe(
          true,
        )
        expect(calls).toEqual([])
        const sql = yield* PgClient.PgClient
        yield* sql`UPDATE simulated_execution_clocks SET observed_at = ${candidate.observation.payload.observedAt}
          WHERE account_id = ${replayAccountId}`
        yield* (yield* CycleStore).acquire(candidate.draft, candidate.observation.payload.observedAt)
        const result = yield* evaluateJevObservation({
          cycleId: candidate.draft.identity.cycleId,
          authorityGenerationHash: candidate.observation.payload.authorityGenerationHash,
          protocol,
          portfolio: candidate.portfolio,
          snapshot: candidate.snapshot,
        })
        expect(result.batchPlan.schemaVersion).toBe(JevBatchPlanVersion.V8)
        expect(calls.toSorted()).toEqual([...equityMarketProfile.candidateSymbols].sort())
        expect(result.batchPlan.candidates.filter((candidate) => candidate.status === 'EXCLUDED')).toHaveLength(0)
        expect(Result.getOrThrow(decideJevEntry(result)).selectedSymbols).toEqual(['AAPL'])
        const store = yield* JevBatchStore
        expect((yield* store.read(result.batchPlan.batchId))?.plan).toEqual(result.batchPlan)
        const [row] =
          yield* sql`SELECT payload FROM intraday_candidate_observations WHERE content_hash = ${result.batchPlan.observationHash}`
        expect(row?.['payload']).toEqual(result.observation)
        const { batchId: _, ...rebound } = Result.getOrThrow(
          makeJevTradingSignalBatch({
            observation: { ...result.observation, authorityGenerationHash: '0'.repeat(64) },
            expiresAt: result.batchPlan.expiresAt,
            planVersion: JevBatchPlanVersion.V8,
          }),
        )
        const wrongIdentity = Result.getOrThrow(
          makeJevBatchPlan({ ...rebound, observationHash: result.batchPlan.observationHash }),
        )
        expect(
          Result.isFailure(yield* beginRecordedJevBatch(store, wrongIdentity, result.observation).pipe(Effect.result)),
        ).toBe(true)
        expect(yield* sql`SELECT count(*)::int AS count FROM jev_batch_plans`).toEqual([{ count: 1 }])
      }).pipe(
        Effect.provideService(
          JevClient,
          entryProviderFixture({
            evaluate: (request) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((now) => {
                  const symbol = Schema.decodeUnknownSync(
                    Schema.Struct({ state: Schema.Struct({ symbol: Schema.String }) }),
                  )(request).state.symbol
                  calls.push(symbol)
                  return nativeJevInference(request, utcInstantFromEpochMillis(now), true)
                }),
              ),
          }),
        ),
        atObservation,
      ),
    )
  })

  test.each([JevPurpose.Entry, JevPurpose.Manage])(
    'stale benchmark quotes wait without consuming the %s window or preventing fresh inference',
    async (purpose) => {
      let calls = 0
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const atMs = observed + 30_000
          const at = utcInstantFromEpochMillis(atMs)
          yield* TestClock.setTime(atMs)
          const fresh = nativeJevFixture(JevPurpose.Entry, at)
          if (purpose === JevPurpose.Entry) yield* acquireEntryCycle(at)
          const selected =
            purpose === JevPurpose.Manage
              ? yield* seedManagedPosition({ observedAt: at })
              : { managed: fresh, portfolio: fresh.portfolio }
          const sql = yield* PgClient.PgClient
          let portfolio = selected.portfolio
          if (purpose === JevPurpose.Entry) {
            const r = { ...portfolio.brokerState.reconciliation, reconciliationId: '9'.repeat(64) }
            portfolio = { ...portfolio, brokerState: { ...portfolio.brokerState, reconciliation: r } }
            yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
              content_hash, status, discrepancies, reconciled_at) VALUES (${r.reconciliationId}, ${r.schemaVersion}, ${r.accountId},
              ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
          }
          const query = selected.managed.snapshot.manifest
          const original = withObservedEntryBars(
            makeIntradayMomentumTestSnapshot(fixture.protocol, { ...query, archiveWatermarks: [] }, premiums),
            fixture.protocol,
          )
          const raw = {
            ...original,
            trades: original.trades.map((trade) =>
              trade.symbol === 'SPY'
                ? {
                    ...trade,
                    eventAt: utcInstantFromEpochMillis(atMs - 61_000),
                    ingestedAt: utcInstantFromEpochMillis(atMs - 61_000),
                  }
                : trade,
            ),
          }
          const loadSnapshot = Effect.try({
            try: () =>
              streamingFixtureFromRaw(
                {
                  ...raw,
                  quotes: raw.quotes.map((quote) =>
                    quote.symbol === 'SPY' ? { ...quote, eventAt: utcInstantFromEpochMillis(atMs - 10_422) } : quote,
                  ),
                },
                query,
              ).snapshot,
            catch: (cause) => cause,
          })
          const input = { ...nativeInput, portfolio }
          const result = yield* evaluateJevObservationFromSnapshot(
            input,
            query.rangeEndAt,
            loadSnapshot,
            JevBatchPlanVersion.V8,
          ).pipe(Effect.result)
          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'IntradaySnapshotFailure', reason: 'freshness', facts: { symbol: 'SPY' } },
          })
          expect(calls).toBe(0)
          expect(yield* sql`SELECT count(*)::integer AS count FROM intraday_candidate_observations`).toEqual([
            { count: 0 },
          ])
          expect(yield* sql`SELECT count(*)::integer AS count FROM jev_batch_plans`).toEqual([{ count: 0 }])
          if (portfolio.purpose === JevPurpose.Manage) {
            const cycle = Option.getOrThrow(yield* (yield* CycleStore).read(nativeInput.cycleId))
            expect(
              yield* evaluateJevPositionManagement({
                cycle,
                entryDecisionHash: portfolio.entryDecisionHash,
                authorityGenerationHash: nativeInput.authorityGenerationHash,
                protocol: fixture.protocol,
                calendar: query.calendar,
                brokerState: portfolio.brokerState,
                marketData: {
                  check: Effect.void,
                  verifyReference: fixtureStreamingReference,
                  loadSnapshot: (pricingQuery) =>
                    pricingQuery.purpose === undefined
                      ? loadSnapshot.pipe(Effect.orDie)
                      : Effect.sync(
                          () =>
                            streamingFixtureFromRaw(
                              makeIntradayMomentumTestSnapshot(
                                fixture.protocol,
                                { ...pricingQuery, archiveWatermarks: [] },
                                { AAPL: 0.08 },
                              ),
                              pricingQuery,
                            ).snapshot,
                        ),
                },
              }),
            ).toMatchObject({ _tag: 'Exit', target: { reason: JevExitReason.ProfitTarget } })
            expect(calls).toBe(0)
          }
          if (purpose === JevPurpose.Entry) {
            const recovered = yield* evaluateJevObservation({
              ...input,
              snapshot: streamingFixtureFromRaw(raw, query).snapshot,
            })
            expect(recovered.batchPlan.observedAt).toBe(query.observedAt)
            expect(recovered.batchPlan.schemaVersion).toBe(JevBatchPlanVersion.V8)
            expect(calls).toBe(equityMarketProfile.candidateSymbols.length)
          } else {
            expect(calls).toBe(0)
          }
        }).pipe(
          Effect.provideService(
            JevClient,
            entryProviderFixture({
              evaluate: (request) =>
                Clock.currentTimeMillis.pipe(
                  Effect.map((now) => {
                    calls += 1
                    return nativeJevInference(
                      request,
                      utcInstantFromEpochMillis(now),
                      purpose === JevPurpose.Entry ? true : false,
                    )
                  }),
                ),
            }),
          ),
          atObservation,
        ),
      )
    },
  )

  test('stale source and verified wide entry quotes do not call Jev for those candidates', async () => {
    let calls = 0
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const atMs = observed + 30_000
        const at = utcInstantFromEpochMillis(atMs)
        yield* TestClock.setTime(atMs)
        const fresh = nativeJevFixture(JevPurpose.Entry, at)
        yield* acquireEntryCycle(at)
        const reconciliation = {
          ...fresh.portfolio.brokerState.reconciliation,
          reconciliationId: '9'.repeat(64),
        }
        const portfolio = {
          ...fresh.portfolio,
          brokerState: { ...fresh.portfolio.brokerState, reconciliation },
        }
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
          content_hash, status, discrepancies, reconciled_at) VALUES (${reconciliation.reconciliationId},
          ${reconciliation.schemaVersion}, ${reconciliation.accountId}, ${reconciliation.expectedHash},
          ${reconciliation.observedHash}, ${reconciliation.contentHash}, ${reconciliation.status}, '[]'::jsonb,
          ${reconciliation.reconciledAt})`
        const query = fresh.snapshot.manifest
        const raw = withObservedEntryBars(
          makeIntradayMomentumTestSnapshot(fixture.protocol, { ...query, archiveWatermarks: [] }, premiums),
          fixture.protocol,
        )
        const staleAt = utcInstantFromEpochMillis(atMs - fixture.protocol.maximumQuoteAgeMs - 1)
        const staleEvidence = {
          ...raw,
          quotes: raw.quotes.map((quote) =>
            quote.symbol === 'AMZN'
              ? { ...quote, eventAt: staleAt, ingestedAt: staleAt }
              : quote.symbol === 'AAPL'
                ? { ...quote, askPrice: quote.bidPrice * 1.01 }
                : quote,
          ),
          trades: raw.trades.map((trade) =>
            trade.symbol === 'AMZN' ? { ...trade, eventAt: staleAt, ingestedAt: staleAt } : trade,
          ),
        }
        const snapshot = streamingFixtureFromRaw(staleEvidence, query).snapshot
        expect(snapshot.manifest.candidateExclusions).toContainEqual(
          expect.objectContaining({ symbol: 'AMZN', reason: 'freshness' }),
        )
        const result = yield* evaluateJevObservation({ ...nativeInput, portfolio, snapshot })
        expect(result.batchPlan.schemaVersion).toBe(JevBatchPlanVersion.V8)
        expect(result.batchPlan.candidates).toContainEqual(
          expect.objectContaining({ symbol: 'AMZN', status: 'EXCLUDED' }),
        )
        expect(result.batchPlan.candidates).toContainEqual(
          expect.objectContaining({ symbol: 'AAPL', status: 'EXCLUDED', reason: JevEntryExclusion.Spread }),
        )
        expect(calls).toBe(equityMarketProfile.candidateSymbols.length - 2)
      }).pipe(
        Effect.provideService(
          JevClient,
          entryProviderFixture({
            evaluate: (request) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((now) => {
                  calls += 1
                  return nativeJevInference(request, utcInstantFromEpochMillis(now), true)
                }),
              ),
          }),
        ),
        atObservation,
      ),
    )
  })

  test.each([10, 6000])(
    'native batch uses measured replay inference time and its original deadline (%sms)',
    async (latencyMs) => {
      await postgres.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireEntryCycle()
            const providerClock = yield* TestClock.make()
            yield* providerClock.setTime(Date.parse('2026-09-21T12:00:00.000Z'))
            const clock = yield* makeSimulatedExecutionClock('e'.repeat(64), 'e'.repeat(64), providerClock)
            const advance = (atMs: number) =>
              clock
                .advanceTo(utcInstantFromEpochMillis(atMs))
                .pipe(Effect.andThen(TestClock.setTime(atMs)), Effect.orDie)
            const calls: ReplayInferenceCall[] = []
            const journal = yield* EntryInferenceJournal
            const journalFailures: unknown[] = []
            const causeSummary = (value: unknown, depth = 0): unknown => {
              if (depth >= 6 || value === null || typeof value !== 'object') return null
              return Object.fromEntries([
                ...['message', 'code', 'constraint', 'table'].flatMap((key) => {
                  const item: unknown = Reflect.get(value, key)
                  return typeof item === 'string' ? [[key, item.slice(0, 400)]] : []
                }),
                ...['cause', 'reason'].map((key) => [key, causeSummary(Reflect.get(value, key), depth + 1)]),
              ])
            }
            const retainFailure =
              (operation: string, stage: string, at: string, expiresAt: string | null) => (error: unknown) =>
                Effect.sync(() => {
                  if (journalFailures.length < 4)
                    journalFailures.push({ operation, stage, at, expiresAt, cause: causeSummary(error) })
                })
            const diagnosedJournal: typeof EntryInferenceJournal.Service = {
              recordVisualClaims: (claims) =>
                journal
                  .recordVisualClaims(claims)
                  .pipe(
                    Effect.tapError((error) =>
                      Effect.forEach(
                        claims,
                        (claim) => retainFailure('claim', claim.stage, claim.claimedAt, claim.expiresAt)(error),
                        { discard: true },
                      ),
                    ),
                  ),
              recordTransitions: (transitions) =>
                journal
                  .recordTransitions(transitions)
                  .pipe(
                    Effect.tapError((error) =>
                      Effect.forEach(
                        transitions,
                        (transition) =>
                          transition.terminal === null
                            ? retainFailure('handoff', 'JEV', transition.successor.handoff.recordedAt, null)(error)
                            : retainFailure(
                                'terminal',
                                transition.terminal.stage,
                                transition.terminal.recordedAt,
                                null,
                              )(error),
                        { discard: true },
                      ),
                    ),
                  ),
            }
            const timing = yield* makeReplayInferenceTiming({
              budget: makeReplayInferenceBudget(1000),
              measureDatabaseTime: (operation) => operation,
              providerClock,
              advanceTo: advance,
              advanceDeadlineTo: advance,
              excludedSourceMillis: Effect.succeed(0),
              retain: (call) =>
                Effect.sync(() => {
                  calls.push(call)
                }),
              providers: {
                jev: entryProviderFixture(
                  {
                    evaluate: (request) =>
                      Effect.gen(function* () {
                        const started = yield* Clock.currentTimeMillis
                        yield* providerClock.setTime(started + latencyMs)
                        return nativeJevInference(request, utcInstantFromEpochMillis(yield* Clock.currentTimeMillis))
                      }),
                  },
                  chartProviderFixture,
                ),
              },
            })
            const result = yield* timing.run(
              evaluateJevObservation(nativeInput).pipe(
                Effect.provideService(JevClient, timing.clients.jev),

                Effect.provideService(EntryInferenceJournal, diagnosedJournal),
                Effect.result,
              ),
            )
            expect(calls.length).toBeGreaterThan(0)
            expect(yield* Clock.currentTimeMillis).toBeGreaterThanOrEqual(observed + latencyMs)
            const sql = yield* PgClient.PgClient
            expect(
              yield* sql`SELECT to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
                FROM simulated_execution_clocks WHERE account_id=${replayAccountId}`,
            ).toEqual([{ observed_at: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis) }])
            expect(
              calls.every(
                (call) =>
                  call.providerStartedAt.startsWith('2026-09-21') && call.simulatedStartedAt.startsWith('2026-09-04'),
              ),
            ).toBe(true)
            if (latencyMs === 10) {
              expect(Result.isSuccess(result)).toBe(true)
              if (Result.isFailure(result)) throw result.failure
              expect(calls.filter((call) => call.stage === 'CHART')).toHaveLength(
                equityMarketProfile.candidateSymbols.length,
              )
              expect(calls.filter((call) => call.stage === 'BASE_START')).toHaveLength(0)
              expect(calls.filter((call) => call.stage === 'JEV')).toHaveLength(
                equityMarketProfile.candidateSymbols.length,
              )
              expect(Result.getOrThrow(decideJevEntry(result.success)).selectedSymbols).toEqual(['AAPL'])
              expect(result.success.batchResult.completedAt).toBe(
                utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
              )
            } else {
              expect(result, JSON.stringify({ latencyMs, journalFailures })).toMatchObject({
                _tag: 'Failure',
                failure: { _tag: 'JevAwaitingEvidence' },
              })
              expect(yield* recoverPendingJevBatches(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toEqual(
                [],
              )
            }
          }),
        ).pipe(atObservation),
      )
    },
  )

  test('persists the native observation and all fifteen responses before deriving a replayable target', async () => {
    let calls = 0
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        yield* acquireEntryCycle()
        const evidence = yield* evaluateJevObservation(nativeInput)
        const target = Result.getOrThrow(decideJevEntry(evidence))
        expect(target.selectedSymbols).toEqual(['AAPL'])
        expect(calls).toBe(equityMarketProfile.candidateSymbols.length)
        const saved = yield* (yield* JevBatchStore).read(evidence.batchPlan.batchId)
        expect(saved).toEqual({ plan: evidence.batchPlan, result: evidence.batchResult })
        expect(yield* (yield* JevBatchStore).pending(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toEqual(
          [],
        )
      }).pipe(
        Effect.provideService(
          JevClient,
          entryProviderFixture({
            evaluate: (request) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((now) => {
                  calls += 1
                  return nativeJevInference(request, new Date(now).toISOString())
                }),
              ),
          }),
        ),
        atObservation,
      ),
    )
  }, 30_000)

  test('entry waits for a new completed window after restart instead of buying another inference batch', async () => {
    let calls = 0
    const phase = (name: string, startedAt: number, elapsedMs: number) =>
      Effect.logInfo({
        event: 'bayn.test.entry-window-cadence-phase',
        phase: name,
        observationOffsetMs: elapsedMs,
        wallDurationMs: Math.round(performance.now() - startedAt),
        jevCalls: calls,
      })
    const observeAt = (elapsedMs: number) =>
      Effect.gen(function* () {
        const fixtureStartedAt = performance.now()
        const at = utcInstantFromEpochMillis(observed + elapsedMs)
        const next = nativeJevFixture(JevPurpose.Entry, at)
        yield* phase('fixture', fixtureStartedAt, elapsedMs)
        const setupStartedAt = performance.now()
        yield* acquireEntryCycle(at)
        const reconciliation = {
          ...next.portfolio.brokerState.reconciliation,
          reconciliationId: Result.getOrThrow(canonicalHashV1Result({ cadenceReconciliationAt: at })),
        }
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash,
        observed_hash, content_hash, status, discrepancies, reconciled_at)
        VALUES (${reconciliation.reconciliationId}, ${reconciliation.schemaVersion}, ${reconciliation.accountId},
          ${reconciliation.expectedHash}, ${reconciliation.observedHash}, ${reconciliation.contentHash},
          ${reconciliation.status}, '[]'::jsonb, ${reconciliation.reconciledAt})`
        yield* TestClock.setTime(observed + elapsedMs)
        yield* phase('cycle-and-reconciliation', setupStartedAt, elapsedMs)
        const evaluationStartedAt = performance.now()
        const result = yield* evaluateJevObservation({
          ...nativeInput,
          portfolio: { ...next.portfolio, brokerState: { ...next.portfolio.brokerState, reconciliation } },
          snapshot: next.snapshot,
        }).pipe(Effect.result)
        yield* phase('evaluation', evaluationStartedAt, elapsedMs)
        return result
      }).pipe(
        Effect.provideService(
          JevClient,
          entryProviderFixture({
            evaluate: (request) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((now) => {
                  calls += 1
                  return nativeJevInference(request, utcInstantFromEpochMillis(now), false)
                }),
              ),
          }),
        ),
        Effect.provide(TestClock.layer()),
      )
    const first = await postgres.runtime.runPromise(observeAt(0))
    const firstAssertionsStartedAt = performance.now()
    expect(Result.isSuccess(first)).toBe(true)
    if (Result.isSuccess(first)) expect(Result.getOrThrow(decideJevEntry(first.success)).selectedSymbols).toEqual([])
    expect(calls).toBe(equityMarketProfile.candidateSymbols.length)
    await Effect.runPromise(phase('first-assertions', firstAssertionsStartedAt, 0))
    const restartStartedAt = performance.now()
    await postgres.restartRuntime()
    await Effect.runPromise(phase('runtime-restart', restartStartedAt, 1000))
    const repeated = await postgres.runtime.runPromise(observeAt(1000))
    const repeatedAssertionsStartedAt = performance.now()
    expect(Result.isFailure(repeated)).toBe(true)
    if (Result.isFailure(repeated))
      expect(repeated.failure).toMatchObject({
        _tag: 'JevAwaitingFreshWindow',
        availableAt: utcInstantFromEpochMillis(observed + 60_000),
      })
    expect(calls).toBe(equityMarketProfile.candidateSymbols.length)
    await Effect.runPromise(phase('same-window-assertions', repeatedAssertionsStartedAt, 1000))
    const fresh = await postgres.runtime.runPromise(observeAt(60_000))
    const assertionsStartedAt = performance.now()
    expect(Result.isSuccess(fresh)).toBe(true)
    expect(calls).toBe(2 * equityMarketProfile.candidateSymbols.length)
    expect(
      await postgres.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql`SELECT count(*)::integer AS count FROM jev_batch_plans`
        }),
      ),
    ).toEqual([{ count: 2 }])
    await Effect.runPromise(phase('final-assertions', assertionsStartedAt, 60_000))
  }, 30_000)

  test('rejects unstored reconciliation, a substituted cycle and an uncommitted observation', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        yield* acquireEntryCycle()
        const store = yield* CandidateObservationStore
        const sql = yield* PgClient.PgClient
        const payload = fixture.observation.payload
        const altered = {
          ...payload,
          portfolio: {
            ...payload.portfolio,
            brokerState: {
              ...payload.portfolio.brokerState,
              reconciliation: { ...payload.portfolio.brokerState.reconciliation, reconciliationId: '0'.repeat(64) },
            },
          },
        }
        expect(
          Result.isFailure(
            yield* store
              .record({ payload: altered, contentHash: Result.getOrThrow(canonicalHashV1Result(altered)) })
              .pipe(Effect.result),
          ),
        ).toBe(true)
        const wrongCycle = { ...payload, cycleId: '0'.repeat(64) }
        expect(
          Result.isFailure(
            yield* store
              .record({ payload: wrongCycle, contentHash: Result.getOrThrow(canonicalHashV1Result(wrongCycle)) })
              .pipe(Effect.result),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(yield* sql.withTransaction(store.record(fixture.observation)).pipe(Effect.result)),
        ).toBe(true)
        expect(yield* sql`SELECT count(*)::integer AS count FROM intraday_candidate_observations`).toEqual([
          { count: 0 },
        ])
      }),
    )
  })

  test('retains a failed candidate and prevents entry from the other fourteen successful responses', async () => {
    let calls = 0
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        yield* acquireEntryCycle()
        const result = yield* evaluateJevObservation(nativeInput).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isSuccess(result)) throw new Error('A partial batch authorized a decision')
        expect(result.failure._tag).toBe('JevAwaitingEvidence')
        expect(calls).toBe(equityMarketProfile.candidateSymbols.length)
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_batch_results`).toEqual([{ count: 1 }])
        expect(
          yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_receipts WHERE payload #>> '{outcome,completion,jev,status}' = 'FAILED'`,
        ).toEqual([{ count: 1 }])
        expect(yield* sql`SELECT count(*)::integer AS count FROM autonomous_cycle_shadow_decisions`).toEqual([
          { count: 0 },
        ])
      }).pipe(
        Effect.provideService(
          JevClient,
          entryProviderFixture({
            evaluate: (request) =>
              Effect.gen(function* () {
                calls += 1
                if (calls === 1)
                  return yield* new JevError({
                    failure: JevFailure.Status,
                    status: 429,
                    message: 'Fixture provider rejected one request',
                  })
                return nativeJevInference(request, new Date(yield* Clock.currentTimeMillis).toISOString())
              }),
          }),
        ),
        atObservation,
      ),
    )
  })

  test('discovers an abandoned batch after restart and seals it at expiry without inference', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        yield* acquireEntryCycle()
        yield* (yield* CandidateObservationStore).record(fixture.observation)
        const plan = Result.getOrThrow(
          makeJevTradingSignalBatch({
            observation: fixture.observation.payload,
            expiresAt: new Date(observed + fixture.protocol.inferenceValidityMs).toISOString(),
            planVersion: JevBatchPlanVersion.V8,
          }),
        )
        const store = yield* JevBatchStore
        yield* beginRecordedJevBatch(store, plan, fixture.observation.payload)
        expect(yield* store.pending(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toEqual([plan.batchId])
        expect(yield* recoverPendingJevBatches(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toEqual([
          plan,
        ])
        yield* TestClock.setTime(observed + fixture.protocol.inferenceValidityMs)
        expect(yield* recoverPendingJevBatches(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toEqual([])
        expect(yield* store.pending(nativeInput.cycleId, nativeInput.authorityGenerationHash)).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('interrupting measured work freezes the database clock and retains elapsed market time', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        yield* acquireEntryCycle()
        const sql = yield* PgClient.PgClient
        const providerClock = yield* TestClock.withLive(Clock.clockWith(Effect.succeed))
        const clock = yield* makeSimulatedExecutionClock('e'.repeat(64), 'e'.repeat(64), providerClock)
        const entered = yield* Deferred.make<void>()
        const worker = yield* clock
          .measure(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        expect(yield* sql`SELECT measured_at IS NOT NULL AS active FROM simulated_execution_clocks`).toEqual([
          { active: true },
        ])
        yield* sql`SELECT pg_sleep(0.01)`
        yield* Fiber.interrupt(worker)
        expect(yield* sql`SELECT measured_at IS NULL AS stopped FROM simulated_execution_clocks`).toEqual([
          { stopped: true },
        ])
        expect(yield* Clock.currentTimeMillis).toBeGreaterThan(observed)
        const frozen = yield* sql`SELECT execution_account_now(${replayAccountId}) AS now`
        yield* sql`SELECT pg_sleep(0.01)`
        expect(yield* sql`SELECT execution_account_now(${replayAccountId}) AS now`).toEqual(frozen)
      }).pipe(Effect.scoped, atObservation),
    )
  })
})
