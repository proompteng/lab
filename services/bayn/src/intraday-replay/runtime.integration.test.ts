import { assessBacktestSession, BacktestIssue } from './backtest'
import { driveReplaySession } from './session'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { OrderStatus, OrderType as BrokerOrderType, TimeInForce as BrokerTimeInForce } from '../broker/alpaca/model'
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
import { JevClient, JevError } from '../jev/client'
import { nativeJevInference } from '../jev/native.test-support'
import { JevFailure, prepareJevRequest } from '../jev/contract'
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
  'no-trade-finalization',
  'missing-calendar',
  'failed-model-response',
  'failed-management-response',
  'recovery',
  'recovery-filled',
  'early-exit',
  'partial-exit-reentry',
  'measured-exit',
  'measured-bootstrap-delay',
  'measured-partial-entry-reentry',
  'measured-entry-expired',
  'measured-zero-fill-reentry',
  'measured-submit-expired-reentry',
  'operator-held-replay',
  'operator-after-system-replay',
  'reconciliation-idle-recovery',
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
    const noTrade = scenario === 'no-trade' || scenario === 'no-trade-finalization'
    const finalizationAtMs = Date.parse('2026-09-04T19:54:15Z')
    let managementCalls = 0
    const measuredCalls: ReplayJevCall[] = []
    let measuredProviderClock: TestClock.TestClock | undefined
    let expiredStartedSubmit = false
    const measured =
      scenario === 'measured-exit' ||
      scenario === 'measured-bootstrap-delay' ||
      scenario === 'measured-partial-entry-reentry' ||
      scenario === 'measured-entry-expired' ||
      scenario === 'measured-zero-fill-reentry' ||
      scenario === 'measured-submit-expired-reentry'
    const fixture = { ...simulationFixture(undefined, undefined, noTrade ? {} : undefined), protocol }
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
        : measured
          ? [
              { at: initialAtMs + 1, fullWindow: true, offset: 1000n, bidSize: 100, premium: 0.02 },
              ...Array.from({ length: 200 }, (_, index) => ({
                at: initialAtMs + (index + 1) * 200,
                fullWindow: false,
                offset: BigInt((index + 2) * 1000),
                bidSize: 100,
                premium: 0.02 + (index + 1) * 0.00002,
              })),
              ...(scenario === 'measured-zero-fill-reentry' ||
              scenario === 'measured-submit-expired-reentry' ||
              scenario === 'measured-partial-entry-reentry'
                ? [{ at: reentryAtMs, fullWindow: true, offset: 300_000n, bidSize: 100, premium: 0.02 }]
                : []),
            ]
          : scenario === 'no-trade-finalization'
            ? [{ at: finalizationAtMs, fullWindow: true, offset: 300_000n, bidSize: 100, premium: 0.02 }]
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
      scenario === 'failed-management-response'
        ? initialAtMs + (protocol.maximumHoldingMinutes + 1) * 60_000
        : scenario === 'fill' || scenario === 'fallback'
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
        const providerClock = yield* TestClock.make()
        measuredProviderClock = providerClock
        yield* providerClock.setTime(Date.parse('2026-09-21T12:00:00.000Z'))
        const timing = measured
          ? yield* makeReplayJevTiming({
              measureDatabaseTime: (operation) => operation,
              provider,
              providerClock,
              advanceTo: (atMs) =>
                advanceMarketTo(atMs).pipe(
                  Effect.tap(() => (scenario === 'measured-bootstrap-delay' ? providerClock.adjust(5) : Effect.void)),
                  Effect.mapError(
                    (cause) => new ReplayBrokerFailure({ message: 'Measured source advance failed', cause }),
                  ),
                ),
              retain: (call) =>
                Effect.gen(function* () {
                  measuredCalls.push(call)
                  if (scenario === 'measured-entry-expired' && measuredCalls.length === 15)
                    yield* providerClock.adjust(6000)
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
            availableLiquidityPpm:
              scenario === 'recovery' || scenario === 'measured-zero-fill-reentry'
                ? 1
                : scenario === 'measured-partial-entry-reentry'
                  ? 400000
                  : 1000000,
            feeMultiplierPpm: 1000000,
          },
          fractionalTrading: false,
          calendar: Result.getOrThrow(
            Schema.decodeUnknownResult(MarketCalendarResponseSchema)(
              scenario === 'missing-calendar'
                ? []
                : scenario === 'no-trade-finalization'
                  ? [...fixture.input.calendar, { date: '2026-09-08', open: '09:30', close: '16:00' }]
                  : fixture.input.calendar,
            ),
          ),
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
          ...(timing === undefined ? {} : { submissionTime: timing.currentUtcInstant }),
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
          currentUtcInstant: Effect.gen(function* () {
            if (scenario === 'reconciliation-idle-recovery')
              yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1)
            if (scenario === 'measured-submit-expired-reentry' || scenario === 'measured-partial-entry-reentry')
              yield* providerClock.adjust(1)
            if (scenario === 'measured-submit-expired-reentry' && !expiredStartedSubmit) {
              const started = yield* sql`SELECT intent_id FROM intents WHERE state = 'IO_STARTED' LIMIT 1`
              if (started.length > 0) {
                expiredStartedSubmit = true
                yield* providerClock.adjust(6000)
              }
            }
            return yield* timing?.currentUtcInstant ?? currentUtcInstant
          }),
          recordPass: (pass: Parameters<import('../app').RecordAutonomousCyclePass>[0]) =>
            Ref.update(passes, (values) => [...values, pass]),
          pollIntervalMs: scenario === 'no-trade-finalization' ? 30_000 : 1000,
          reconciliationIntervalMs:
            scenario === 'no-trade-finalization' ? 30_000 : measured ? config.operationTimeoutMs : 1000,
          reconciliationPassTimeoutMs:
            scenario === 'no-trade-finalization'
              ? 30_000
              : scenario === 'fill' || scenario === 'fallback'
                ? 1000
                : config.operationTimeoutMs,
        }
        const createRuntime = makeReplayExecutionRuntime(runtimeInput).pipe(
          Effect.provideService(JevClient, timing?.client ?? provider),
          (operation) => (timing === undefined ? operation : timing.run(operation)),
          Effect.map((engine) => ({
            ...engine,
            advance:
              timing === undefined
                ? engine.advance
                : timing.run(engine.advance).pipe(Effect.provideService(OperationDeadlineClock, providerClock)),
            reconcile:
              timing === undefined
                ? engine.reconcile
                : timing.run(engine.reconcile).pipe(Effect.provideService(OperationDeadlineClock, providerClock)),
          })),
        )
        const runtime = yield* createRuntime
        if (scenario === 'measured-bootstrap-delay') {
          const restarted = yield* createRuntime
          expect(restarted.authorityGenerationHash).toBe(runtime.authorityGenerationHash)
          expect(yield* sql`SELECT maximum, effective, kill_state FROM authority_state WHERE singleton`).toEqual([
            { maximum: 'PAPER', effective: 'PAPER', kill_state: 'CLEAR' },
          ])
          expect(
            yield* sql`SELECT status, reconciled_at <= execution_account_now(${accountId}) AS observed
              FROM reconciliations ORDER BY reconciled_at DESC LIMIT 1`,
          ).toEqual([{ status: 'EXACT', observed: true }])
          expect((yield* broker.snapshot).orders).toEqual([])
          expect(measuredCalls).toEqual([])
          return { _tag: 'Coverage' as const }
        }
        if (scenario === 'missing-calendar') {
          yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1)
          const pass = yield* runtime.advance
          expect(pass.observation).toMatchObject({ result: 'FAILURE', failure: 'calendar-unavailable' })
          expect((yield* broker.snapshot).orders).toEqual([])
          expect(yield* sql`SELECT count(*)::int AS count FROM autonomous_cycles`).toEqual([{ count: 0 }])
          expect(yield* sql`SELECT count(*)::int AS count FROM jev_evaluation_requests`).toEqual([{ count: 0 }])
          return { _tag: 'Coverage' as const }
        }
        if (scenario === 'reconciliation-idle-recovery') {
          const readAuthority = runtime.store.authorityGeneration.readAuthorityState
          if (readAuthority === undefined) throw new Error('Missing replay authority reader')
          expect(yield* sql`SELECT count(*)::int AS cycles FROM autonomous_cycles`).toEqual([{ cycles: 0 }])
          yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1)
          yield* runtime.store.authorityRestriction.restrictAuthority(
            `reconciliation discrepancy ${canonicalHashV1({ transient: true })}`,
            yield* currentUtcInstant,
          )
          yield* advanceMarketTo(initialMs + 1000)
          const restarted = yield* createRuntime
          for (let attempt = 0; attempt < 5; attempt++) {
            yield* restarted.advance
            if ((yield* readAuthority).effective === Authority.Execution) break
            yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1000)
          }
          const recovered = yield* readAuthority
          expect(recovered).toMatchObject({
            maximum: Authority.Execution,
            effective: Authority.Execution,
            kill: KillState.Clear,
          })
          expect(recovered.generationHash).not.toBe(runtime.authorityGenerationHash)
          expect((yield* broker.snapshot).orders).toEqual([])
          expect(yield* sql`SELECT state, decision_hash FROM autonomous_cycles`).toEqual([
            { state: 'PENDING', decision_hash: null },
          ])
          expect((yield* restarted.reconcile).report.reconciliation.status).toBe(ReconciliationStatus.Exact)
          return { _tag: 'IdleRecovery' as const }
        }
        if (scenario === 'operator-held-replay' || scenario === 'operator-after-system-replay') {
          yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1)
          if (scenario === 'operator-after-system-replay') {
            yield* runtime.store.authorityRestriction.restrictAuthority(
              `reconciliation discrepancy ${canonicalHashV1({ transient: true })}`,
              yield* currentUtcInstant,
            )
            yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1000)
          }
          yield* runtime.store.authorityRestriction.restrictAuthority('operator hold fixture', yield* currentUtcInstant)
          expect(yield* sql`SELECT reason FROM authority_state`).toEqual([{ reason: 'operator hold fixture' }])
          yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1000)
          const restarted = yield* createRuntime
          for (let attempt = 0; attempt < 3; attempt++) {
            yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1000)
            expect((yield* restarted.advance).observation.result).toBe('FAILURE')
          }
          expect((yield* broker.snapshot).orders).toHaveLength(0)
          expect(yield* sql`SELECT count(*)::int AS calls FROM jev_evaluation_requests`).toEqual([{ calls: 0 }])
          expect(yield* sql`SELECT generation_hash, effective, kill_state, reason FROM authority_state`).toEqual([
            {
              generation_hash: runtime.authorityGenerationHash,
              effective: 'OBSERVE',
              kill_state: 'ACTIVE',
              reason: 'operator hold fixture',
            },
          ])
          return { _tag: 'OperatorHeld' as const }
        }
        if (scenario === 'measured-submit-expired-reentry') {
          yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1)
          const readAuthority = runtime.store.authorityGeneration.readAuthorityState
          if (readAuthority === undefined) throw new Error('Missing replay authority reader')
          for (let attempt = 0; attempt < 20; attempt++) {
            yield* runtime.advance
            const authority = yield* readAuthority
            if (
              expiredStartedSubmit &&
              authority.generationHash !== runtime.authorityGenerationHash &&
              authority.effective === Authority.Execution
            )
              break
            yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1000)
          }
          expect(expiredStartedSubmit).toBe(true)
          expect((yield* broker.snapshot).orders).toHaveLength(0)
          expect(yield* sql`SELECT event_type FROM mutation_events WHERE event_type = 'SUBMIT_DENIED'`).toEqual([
            { event_type: 'SUBMIT_DENIED' },
          ])
          const recovered = yield* readAuthority
          expect(recovered).toMatchObject({
            maximum: Authority.Execution,
            effective: Authority.Execution,
            kill: KillState.Clear,
          })
          expect(recovered.generationHash).not.toBe(runtime.authorityGenerationHash)
          expect((yield* runtime.reconcile).report.reconciliation.status).toBe(ReconciliationStatus.Exact)
          const restarted = yield* createRuntime.pipe(Effect.provideService(JevClient, timing?.client ?? provider))
          expect(restarted.authorityGenerationHash).toBe(recovered.generationHash)
          if (timing === undefined) throw new Error('Missing measured timing')
          yield* advanceMarketTo(reentryAtMs)
          for (let attempt = 0; attempt < 8; attempt++) {
            yield* restarted.advance
            if ((yield* broker.snapshot).fills.length > 0) break
            yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1000)
          }
          expect((yield* broker.snapshot).fills.map((fill) => fill.side)).toEqual([OrderSide.Buy])
          expect(measuredCalls).toHaveLength(30)
          expect(
            yield* sql`SELECT state, count(*)::int AS count FROM autonomous_cycles GROUP BY state ORDER BY state`,
          ).toEqual([
            { state: 'ACTIVE', count: 1 },
            { state: 'BLOCKED', count: 1 },
          ])
          return { _tag: 'ExpiredSubmitRecovered' as const }
        }
        if (scenario === 'no-trade-finalization') {
          yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1)
          yield* runtime.advance
          yield* advanceMarketTo(initialMs + 2)
          yield* runtime.advance
          expect(yield* sql`SELECT state, decision_hash FROM autonomous_cycles`).toEqual([
            { state: 'ACTIVE', decision_hash: null },
          ])
          yield* advanceMarketTo(finalizationAtMs)
          const schedule = yield* driveReplaySession(
            runtime,
            (at) =>
              advanceMarketTo(at).pipe(
                Effect.mapError(
                  (cause) => new ReplayBrokerFailure({ message: 'Finalization test clock failed', cause }),
                ),
              ),
            finalizationAtMs + 1,
            finalizationAtMs + 120_001,
          )
          const reconciliation = yield* runtime.reconcile
          const state = yield* broker.snapshot
          expect(managementCalls).toBe(0)
          expect(state.orders).toEqual([])
          expect(state.fills).toEqual([])
          expect(state.ledger.positions).toEqual([])
          expect(
            yield* sql`SELECT state, decision_hash IS NOT NULL AS bound FROM autonomous_cycles WHERE execution_session_date = '2026-09-04'`,
          ).toEqual([{ state: 'NO_TRADE', bound: true }])
          expect(yield* sql`SELECT count(*)::int AS count FROM intents`).toEqual([{ count: 0 }])
          expect(schedule.failedPassCount).toBe(0)
          expect(schedule.unavailableDecisionPassCount).toBe(0)
          expect(yield* sql`SELECT effective, kill_state FROM authority_state`).toEqual([
            { effective: 'PAPER', kill_state: 'CLEAR' },
          ])
          expect(
            assessBacktestSession({
              ...schedule,
              valuationFailureCount: 0,
              remainingPositionCount: state.ledger.positions.length,
              reconciliation: {
                status: reconciliation.report.reconciliation.status,
                metrics: reconciliation.report.metrics,
                unknownOrderCount: reconciliation.brokerState.unknownOrderCount,
                unknownMutationCount: reconciliation.riskContext.unknownMutationCount,
              },
            }),
          ).toEqual({ completion: 'COMPLETE', issues: [] })
          return { _tag: 'Coverage' as const }
        }
        if (scenario === 'missing-benchmark' || scenario === 'no-trade' || scenario === 'failed-model-response') {
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
          expect(state.orders).toEqual([])
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
          if (scenario !== 'no-trade') {
            expect(schedule.unavailableDecisionPassCount).toBeGreaterThan(0)
            expect(assessment).toEqual({ completion: 'INCOMPLETE', issues: [BacktestIssue.MissingDecisionData] })
            if (scenario === 'failed-model-response') {
              expect(schedule.readinessCounts[DecisionReadinessReason.InferenceUnavailable]).toBeGreaterThan(0)
              expect(schedule.readinessCounts[DecisionReadinessReason.NoEligibleCandidate]).toBeUndefined()
            }
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
        yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1)
        if (scenario === 'measured-zero-fill-reentry') {
          let pendingCompletionCount = 0
          const completeCycle = Effect.gen(function* () {
            for (let pass = 0; pass < 20; pass++) {
              const advanced = yield* runtime.advance
              expect(advanced.observation.result, JSON.stringify(advanced.observation)).toBe('SUCCESS')
              if (advanced.result?.outcome === 'RECOVERED' && advanced.result.action === 'COMPLETED') return
              if (
                advanced.result?.outcome === 'RECOVERED' &&
                advanced.result.action === 'WAITING' &&
                advanced.result.waitReason === 'COMPLETION_EVIDENCE_PENDING'
              )
                pendingCompletionCount += 1
              yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1000)
            }
            throw new Error('Zero-fill cycle did not complete')
          })
          yield* completeCycle
          expect(pendingCompletionCount).toBeGreaterThan(0)
          const first = yield* broker.snapshot
          expect(first.orders).toHaveLength(1)
          expect(first.orders[0]?.order.status).toBe(OrderStatus.Canceled)
          expect(first.fills).toHaveLength(0)
          expect(first.ledger.positions).toHaveLength(0)
          yield* runtime.advance
          expect((yield* broker.snapshot).orders).toHaveLength(1)
          yield* advanceMarketTo(reentryAtMs)
          yield* completeCycle
          const final = yield* broker.snapshot
          expect(final.orders).toHaveLength(2)
          expect(final.orders.every(({ order }) => order.status === OrderStatus.Canceled)).toBe(true)
          expect(final.fills).toHaveLength(0)
          expect(final.ledger.positions).toHaveLength(0)
          expect(yield* sql`SELECT state FROM autonomous_cycles ORDER BY created_at`).toEqual([
            { state: 'COMPLETED' },
            { state: 'COMPLETED' },
          ])
          const readAuthority = runtime.store.authorityGeneration.readAuthorityState
          if (readAuthority === undefined) throw new Error('Missing durable authority reader')
          expect(yield* readAuthority).toMatchObject({
            effective: Authority.Execution,
            kill: KillState.Clear,
          })
          expect((yield* runtime.reconcile).report.reconciliation.status).toBe(ReconciliationStatus.Exact)
          return { _tag: 'ZeroFill' as const }
        }
        for (let pass = 0; pass < 20; pass++) {
          const advanced = yield* runtime.advance
          if (advanced.observation.result === 'FAILURE' || (yield* broker.snapshot).fills.length > 0) break
          const nextMs = (yield* Clock.currentTimeMillis) + 1000
          yield* advanceMarketTo(nextMs)
        }
        const settledMs = (yield* Clock.currentTimeMillis) + 1
        yield* advanceMarketTo(settledMs)
        yield* runtime.reconcile
        if (scenario === 'measured-entry-expired') {
          const state = yield* broker.snapshot
          expect(measuredCalls).toHaveLength(15)
          expect(measuredCalls.every((call) => call.outcome.status === 'RECEIVED')).toBe(true)
          expect(state.orders).toHaveLength(0)
          expect(state.fills).toHaveLength(0)
          expect(state.ledger.positions).toHaveLength(0)
          expect(managementCalls).toBe(0)
          expect(
            yield* sql`SELECT (SELECT count(*)::int FROM intents) AS intents,
              (SELECT count(*)::int FROM jev_evaluation_requests) AS requests,
              (SELECT count(*)::int FROM jev_batch_results) AS batches`,
          ).toEqual([{ intents: 0, requests: 15, batches: 1 }])
          return { _tag: 'Expired' as const }
        }
        if (
          scenario === 'early-exit' ||
          scenario === 'partial-exit-reentry' ||
          scenario === 'measured-exit' ||
          scenario === 'measured-partial-entry-reentry'
        ) {
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
          if (scenario === 'measured-partial-entry-reentry') {
            expect(state.fills.map((fill) => fill.quantityMicros)).toEqual(['40000000', '40000000'])
            expect(state.orders[0]?.order.status).toBe(OrderStatus.Canceled)
            const restarted = yield* createRuntime
            yield* advanceMarketTo(reentryAtMs)
            for (let attempt = 0; attempt < 12; attempt++) {
              const advanced = yield* restarted.advance
              if (advanced.result?.outcome === 'RECOVERED' && advanced.result.action === 'COMPLETED') break
              yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1000)
            }
            const repeated = yield* broker.snapshot
            expect(repeated.fills.map((fill) => fill.side)).toEqual([
              OrderSide.Buy,
              OrderSide.Sell,
              OrderSide.Buy,
              OrderSide.Sell,
            ])
            expect(repeated.ledger.positions).toHaveLength(0)
            expect((yield* restarted.reconcile).report.reconciliation.status).toBe(ReconciliationStatus.Exact)
            expect(yield* sql`SELECT state FROM autonomous_cycles WHERE account_id = ${accountId}`).toEqual([
              { state: 'COMPLETED' },
              { state: 'COMPLETED' },
            ])
          }
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
            const restarted = yield* createRuntime
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
        if (scenario === 'failed-management-response') {
          expect((yield* broker.snapshot).fills.map((fill) => fill.side)).toEqual([OrderSide.Buy])
          const start = (yield* Clock.currentTimeMillis) + 1
          const schedule = yield* driveReplaySession(
            runtime,
            (at) =>
              advanceMarketTo(at).pipe(
                Effect.mapError(
                  (cause) => new ReplayBrokerFailure({ message: 'Management evidence clock failed', cause }),
                ),
              ),
            start,
            start + 4000,
          )
          expect(managementCalls).toBe(1)
          expect(schedule.failedPassCount).toBe(0)
          expect(schedule.readinessCounts[DecisionReadinessReason.InferenceUnavailable]).toBeGreaterThan(0)
          expect(schedule.unavailableDecisionPassCount).toBeGreaterThan(0)
          for (const arrival of closeArrivals)
            cursor = yield* Effect.fromResult(advanceHistoricalMarketCursor(cursor, arrival))
          yield* advanceMarketTo(closeAtMs)
          for (let attempt = 0; attempt < 20 && (yield* broker.snapshot).ledger.positions.length > 0; attempt++) {
            yield* runtime.advance
            yield* advanceMarketTo((yield* Clock.currentTimeMillis) + 1000)
          }
          const state = yield* broker.snapshot
          const reconciliation = yield* runtime.reconcile
          expect(state.fills.map((fill) => fill.side)).toEqual([OrderSide.Buy, OrderSide.Sell])
          expect(state.ledger.positions).toHaveLength(0)
          expect(managementCalls).toBe(1)
          expect(
            assessBacktestSession({
              ...schedule,
              valuationFailureCount: 0,
              remainingPositionCount: state.ledger.positions.length,
              reconciliation: {
                status: reconciliation.report.reconciliation.status,
                metrics: reconciliation.report.metrics,
                unknownOrderCount: reconciliation.brokerState.unknownOrderCount,
                unknownMutationCount: reconciliation.riskContext.unknownMutationCount,
              },
            }),
          ).toEqual({ completion: 'INCOMPLETE', issues: [BacktestIssue.MissingDecisionData] })
          return { _tag: 'ManagementUnavailable' as const }
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
        const recreated = yield* createRuntime
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
              if (measured) {
                if (measuredProviderClock === undefined) throw new Error('Missing independent provider test clock')
                yield* measuredProviderClock.adjust(100)
              }
              const now = yield* Clock.currentTimeMillis
              if (scenario === 'failed-model-response' || (scenario === 'failed-management-response' && managing)) {
                const rejected = {
                  ...nativeJevInference(raw, utcInstantFromEpochMillis(now), managing ? 'hold' : 'enter').response,
                  answers: {},
                }
                return yield* new JevError({
                  failure: JevFailure.Response,
                  message: 'Response has billed usage but no valid decision answers',
                  responseHash: canonicalHashV1(rejected),
                  rejectedResponse: Redacted.make(rejected),
                })
              }
              return {
                ...nativeJevInference(
                  raw,
                  utcInstantFromEpochMillis(now),
                  managing
                    ? scenario === 'early-exit' ||
                      scenario === 'partial-exit-reentry' ||
                      scenario === 'measured-exit' ||
                      scenario === 'measured-partial-entry-reentry'
                      ? 'exit'
                      : 'hold'
                    : noTrade
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
