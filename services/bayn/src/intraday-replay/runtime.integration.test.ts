import { assessBacktestSession, BacktestIssue } from './backtest'
import { driveReplaySession } from './session'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { OrderType as BrokerOrderType, TimeInForce as BrokerTimeInForce } from '../broker/alpaca/model'
import { CandidateObservationStoreLive } from '../db/candidate-observation-postgres'
import { makeSimulatedExecutionClock } from './clock'
import type { RuntimeConfig } from '../config'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Clock, Context, Deferred, Effect, Fiber, Layer, Redacted, Ref, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { OperationDeadlineClock } from '../operation-timeout'

import { AssetClass, AssetExchange, AssetStatus, MarketCalendarResponseSchema, OrderSide } from '../broker/alpaca/model'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import {
  IntentStore,
  IntentStoreLive,
  BlockedCycleIntentStore,
  BlockedCycleIntentStoreLive,
} from '../execution/intents'
import { MutationStore, MutationStoreLive } from '../execution/mutations'
import { ExecutionCycleClosureStoreLive } from '../db/execution-cycle-closure-postgres'
import { PersistedCapitalGrantStoreLive } from '../db/persisted-capital-grant'
import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { JournalLive } from '../ledger'
import { canonicalHashV1 } from '../hash'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { config as baseConfig, fixtureProtocol, fixtureRuntime } from '../testing/runtime-fixtures'
import { makeActiveStrategyRuntime } from '../strategy'
import { JevClient } from '../jev/client'
import { nativeJevInference } from '../jev/native.test-support'
import { prepareJevRequest } from '../jev/contract'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevEvaluationStore } from '../jev/evaluation'
import { JevPositionStore } from '../jev/portfolio'
import { JevBatchStoreLive } from '../db/jev-batch-postgres'
import { JevEvaluationStoreLive } from '../db/jev-evaluation-postgres'
import { JevPositionStoreLive } from '../db/jev-position-postgres'
import { simulationFixture } from '../testing/simulated-streaming-fixture'
import { historicalRawArrivals } from '../testing/historical-streaming-fixture'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import {
  advanceHistoricalMarketCursor,
  compareArrivalPositions,
  arrivalPosition,
  type HistoricalMarketCursor,
} from '../market-data/streaming/historical'
import { currentUtcInstant, utcInstantFromEpochMillis } from '../time'
import { makeReplayBroker, ReplayBrokerFailure } from './broker'
import { makeReplayExecutionRuntime } from './runtime'
import { makeReplayJevTiming, type ReplayJevCall } from './jev-timing'
import { BrokerRead } from '../broker/alpaca'
import {
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  BrokerEventStore,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
} from '../db/execution-store'
import { CycleStore } from '../cycle/store'
import { ExecutionCycleClosureStore } from '../db/execution-cycle-closure'
import { PersistedCapitalGrantStore } from '../db/persisted-capital-grant'
import { readFinalExecutionRiskContext } from '../db/reconciliation'
import { grantedCapitalAuthority, makeExecutionAuthority } from '../execution/authority'
import { Authority, KillState, ReconciliationStatus } from '../execution/contracts'
import { makeResearchCapitalActivationRequest, researchCapitalGrantProof } from '../execution/configuration'
import { capitalGrantFromLegacyGeneration, capitalGrantKey } from '../execution/mandate'
import { makeTradingEngine } from '../composition/trading-engine'
import { ownGenerationCycleDriver } from '../composition/generation-cycle'
import { recoverTerminalGenerationToObserve } from '../blocked-generation-recovery'
import { operationalError } from '../errors'
import type { RecoveryFirstCycleDriver, RecoveryFirstRuntime } from '../observe-composition'
import { makeStrategyProtocolHashResult } from '../contracts'

const durableTest = baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined ? test.skip : test

durableTest.each([
  'fill',
  'fallback',
  'missing-benchmark',
  'no-trade',
  'recovery',
  'recovery-filled',
  'early-exit',
  'partial-exit-reentry',
  'measured-exit',
] as const)(
  'native Jev production cycle and durable accounting: %s',
  async (scenario) => {
    if (baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined)
      throw new Error('Missing replay test databases')
    const url = new URL(baynTestPostgresUrl)
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.endsWith('_test') ||
      !/^127\.0\.0\.1:\d+$/.test(baynTestTigerBeetleAddress)
    )
      throw new Error('Replay acceptance requires isolated local test databases')
    const protocol = fixtureProtocol
    let managementCalls = 0
    const measuredCalls: ReplayJevCall[] = []
    const fixture = { ...simulationFixture(undefined, undefined, scenario === 'no-trade' ? {} : undefined), protocol }
    const initialAtMs = Date.parse(fixture.query.observedAt)
    const reentryAtMs = initialAtMs + 120_000
    const lifecycleObservations =
      scenario === 'partial-exit-reentry'
        ? [
            ...Array.from({ length: 25 }, (_, index) => ({
              at: initialAtMs + (index + 1) * 1000,
              fullWindow: false,
              offset: BigInt((index + 1) * 1000),
              bidSize: 40,
              premium: 0.02,
            })),
            { at: reentryAtMs, fullWindow: true, offset: 30_000n, bidSize: 100, premium: 0.02 },
          ]
        : scenario === 'measured-exit'
          ? [
              { at: initialAtMs + 1, fullWindow: true, offset: 1000n, bidSize: 100, premium: 0.02 },
              ...Array.from({ length: 200 }, (_, index) => ({
                at: initialAtMs + (index + 1) * 200,
                fullWindow: false,
                offset: BigInt((index + 2) * 1000),
                bidSize: 100,
                premium: 0.02 + (index + 1) * 0.00002,
              })),
            ]
          : []
    const lifecycleArrivals = lifecycleObservations
      .flatMap(({ at, fullWindow, offset, bidSize, premium }) => {
        const windowEnd = Math.floor(at / 60_000) * 60_000
        const query = {
          ...fixture.query,
          symbols: [...protocol.candidateSymbols, protocol.benchmarkSymbol].sort(),
          candidateSymbols: protocol.candidateSymbols,
          rangeStartAt: utcInstantFromEpochMillis(windowEnd - (fullWindow ? 30 : 1) * 60_000),
          rangeEndAt: utcInstantFromEpochMillis(windowEnd),
          observedAt: utcInstantFromEpochMillis(at),
          ...(fullWindow ? {} : { purpose: IntradaySnapshotPurpose.EntryPricing }),
        }
        const original = makeIntradayMomentumTestSnapshot(
          protocol,
          { ...query, archiveWatermarks: [] },
          { AAPL: premium, AMZN: 0.01 },
          100,
          { AAPL: bidSize },
        )
        const shiftOffset = <A extends { readonly sourceOffset: string }>(row: A): A => ({
          ...row,
          sourceOffset: String(BigInt(row.sourceOffset) + offset),
        })
        const raw = {
          ...original,
          bars: original.bars.map(shiftOffset),
          quotes: original.quotes.map(shiftOffset),
          trades: original.trades.map(shiftOffset),
        }
        const arrivals = historicalRawArrivals(raw, at)
        if (fullWindow) {
          const { cut } = streamingFixtureFromRaw(raw, query)
          arrivals.push(
            ...[...cut.projection.features.values()].flat().map((feature) => ({
              availableAtMs: at,
              record: {
                topic: feature.topic,
                partition: feature.partition,
                offset: String(BigInt(feature.offset) + offset),
                value: JSON.stringify(feature.value),
              },
            })),
          )
        }
        return arrivals
      })
      .toSorted((a, b) => compareArrivalPositions(arrivalPosition(a), arrivalPosition(b)))
    const strategyRuntime = makeActiveStrategyRuntime(protocol, {
      ...fixtureRuntime.provenance,
      strategy: { ...fixtureRuntime.provenance.strategy, parameterHash: canonicalHashV1(protocol) },
    })
    const closeAtMs =
      scenario === 'fill' || scenario === 'fallback'
        ? Date.parse('2026-09-04T20:00:00Z') - protocol.flattenBeforeCloseMinutes * 60_000 + 2_000
        : Date.parse('2026-09-04T19:59:02Z')
    const closeQuery = {
      ...fixture.query,
      purpose: IntradaySnapshotPurpose.Liquidation,
      rangeStartAt: utcInstantFromEpochMillis(closeAtMs - 62_000),
      rangeEndAt: utcInstantFromEpochMillis(closeAtMs - 2_000),
      observedAt: utcInstantFromEpochMillis(closeAtMs),
    }
    const closeArrivals = historicalRawArrivals(
      makeIntradayMomentumTestSnapshot(
        fixture.protocol,
        { ...closeQuery, archiveWatermarks: [] },
        { AAPL: 0.02, AMZN: 0.01 },
      ),
      closeAtMs,
    )
      .map((arrival) => ({
        ...arrival,
        record: { ...arrival.record, offset: String(BigInt(arrival.record.offset) + 1_000_000n) },
      }))
      .toSorted((a, b) => compareArrivalPositions(arrivalPosition(a), arrivalPosition(b)))
    const runId = canonicalHashV1({ attempt: randomUUID() })
    const source = {
      ...fixture.source,
      runId,
      sourceManifestHash: canonicalHashV1({
        ...fixture.input,
        arrivals: {
          ...fixture.input.arrivals,
          events: [...fixture.input.arrivals.events, ...lifecycleArrivals, ...closeArrivals],
        },
      }),
    }
    const accountId = `replay-${runId}`
    const config: RuntimeConfig = {
      ...baseConfig,
      build: { ...baseConfig.build, strategyParameterHash: strategyRuntime.provenance.strategy.parameterHash },
      operationTimeoutMs: 10000,
      execution: {
        brokerIdentity: Result.getOrThrow(
          makeBrokerIdentity({
            schemaVersion: 'bayn.broker-identity.v2',
            provider: BrokerProvider.Alpaca,
            environment: BrokerEnvironment.Sandbox,
            accountId,
          }),
        ),
        brokerAccess: BrokerAccess.ReadOnly,
        capitalAuthority: noCapitalAuthority,
      },
      postgres: { url: Redacted.make(baynTestPostgresUrl), tls: false, caPath: '/unused' },
      tigerBeetle: { clusterId: 20912n, ledger: 70912, replicaAddresses: [baynTestTigerBeetleAddress] },
    }
    const base = Layer.mergeAll(WriterFenceLive, JournalLive(config)).pipe(
      Layer.provideMerge(PostgresClientLive(config)),
      Layer.provide(NodeServices.layer),
    )
    const stores = Layer.mergeAll(
      CandidateObservationStoreLive,
      JevBatchStoreLive,
      JevPositionStoreLive,
      IntentStoreLive,
      BlockedCycleIntentStoreLive,
      MutationStoreLive,
      ExecutionCycleClosureStoreLive,
      PersistedCapitalGrantStoreLive,
    ).pipe(Layer.provideMerge(JevEvaluationStoreLive), Layer.provideMerge(base))
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const initialMs = Date.parse(fixture.query.observedAt)
        yield* TestClock.setTime(initialMs)
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
        const clock = yield* makeSimulatedExecutionClock(runId, source.sourceManifestHash)
        const wrongAccount = yield* Effect.exit(
          sql`INSERT INTO simulated_execution_clocks VALUES ('paper-account-1', ${source.sourceManifestHash}, clock_timestamp())`,
        )
        const missingClock = yield* Effect.exit(sql`SELECT execution_account_now(${'replay-' + '0'.repeat(64)})`)
        const rewind = yield* Effect.exit(clock.advanceTo(utcInstantFromEpochMillis(initialMs - 1)))
        const wrongSource = yield* Effect.exit(makeSimulatedExecutionClock(runId, 'f'.repeat(64)))
        const deletedClock = yield* Effect.exit(sql`DELETE FROM simulated_execution_clocks`)
        const truncatedClock = yield* Effect.exit(sql`TRUNCATE simulated_execution_clocks`)
        const wallClock = yield* sql<
          Record<string, unknown>
        >`SELECT abs(extract(epoch FROM (execution_account_now('paper-account-1') - clock_timestamp()))) < 1 AS current`
        for (const rejected of [wrongAccount, missingClock, rewind, wrongSource, deletedClock, truncatedClock])
          expect(rejected._tag).toBe('Failure')
        expect(wallClock[0]?.['current']).toBe(true)
        let cursor: HistoricalMarketCursor = {
          ...fixture.cursor,
          source,
          runId,
          projection: { ...fixture.cursor.projection, epoch: `historical-${runId}` },
        }
        let nextLifecycleArrival = 0
        const advanceMarketTo = (atMs: number) =>
          Effect.gen(function* () {
            while (nextLifecycleArrival < lifecycleArrivals.length) {
              const arrival = lifecycleArrivals[nextLifecycleArrival]
              if (arrival === undefined || arrival.availableAtMs > atMs) break
              cursor = yield* Effect.fromResult(advanceHistoricalMarketCursor(cursor, arrival))
              nextLifecycleArrival += 1
            }
            yield* clock.advanceTo(utcInstantFromEpochMillis(atMs))
            yield* TestClock.setTime(atMs)
          })
        const provider = yield* JevClient
        const providerClock = yield* TestClock.withLive(Clock.clockWith(Effect.succeed))
        const timing =
          scenario === 'measured-exit'
            ? yield* makeReplayJevTiming({
                provider,
                providerClock,
                advanceTo: (atMs) =>
                  advanceMarketTo(atMs).pipe(
                    Effect.mapError(
                      (cause) => new ReplayBrokerFailure({ message: 'Measured source advance failed', cause }),
                    ),
                  ),
                retain: (call) =>
                  Effect.sync(() => {
                    measuredCalls.push(call)
                  }),
              })
            : undefined
        const broker = yield* makeReplayBroker({
          runId,
          sourceManifestHash: source.sourceManifestHash,
          openingCashMicros: '100000000000',
          protocol: fixture.protocol,
          assumptions: {
            latencyMs: 10,
            slippageBps: 0,
            availableLiquidityPpm: scenario === 'recovery' ? 1 : 1000000,
            feeMultiplierPpm: 1000000,
          },
          fractionalTrading: false,
          calendar: Result.getOrThrow(Schema.decodeUnknownResult(MarketCalendarResponseSchema)(fixture.input.calendar)),
          assets: fixture.protocol.universe.map((symbol, index) =>
            Result.getOrThrow(
              normalizeAssetResult(
                {
                  id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
                  symbol,
                  class: AssetClass.UsEquity,
                  exchange: AssetExchange.Nasdaq,
                  status: AssetStatus.Active,
                  tradable: true,
                  fractionable: true,
                },
                symbol,
                fixture.query.observedAt,
              ),
            ),
          ),
          quoteAt: (symbol) => Effect.succeed(cursor.projection.quotes.get(symbol)),
          advanceToArrival: (atMs) =>
            advanceMarketTo(atMs).pipe(
              Effect.mapError(
                (cause) => new ReplayBrokerFailure({ message: 'Cannot advance test arrival clock', cause }),
              ),
            ),
        })
        const passes = yield* Ref.make<unknown[]>([])
        const stallReconciliation = yield* Ref.make(false)
        const interrupted = yield* Ref.make(false)
        const runtimeInput = {
          config,
          strategy: strategyRuntime,
          broker: {
            ...broker,
            read: {
              ...broker.read,
              account: Ref.get(stallReconciliation).pipe(
                Effect.flatMap((stall) =>
                  stall ? Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))) : broker.read.account,
                ),
              ),
            },
          },
          source,
          cursor: Effect.sync(() =>
            scenario === 'missing-benchmark'
              ? {
                  ...cursor,
                  projection: {
                    ...cursor.projection,
                    bars: new Map(
                      [...cursor.projection.bars].filter(([symbol]) => symbol !== protocol.benchmarkSymbol),
                    ),
                  },
                }
              : scenario === 'fallback' && (cursor.lastArrival?.availableAtMs ?? 0) >= closeAtMs
                ? { ...cursor, projection: { ...cursor.projection, quoteHistory: new Map() } }
                : cursor,
          ),
          clock,
          currentUtcInstant: timing?.currentUtcInstant ?? currentUtcInstant,
          recordPass: (pass: Parameters<import('../app').RecordAutonomousCyclePass>[0]) =>
            Ref.update(passes, (values) => [...values, pass]),
          pollIntervalMs: 1000,
          reconciliationIntervalMs: scenario === 'measured-exit' ? config.operationTimeoutMs : 1000,
          reconciliationPassTimeoutMs:
            scenario === 'fill' || scenario === 'fallback' ? 1000 : config.operationTimeoutMs,
        }
        const engine = yield* makeReplayExecutionRuntime(runtimeInput).pipe(
          Effect.provideService(JevClient, timing?.client ?? provider),
        )
        const runtime = {
          ...engine,
          advance:
            timing === undefined
              ? engine.advance
              : timing.run(engine.advance).pipe(Effect.provideService(OperationDeadlineClock, providerClock)),
        }
        if (scenario === 'missing-benchmark' || scenario === 'no-trade') {
          const schedule = yield* driveReplaySession(
            runtime,
            (at) =>
              clock.advanceTo(utcInstantFromEpochMillis(at)).pipe(
                Effect.andThen(TestClock.setTime(at)),
                Effect.mapError((cause) => new ReplayBrokerFailure({ message: 'Coverage test clock failed', cause })),
              ),
            initialMs + 1,
            initialMs + 4001,
          )
          const reconciliation = yield* runtime.reconcile
          const state = yield* broker.snapshot
          expect(schedule.failedPassCount).toBe(0)
          expect(state.fills).toEqual([])
          const assessment = assessBacktestSession({
            ...schedule,
            valuationFailureCount: 0,
            remainingPositionCount: state.ledger.positions.length,
            reconciliation: {
              status: reconciliation.report.reconciliation.status,
              metrics: reconciliation.report.metrics,
              unknownOrderCount: reconciliation.brokerState.unknownOrderCount,
              unknownMutationCount: reconciliation.riskContext.unknownMutationCount,
            },
          })
          if (scenario === 'missing-benchmark') {
            expect(schedule.unavailableDecisionPassCount).toBeGreaterThan(0)
            expect(assessment).toEqual({ completion: 'INCOMPLETE', issues: [BacktestIssue.MissingDecisionData] })
          } else {
            expect(schedule.readinessCounts[DecisionReadinessReason.NoEligibleCandidate]).toBeGreaterThan(0)
            expect(schedule.unavailableDecisionPassCount).toBe(0)
            expect(assessment).toEqual({ completion: 'COMPLETE', issues: [] })
          }
          return { _tag: 'Coverage' as const }
        }
        if (scenario === 'recovery' || scenario === 'recovery-filled') {
          const advanceBy = (ms: number) =>
            Effect.gen(function* () {
              const next = (yield* Clock.currentTimeMillis) + ms
              yield* clock.advanceTo(utcInstantFromEpochMillis(next))
              yield* TestClock.setTime(next)
            })
          const store = runtime.store
          const fence = yield* WriterFence
          const intents = yield* IntentStore
          const mutations = yield* MutationStore
          const blockedIntents = yield* BlockedCycleIntentStore
          const closures = yield* ExecutionCycleClosureStore
          const grants = yield* PersistedCapitalGrantStore
          const readAuthority = store.authorityGeneration.readAuthorityState
          if (readAuthority === undefined) throw new Error('Missing durable authority reader')
          const resources = Context.make(BrokerRead, broker.read).pipe(
            Context.add(CycleStore, runtime.cycleStore),
            Context.add(BrokerEventStore, store.events),
            Context.add(FillAccountingStore, store.accounting),
            Context.add(ValuationStore, store.valuation),
            Context.add(ReconciliationStore, store.reconciliation),
            Context.add(AuthorityGenerationStore, store.authorityGeneration),
            Context.add(AuthorityRestrictionStore, store.authorityRestriction),
            Context.add(WriterFence, fence),
            Context.add(IntentStore, intents),
            Context.add(MutationStore, mutations),
            Context.add(JevClient, yield* JevClient),
            Context.add(JevEvaluationStore, yield* JevEvaluationStore),
            Context.add(JevBatchStore, yield* JevBatchStore),
            Context.add(JevPositionStore, yield* JevPositionStore),
          )
          const asOperational = (cause: unknown) =>
            operationalError({
              component: 'strategy',
              operation: 'recovery-proof',
              message: 'Recovery proof operation failed',
              cause,
            })
          const reconcile = advanceBy(1).pipe(
            Effect.andThen(runtime.reconcile),
            Effect.andThen(advanceBy(1)),
            Effect.asVoid,
            Effect.mapError(asOperational),
          )
          const settle = recoverTerminalGenerationToObserve({
            accountId,
            blockedIntents,
            authorityStore: store.authorityGeneration,
            writerFence: fence,
            reconcileAfterSettlement: reconcile,
          })
          let lostResponses = 0
          const openOwner = (generationHash: string, mode: 'Mutation' | 'CloseOnly', loseResponse = false) =>
            Effect.gen(function* () {
              const generation = yield* store.authorityGeneration.readResearchAuthorityGeneration(generationHash)
              if (generation === undefined || config.execution.brokerIdentity === undefined)
                throw new Error('Missing recovery generation')
              const authority = yield* Effect.fromResult(
                makeExecutionAuthority({
                  observedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
                  brokerIdentity: config.execution.brokerIdentity,
                  brokerAccess: BrokerAccess.Mutation,
                  capitalAuthority: grantedCapitalAuthority(generationHash),
                  strategy: strategyRuntime.provenance.strategy,
                }),
              )
              const engine = yield* makeTradingEngine({
                authority,
                executionMode: mode,
                cycle: {
                  accountId,
                  authorityGenerationHash: generationHash,
                  strategy: strategyRuntime,
                  intradayMarketData: runtime.marketData,
                  executionCycleClosureStore: closures,
                  blockedCycleIntentStore: blockedIntents,
                  pollIntervalMs: 1000,
                  reconciliationIntervalMs: loseResponse ? 3000 : config.operationTimeoutMs,
                  reconciliationPassTimeoutMs: loseResponse ? 3000 : config.operationTimeoutMs,
                },
                execution: {
                  currentUtcInstant,
                  brokerRead: broker.read,
                  brokerMutation: loseResponse
                    ? {
                        ...broker.mutation,
                        submit: (...args) =>
                          broker.mutation.submit(...args).pipe(
                            Effect.andThen(
                              Effect.sync(() => {
                                lostResponses += 1
                              }),
                            ),
                            Effect.andThen(Effect.never),
                          ),
                      }
                    : broker.mutation,
                  intentStore: intents,
                  mutationStore: mutations,
                  writerFence: fence,
                  persistedCapitalGrants: grants,
                  readFinalExecutionRiskContext: (at) => readFinalExecutionRiskContext(sql, accountId, at),
                },
              })
              const startup = yield* engine.startCycle({
                cycleBindingId: capitalGrantKey(capitalGrantFromLegacyGeneration(generation)),
                recordPass: runtimeInput.recordPass,
              })
              const driver = yield* startup.pipe(Effect.provideContext(resources))
              const published = yield* Deferred.make<RecoveryFirstCycleDriver>()
              const owner = yield* ownGenerationCycleDriver<RecoveryFirstRuntime>({
                generationHash,
                mode,
                readAuthority: readAuthority.pipe(Effect.mapError(asOperational)),
                reconcileWhenHeld: reconcile,
                settle,
                owner: (value) => Deferred.succeed(published, value).pipe(Effect.andThen(Effect.never)),
              })(driver).pipe(Effect.provideContext(resources), Effect.forkChild({ startImmediately: true }))
              const owned = yield* Deferred.await(published)
              return { owner, advance: owned.advance.pipe(Effect.provideContext(resources)) }
            })
          const liveClock = yield* TestClock.withLive(Clock.clockWith(Effect.succeed))
          const healthy = yield* openOwner(runtime.authorityGenerationHash, 'Mutation', true)
          const recoveryAdvances = []
          for (let attempt = 0; attempt < 20 && lostResponses === 0; attempt++) {
            yield* advanceBy(1000)
            const advance = yield* healthy.advance.pipe(Effect.provideService(OperationDeadlineClock, liveClock))
            recoveryAdvances.push(advance.observation)
          }
          expect(lostResponses, JSON.stringify(recoveryAdvances)).toBe(1)
          yield* advanceBy(1000)
          yield* healthy.advance.pipe(Effect.provideService(OperationDeadlineClock, liveClock))
          expect(healthy.owner.pollUnsafe()).toBeDefined()
          yield* Fiber.join(healthy.owner)
          const restricted = yield* readAuthority
          expect(restricted).toMatchObject({
            maximum: Authority.Execution,
            effective: Authority.Observe,
            kill: KillState.Active,
          })
          expect((yield* broker.snapshot).fills).toHaveLength(scenario === 'recovery-filled' ? 1 : 0)
          const recovery = yield* openOwner(runtime.authorityGenerationHash, 'CloseOnly')
          const concurrentRecovery = yield* openOwner(runtime.authorityGenerationHash, 'CloseOnly')
          let lastRecovery
          for (let attempt = 0; attempt < 20 && recovery.owner.pollUnsafe() === undefined; attempt++) {
            yield* advanceBy(attempt === 3 ? closeAtMs - (yield* Clock.currentTimeMillis) : 1000)
            if (attempt === 3)
              for (const arrival of closeArrivals)
                cursor = yield* Effect.fromResult(advanceHistoricalMarketCursor(cursor, arrival))
            lastRecovery = yield* Effect.all([recovery.advance, concurrentRecovery.advance], { concurrency: 2 }).pipe(
              Effect.provideService(OperationDeadlineClock, liveClock),
            )
          }
          expect(recovery.owner.pollUnsafe(), JSON.stringify(lastRecovery)).toBeDefined()
          yield* Fiber.join(recovery.owner)
          yield* concurrentRecovery.advance.pipe(Effect.provideService(OperationDeadlineClock, liveClock))
          yield* Fiber.join(concurrentRecovery.owner)
          const observed = yield* readAuthority
          expect(observed).toMatchObject({
            maximum: Authority.Observe,
            effective: Authority.Observe,
            kill: KillState.Clear,
          })
          const repeated = yield* Effect.all([settle, settle], { concurrency: 2 })
          expect(repeated).toEqual([{ _tag: 'NotRequired' }, { _tag: 'NotRequired' }])
          const previous = yield* store.authorityGeneration.readResearchAuthorityGeneration(
            runtime.authorityGenerationHash,
          )
          if (previous === undefined || config.execution.brokerIdentity === undefined)
            throw new Error('Missing prior research grant')
          const request = yield* Effect.fromResult(
            makeResearchCapitalActivationRequest({
              schemaVersion: 'bayn.research-execution-mandate.v1',
              grant: previous.grant,
              activation: {
                sourceRevision: config.build.sourceRevision,
                imageRepository: config.build.imageRepository,
                imageDigest: config.build.imageDigest,
              },
              strategy: {
                ...strategyRuntime.provenance.strategy,
                protocolHash: Result.getOrThrow(makeStrategyProtocolHashResult(strategyRuntime.provenance.strategy)),
              },
              broker: {
                environment: BrokerEnvironment.Sandbox,
                accountId,
                identityHash: config.execution.brokerIdentity.identityHash,
              },
              riskPolicyHash: previous.riskPolicyHash,
              limits: { maxOpenOrders: 0, maxPositions: 0 },
            }),
          )
          yield* reconcile
          const activated = yield* store.capitalGrantLifecycle.activateResearchCapitalGrant(
            researchCapitalGrantProof(request),
            observed.generationHash,
          )
          expect(activated.generationHash).not.toBe(runtime.authorityGenerationHash)
          yield* advanceBy(1)
          yield* store.authorityRestriction.restrictAuthority(
            'operator kill switch active',
            utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
          )
          const heldBefore = yield* readAuthority
          const held = yield* openOwner(activated.generationHash, 'Mutation')
          const holds = yield* Effect.all([held.advance, held.advance], { concurrency: 2 })
          expect(holds.every((item) => item.observation.result === 'FAILURE')).toBe(true)
          expect(yield* readAuthority).toEqual(heldBefore)
          yield* Fiber.interrupt(held.owner)
          const final = yield* runtime.reconcile
          expect(final.report.metrics.accountingExact).toBe(true)
          expect(final.report.reconciliation.status).toBe(ReconciliationStatus.Exact)
          expect(final.riskContext.unknownMutationCount).toBe(0)
          expect(final.brokerState.positions).toHaveLength(0)
          const counts = yield* sql<
            Record<string, unknown>
          >`SELECT (SELECT count(*)::int FROM intents WHERE account_id=${accountId}) AS intents, (SELECT count(*)::int FROM fills WHERE account_id=${accountId}) AS fills, (SELECT count(*)::int FROM accounting_transactions WHERE account_id=${accountId}) AS transactions`
          expect(counts).toEqual([
            scenario === 'recovery-filled'
              ? { intents: 2, fills: 2, transactions: 2 }
              : { intents: 1, fills: 0, transactions: 0 },
          ])
          expect(final.brokerState.account.cashMicros).toBe((yield* broker.snapshot).ledger.cashMicros)
          return { _tag: 'Recovery' as const }
        }
        yield* advanceMarketTo(initialMs + 1)
        for (let pass = 0; pass < 20; pass++) {
          const advanced = yield* runtime.advance
          if (advanced.observation.result === 'FAILURE' || (yield* broker.snapshot).fills.length > 0) break
          const nextMs = (yield* Clock.currentTimeMillis) + 1000
          yield* advanceMarketTo(nextMs)
        }
        const settledMs = (yield* Clock.currentTimeMillis) + 1
        yield* advanceMarketTo(settledMs)
        yield* runtime.reconcile
        if (scenario === 'early-exit' || scenario === 'partial-exit-reentry' || scenario === 'measured-exit') {
          expect((yield* broker.snapshot).fills.map((fill) => fill.side)).toEqual([OrderSide.Buy])
          for (let attempt = 0; attempt < 12; attempt++) {
            const advanced = yield* runtime.advance
            if (advanced.result?.outcome === 'RECOVERED' && advanced.result.action === 'COMPLETED') break
            const next = (yield* Clock.currentTimeMillis) + 1000
            yield* advanceMarketTo(next)
          }
          const state = yield* broker.snapshot
          expect(managementCalls, JSON.stringify(yield* Ref.get(passes))).toBe(1)
          expect(state.fills.map((fill) => fill.side)).toEqual(
            scenario === 'partial-exit-reentry'
              ? [OrderSide.Buy, OrderSide.Sell, OrderSide.Sell, OrderSide.Sell]
              : [OrderSide.Buy, OrderSide.Sell],
          )
          expect(state.ledger.positions).toHaveLength(0)
          const reconciliation = yield* runtime.reconcile
          expect(reconciliation.report.metrics.accountingExact).toBe(true)
          expect(reconciliation.riskContext.unknownMutationCount).toBe(0)
          expect(reconciliation.brokerState.account.cashMicros).toBe(state.ledger.cashMicros)
          expect(yield* sql`SELECT state FROM autonomous_cycles WHERE account_id = ${accountId}`).toEqual([
            { state: 'COMPLETED' },
          ])
          if (scenario === 'measured-exit') {
            expect(measuredCalls).toHaveLength(16)
            const entryCalls = measuredCalls.filter((call) => {
              const action = call.request.questions['action']
              return action?.type === 'choice' && 'enter' in action.criteria
            })
            expect(entryCalls).toHaveLength(15)
            for (const call of measuredCalls) {
              expect(call.outcome.status).toBe('RECEIVED')
              expect(Date.parse(call.providerCompletedAt) - Date.parse(call.providerStartedAt)).toBeGreaterThanOrEqual(
                100,
              )
            }
            const lastEntryResponse = Math.max(
              ...entryCalls.map(
                (call) =>
                  Date.parse(call.simulatedStartedAt) +
                  Date.parse(call.providerCompletedAt) -
                  Date.parse(call.providerStartedAt),
              ),
            )
            const entry = state.orders[0]?.execution
            expect(entry).toBeDefined()
            if (entry === undefined) throw new Error('Missing measured entry execution')
            expect(Date.parse(entry.submittedAt)).toBeGreaterThanOrEqual(lastEntryResponse)
            for (const order of state.orders) {
              const execution = order.execution
              if (execution?.quote === null || execution?.quote === undefined || execution.outcome.status !== 'filled')
                throw new Error('Measured lifecycle requires complete execution quote evidence')
              const tick = Math.floor((Date.parse(execution.arrivedAt) - initialAtMs) / 200)
              const expectedMidpoint = 100 * (1.02 + tick * 0.00002)
              expect(execution.quote.availableAtMs).toBe(initialAtMs + tick * 200)
              expect(execution.quote.askPrice).toBeCloseTo(expectedMidpoint + 0.01, 8)
              expect(execution.quote.bidPrice).toBeCloseTo(expectedMidpoint - 0.01, 8)
              const fillPrice = order.order.side === OrderSide.Buy ? execution.quote.askPrice : execution.quote.bidPrice
              const quotedMicros = BigInt(Math.round(fillPrice * 1_000_000))
              const tickRoundedMicros =
                order.order.side === OrderSide.Buy
                  ? ((quotedMicros + 9999n) / 10000n) * 10000n
                  : (quotedMicros / 10000n) * 10000n
              expect(execution.outcome.fillPriceMicros).toBe(tickRoundedMicros.toString())
              expect(Date.parse(execution.arrivedAt) - Date.parse(execution.submittedAt)).toBe(10)
            }
          }
          if (scenario === 'partial-exit-reentry') {
            expect(state.fills.map((fill) => fill.quantityMicros)).toEqual([
              '100000000',
              '40000000',
              '40000000',
              '20000000',
            ])
            const restarted = yield* makeReplayExecutionRuntime(runtimeInput)
            expect(restarted.authorityGenerationHash).toBe(runtime.authorityGenerationHash)
            yield* restarted.advance
            expect((yield* broker.snapshot).fills).toHaveLength(4)
            yield* advanceMarketTo(reentryAtMs)
            for (let attempt = 0; attempt < 12; attempt++) {
              const advanced = yield* restarted.advance
              if (advanced.result?.outcome === 'RECOVERED' && advanced.result.action === 'COMPLETED') break
              yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1000)
            }
            const repeated = yield* broker.snapshot
            expect(
              repeated.fills.map((fill) => fill.side),
              JSON.stringify(yield* Ref.get(passes)),
            ).toEqual([OrderSide.Buy, OrderSide.Sell, OrderSide.Sell, OrderSide.Sell, OrderSide.Buy, OrderSide.Sell])
            expect(managementCalls).toBe(2)
            expect(repeated.ledger.positions).toHaveLength(0)
            const final = yield* restarted.reconcile
            expect(final.report.metrics.accountingExact).toBe(true)
            expect(final.brokerState.account.cashMicros).toBe(repeated.ledger.cashMicros)
            expect(final.riskContext.unknownMutationCount).toBe(0)
            expect(final.brokerState.unknownOrderCount).toBe(0)
            expect(yield* sql`SELECT state FROM autonomous_cycles WHERE account_id = ${accountId}`).toEqual([
              { state: 'COMPLETED' },
              { state: 'COMPLETED' },
            ])
            expect(
              yield* sql`
                SELECT payload #>> '{manifest,rangeEndAt}' AS window_end
                FROM intraday_candidate_observations
                WHERE payload #>> '{portfolio,purpose}' = 'ENTRY'
                ORDER BY observed_at
              `,
            ).toEqual([{ window_end: '2026-09-04T14:30:00.000Z' }, { window_end: '2026-09-04T14:32:00.000Z' }])
            expect(
              yield* sql`
                SELECT count(*)::integer AS plans,
                  bool_and(replan.document #> '{document,strategyDecision}' =
                    original.document #> '{document,strategyDecision}') AS same_exit_evidence
                FROM autonomous_cycle_paper_close_replans AS replan
                JOIN autonomous_cycle_paper_closures AS original USING (cycle_id)
              `,
            ).toEqual([{ plans: 2, same_exit_evidence: true }])
          }
          return { _tag: 'Lifecycle' as const }
        }
        let waiting = yield* runtime.advance
        for (
          let attempt = 0;
          attempt < 4 && waiting.result?.outcome === 'RECOVERED' && waiting.result.waitReason !== 'JEV_POSITION_HELD';
          attempt++
        ) {
          const nextMs = (yield* Clock.currentTimeMillis) + 1000
          yield* clock.advanceTo(utcInstantFromEpochMillis(nextMs))
          yield* TestClock.setTime(nextMs)
          waiting = yield* runtime.advance
        }
        expect(waiting.result).toMatchObject({
          outcome: 'RECOVERED',
          action: 'WAITING',
          waitReason: 'JEV_POSITION_HELD',
        })
        const recreated = yield* makeReplayExecutionRuntime(runtimeInput)
        expect(recreated.authorityGenerationHash).toBe(runtime.authorityGenerationHash)
        const frozenAt = yield* Clock.currentTimeMillis
        const liveClock = yield* TestClock.withLive(Clock.clockWith(Effect.succeed))
        yield* Ref.set(stallReconciliation, true)
        const stalledFinal = yield* Effect.exit(
          runtime.reconcile.pipe(Effect.provideService(OperationDeadlineClock, liveClock)),
        )
        expect(stalledFinal._tag).toBe('Failure')
        expect(JSON.stringify(stalledFinal)).toContain('Replay reconciliation exceeded 1000ms')
        expect(yield* Ref.get(interrupted)).toBe(true)
        expect(yield* Clock.currentTimeMillis).toBe(frozenAt)
        yield* Ref.set(stallReconciliation, false)
        for (const arrival of closeArrivals)
          cursor = yield* Effect.fromResult(advanceHistoricalMarketCursor(cursor, arrival))
        yield* clock.advanceTo(utcInstantFromEpochMillis(closeAtMs))
        yield* TestClock.setTime(closeAtMs)
        for (let attempt = 0; attempt < 20 && (yield* broker.snapshot).ledger.positions.length > 0; attempt++) {
          yield* runtime.advance
          const nextMs = (yield* Clock.currentTimeMillis) + 1000
          yield* clock.advanceTo(utcInstantFromEpochMillis(nextMs))
          yield* TestClock.setTime(nextMs)
        }
        const brokerState = yield* broker.snapshot
        const reconciliation = yield* runtime.reconcile
        if (scenario === 'fallback') {
          expect(brokerState.orders.at(-1)?.order).toMatchObject({
            orderType: BrokerOrderType.Market,
            timeInForce: BrokerTimeInForce.Day,
          })
        }
        expect(brokerState.ledger.positions).toHaveLength(0)
        expect(brokerState.fills.map((fill) => fill.side)).toEqual([OrderSide.Buy, OrderSide.Sell])
        const rows = yield* sql<Record<string, unknown>>`SELECT
      (SELECT count(*)::int FROM intents WHERE account_id = ${accountId}) AS intents,
      (SELECT count(*)::int FROM fills WHERE account_id = ${accountId}) AS fills,
      (SELECT count(*)::int FROM accounting_transactions WHERE account_id = ${accountId}) AS transactions`
        return { _tag: 'Fill' as const, brokerState, reconciliation, rows, passes: yield* Ref.get(passes) }
      }).pipe(
        Effect.scoped,
        Effect.provideService(JevClient, {
          evaluate: (raw) =>
            Effect.gen(function* () {
              const started = yield* Clock.currentTimeMillis
              const { request } = Result.getOrThrow(prepareJevRequest(raw))
              const action = request.questions['action']
              const managing = action?.type === 'choice' && 'exit' in action.criteria
              if (managing) managementCalls += 1
              if (scenario === 'measured-exit') yield* Effect.sleep('100 millis')
              const now = yield* Clock.currentTimeMillis
              return {
                ...nativeJevInference(
                  raw,
                  utcInstantFromEpochMillis(now),
                  managing
                    ? scenario === 'early-exit' || scenario === 'partial-exit-reentry' || scenario === 'measured-exit'
                      ? 'exit'
                      : 'hold'
                    : scenario === 'no-trade'
                      ? 'wait'
                      : 'enter',
                ),
                startedAt: utcInstantFromEpochMillis(started),
              }
            }),
        }),
        Effect.provide(stores),
        Effect.provide(TestClock.layer()),
        Effect.provide(NodeServices.layer),
      ),
    )
    if (outcome._tag !== 'Fill') return
    expect(outcome.brokerState.fills.length, JSON.stringify(outcome.passes)).toBeGreaterThan(0)
    expect(outcome.rows[0]?.['intents']).toBeGreaterThan(0)
    expect(outcome.rows[0]?.['fills']).toBe(outcome.brokerState.fills.length)
    expect(outcome.rows[0]?.['transactions']).toBe(outcome.brokerState.fills.length)
    expect(outcome.reconciliation.brokerState.unknownOrderCount).toBe(0)
    expect(outcome.reconciliation.brokerState.account.cashMicros).toBe(outcome.brokerState.ledger.cashMicros)
    expect(outcome.reconciliation.report.metrics.accountingExact).toBe(true)
    expect(outcome.reconciliation.riskContext.unknownMutationCount).toBe(0)
  },
  30000,
)
