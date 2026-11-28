import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { replayRateCardFixture } from '../testing/inference-rate-card.test-support'
import { nativeReplayPolicyIdentity, nativeReplayStrategyIdentity } from './native-policy'
import { alphaTradeReplayFixture } from './alpha-replay.test-support'
import { preparedReplayAlphaBaselineFixture } from './alpha-prepared-baseline.test-support'
import { PreparedReplayAlphaObservationSchema, ReplayAlphaObservationSchema } from './alpha-report'
import { IntradayAlphaPhase, intradayAlphaEquityMarketProfile } from '../strategy/intraday-alpha/policy'
import { decodeExecutionDecisionDocument } from '../shadow-decision-contract'
import { activeStrategyBehaviorHash, loadActiveStrategyProtocol, loadSharedJevProtocol } from '../strategy'
import { chartProviderFixture } from '../jev/entry-inference.test-support'
import { makeReplayInferenceBudget } from './inference-timing'
import { replayTestInstruments } from '../testing/replay-instruments'
import { currentEquityMarketProfile as equityMarketProfile } from '../jev/markets'

import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, FileSystem, Layer, Redacted, Result, Schema } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'

import { PostgresClientLive } from '../db/postgres-client'
import { ExecutionCycleClosureStoreLive } from '../db/execution-cycle-closure-postgres'
import { PersistedCapitalGrantStoreLive } from '../db/persisted-capital-grant'
import { IntentStoreLive } from '../execution/intents/postgres'
import { BlockedCycleIntentStoreLive } from '../execution/intents/blocked-cycle-postgres'
import { MutationStoreLive } from '../execution/mutations/program'
import { WriterFenceLive } from '../execution/writer-fence'
import { JournalLive } from '../ledger'
import { jevBacktestOutcome } from '../jev/experiment-economics'
import { jevInstructions } from '../jev/instructions'
import { jevModel } from '../jev/contract'
import { OperationDeadlineClock } from '../operation-timeout'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import {
  nativeReplayFixture as retainedReplayFixture,
  retainedReplayCaptureFixture,
  momentumTradeReplayFixture,
} from '../testing/retained-replay-fixture'
import { config } from '../testing/runtime-fixtures'
import { BacktestBuildEvidenceSchema, BacktestIssue, prepareBacktest, runBacktest, type BacktestPass } from './backtest'
import { postgresMigrations } from '../db/postgres-migrations'
import { canonicalHashV1Result, sha256 } from '../hash'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { AssetClass, AssetExchange, AssetStatus, OrderSide as BrokerOrderSide } from '../broker/alpaca/model'
import { IntentState, OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { streamingFixture } from '../testing/streaming-market-fixture'
import {
  emptyStreamingProjection,
  incorporateRecordedMarketValue,
  observedQuoteAt,
} from '../market-data/streaming/projection'
import { makeReplayBroker, ReplayBrokerFailure } from './broker'
import { ReplayBrokerCheckpointSchema } from './broker-checkpoint'
import { makeSimulatedExecutionClock } from './clock'
import { makeReplayInferenceTiming } from './inference-timing'
import { makeReplayTimeline } from './session'
import { JevResearchPolicy } from '../jev/acceptance'
import { writeCompiledReplayCommand } from './replay-cli.test-support'
import { decodeEquityExecutionTape, EquityExecutionTapeReferenceSchema } from './equity-execution-tape'

const durableTest = baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined ? test.skip : test

durableTest(
  'measured cleanup consumes closing arrivals before valuing residual inventory',
  async () => {
    if (baynTestPostgresUrl === undefined) throw new Error('Missing isolated replay database')
    const url = new URL(baynTestPostgresUrl)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Closing-cut acceptance requires an isolated local test database')
    const { protocol, snapshot } = streamingFixture()
    const original = snapshot.quotes.find((quote) => quote.symbol === 'AAPL')
    if (original === undefined) throw new Error('Missing closing-cut quote')
    const closeMs = Date.parse('2026-09-04T20:00:00.000Z')
    const startMs = closeMs - 1000
    const runId = Result.getOrThrow(canonicalHashV1Result({ test: 'measured-closing-cut', run: randomUUID() }))
    const sourceHash = Result.getOrThrow(canonicalHashV1Result({ runId }))
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* postgresMigrations
        const sql = yield* PgClient.PgClient
        const providerClock = yield* TestClock.withLive(Clock.clockWith(Effect.succeed))
        yield* TestClock.setTime(startMs)
        const clock = yield* makeSimulatedExecutionClock(runId, sourceHash, providerClock)
        const universe = {
          universeId: equityMarketProfile.universeId,
          universeSymbolHash: equityMarketProfile.universeSymbolHash,
          symbols: equityMarketProfile.universe,
          topics: { ...equityMarketProfile.sourceTopics, features: 'torghut.market-features.v1' },
        }
        const quotes = [
          [startMs, 100],
          [closeMs - 50, 99],
          [closeMs + 50, 98],
        ] as const
        let projection = emptyStreamingProjection('measured-closing-cut')
        let consumed = 0
        let sourceCut = startMs
        const { advanceTo, advanceDeadlineTo } = yield* makeReplayTimeline(
          {
            advanceTo: (atMs) =>
              clock.excludeSourceTime(
                Effect.sync(() => {
                  for (; consumed < quotes.length; consumed++) {
                    const next = quotes[consumed]
                    if (next === undefined || next[0] > atMs) break
                    projection = incorporateRecordedMarketValue(
                      projection,
                      {
                        ...original,
                        sourceOffset: String(BigInt(original.sourceOffset) + BigInt(consumed)),
                        eventAt: new Date(next[0]).toISOString(),
                        ingestedAt: new Date(next[0]).toISOString(),
                        marketSession: next[0] < closeMs ? 'regular' : 'post',
                        bidPrice: next[1],
                        askPrice: next[1],
                        bidSize: 100,
                        askSize: 100,
                      },
                      universe,
                      next[0],
                    )
                  }
                  sourceCut = atMs
                }),
              ),
          },
          clock,
          closeMs + 60_000,
        )
        yield* advanceTo(startMs)
        const broker = yield* makeReplayBroker({
          runId,
          sourceManifestHash: sourceHash,
          protocol,
          openingCashMicros: '10000000000',
          assumptions: { latencyMs: 0, slippageBps: 0, availableLiquidityPpm: 1000000, feeMultiplierPpm: 1000000 },
          fractionalTrading: false,
          calendar: [
            { session_open: '0930', session_close: '1600', date: '2026-09-04', open: '09:30', close: '16:00' },
          ],
          assets: [
            Result.getOrThrow(
              normalizeAssetResult(
                {
                  id: '12345678-1234-4234-8234-123456789abc',
                  symbol: 'AAPL',
                  class: AssetClass.UsEquity,
                  exchange: AssetExchange.Nasdaq,
                  status: AssetStatus.Active,
                  tradable: true,
                  fractionable: true,
                },
                'AAPL',
                new Date(startMs).toISOString(),
              ),
            ),
          ],
          advanceToArrival: advanceTo,
          quoteAt: (symbol, atMs, source) => Effect.sync(() => observedQuoteAt(projection, symbol, atMs, source)),
        })
        yield* broker.mutation.submit({
          schemaVersion: 'bayn.execution-intent.v5',
          intentId: '1'.repeat(64),
          riskDecisionId: '2'.repeat(64),
          authorityGenerationHash: '3'.repeat(64),
          cycleId: '4'.repeat(64),
          decisionHash: '5'.repeat(64),
          policyHash: '6'.repeat(64),
          strategyName: 'jev',
          accountId: clock.accountId,
          clientOrderId: 'closing-cut-buy',
          symbol: 'AAPL',
          side: OrderSide.Buy,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.Day,
          quantityAtoms: '10000000000',
          notionalLimitMicros: '1000000000',
          limitPriceMicros: '100000000',
          state: IntentState.IoStarted,
          createdAt: new Date(startMs).toISOString(),
        })
        yield* advanceTo(closeMs - 200)
        const timing = yield* makeReplayInferenceTiming({
          budget: makeReplayInferenceBudget(1000),
          providers: {
            jev: entryProviderFixture(
              { evaluate: () => Effect.die('Closing-cut regression does not infer') },
              chartProviderFixture,
            ),
          },
          providerClock,
          advanceTo,
          advanceDeadlineTo,
          excludedSourceMillis: clock.excludedSourceMillis,
          retain: () => Effect.void,
          measureDatabaseTime: (operation) =>
            clock.measure(
              operation.pipe(
                Effect.tap(() =>
                  sql`SELECT pg_sleep(0.4)`.pipe(
                    Effect.mapError(
                      (cause) => new ReplayBrokerFailure({ message: 'Delayed cleanup test query failed', cause }),
                    ),
                  ),
                ),
              ),
            ),
        })
        yield* timing.run(Effect.void)
        const now = yield* Clock.currentTimeMillis
        const close = yield* broker.valuationAt('2026-09-04T20:00:00.000Z')
        const state = yield* broker.snapshot
        const current = (yield* broker.read.account).value
        expect(now).toBeGreaterThan(closeMs + 50)
        expect(close.equityMicros).toBe((BigInt(state.ledger.cashMicros) + 990000000n).toString())
        expect(sourceCut).toBe(now)
        expect(consumed).toBe(3)
        expect(current.equityMicros).toBe((BigInt(state.ledger.cashMicros) + 980000000n).toString())
        expect(state.ledger.positions[0]?.quantityAtoms).toBe('10000000000')
        expect(state.fills).toHaveLength(1)
        expect(
          yield* sql`SELECT measured_at, measured_observed_at FROM simulated_execution_clocks
        WHERE account_id = ${clock.accountId}`,
        ).toEqual([{ measured_at: null, measured_observed_at: null }])
      }).pipe(
        Effect.scoped,
        Effect.provide(
          PostgresClientLive({
            operationTimeoutMs: 30000,
            postgres: { url: Redacted.make(baynTestPostgresUrl), tls: false, caPath: '/unused' },
          }),
        ),
        Effect.provide(TestClock.layer()),
        Effect.provide(NodeServices.layer),
      ),
    )
  },
  30000,
)

durableTest.each([
  'opening',
  'UTC-midnight',
  'unknown-data-cost',
  'retained-responses',
  'momentum-measured',
  'momentum-trading',
  'momentum-trading-sip',
  'alpha-trading',
  'alpha-prepared-trading',
] as const)(
  'native backtest retains %s execution through measured bootstrap and cleanup latency',
  async (boundary) => {
    if (baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined)
      throw new Error('Missing isolated replay databases')
    const url = new URL(baynTestPostgresUrl)
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.endsWith('_test') ||
      !/^127\.0\.0\.1:\d+$/.test(baynTestTigerBeetleAddress)
    )
      throw new Error('Backtest acceptance requires isolated local test databases')
    const alphaFixture = boundary.startsWith('alpha-') ? alphaTradeReplayFixture() : null
    const preparedFixture = boundary === 'alpha-prepared-trading' ? preparedReplayAlphaBaselineFixture() : null
    const trading = alphaFixture !== null || boundary === 'momentum-trading' || boundary === 'momentum-trading-sip'
    const retained = alphaFixture ?? (trading ? momentumTradeReplayFixture() : retainedReplayFixture())
    const market = alphaFixture === null ? equityMarketProfile : intradayAlphaEquityMarketProfile
    const openMs = Date.parse(
      trading
        ? retained.input.query.observedAt
        : boundary !== 'UTC-midnight'
          ? '2026-09-04T13:30:00Z'
          : '2026-09-04T23:59:30Z',
    )
    const closeMs = openMs + (alphaFixture !== null ? 55_000 : trading ? 40_000 : 60_000)
    const tapeRange = { startAt: new Date(openMs).toISOString(), endAt: new Date(closeMs).toISOString() }
    const fixtureQuotes = new Map(retained.input.snapshot.quotes.map((quote) => [quote.symbol, quote]))
    const tapeText =
      boundary === 'momentum-trading-sip'
        ? JSON.stringify({
            schemaVersion: 'bayn.historical-sip-execution-tape.v1',
            ...tapeRange,
            events: Array.from({ length: 41 }, (_, second) =>
              equityMarketProfile.universe.map((symbol) => {
                const quote = fixtureQuotes.get(symbol)
                const mark = symbol === 'AAPL' && second >= 10 ? 1.04 : 1
                return {
                  kind: 'quote',
                  symbol,
                  at: new Date(openMs + second * 1000).toISOString(),
                  bid: quote === undefined ? 0 : quote.bidPrice * mark - 0.01,
                  ask: quote === undefined ? 0 : quote.askPrice * mark - 0.01,
                  bidSize: 100,
                  askSize: 100,
                }
              }),
            ).flat(),
          })
        : undefined
    const tapeReference = tapeText === undefined ? undefined : { sha256: sha256(tapeText), ...tapeRange }
    const tape =
      tapeReference === undefined || tapeText === undefined
        ? undefined
        : Result.getOrThrow(
            decodeEquityExecutionTape(tapeText, tapeReference, {
              universeId: equityMarketProfile.universeId,
              universeSymbolHash: equityMarketProfile.universeSymbolHash,
              symbols: equityMarketProfile.universe,
            }),
          )
    const source = {
      ...retained.manifest,
      coverageStartMs: Math.min(openMs, retained.manifest.coverageStartMs),
      coverageEndMs: Math.max(closeMs, retained.manifest.coverageEndMs),
    }
    const { verification: _verification, ...rootBuild } = config.build
    const policy = boundary.startsWith('momentum-') ? JevResearchPolicy.Momentum : JevResearchPolicy.Candidate
    const protocol = Result.getOrThrow(loadSharedJevProtocol())
    const identity =
      alphaFixture === null
        ? Result.getOrThrow(nativeReplayPolicyIdentity(policy, protocol))
        : Result.getOrThrow(nativeReplayStrategyIdentity(policy, alphaFixture.binding, protocol))
    const build = {
      ...rootBuild,
      strategyBehaviorHash: identity.strategy.behaviorHash,
      strategyParameterHash: identity.strategy.parameterHash,
    }
    const recording = {
      schemaVersion: 'bayn.replay-inference-recording.v1',
      sourceManifestHash: Result.getOrThrow(canonicalHashV1Result(source)),
      sourceRevision: build.sourceRevision,
      strategyBehaviorHash: build.strategyBehaviorHash,
      strategyParameterHash: build.strategyParameterHash,
      jevInstructionsHash: Result.getOrThrow(canonicalHashV1Result(jevInstructions)),
      calls: [],
    }
    const prepared = Result.getOrThrow(
      prepareBacktest(
        {
          ...(alphaFixture === null
            ? { schemaVersion: 'bayn.backtest.v11' }
            : {
                ...(preparedFixture === null
                  ? { schemaVersion: 'bayn.backtest.v12', alphaBaselineSources: alphaFixture.alphaBaselineSources }
                  : { schemaVersion: 'bayn.backtest.v13', alphaBaselinePreparations: [preparedFixture.source] }),
                strategyBinding: alphaFixture.binding,
                equityShortAccount: {
                  shortingEnabled: true,
                  noShorting: false,
                  observedAt: '2026-09-04T13:29:00.000Z',
                  sourceHash: Result.getOrThrow(canonicalHashV1Result({ fixture: 'native-alpha-short-account' })),
                  policy: 'retained-as-of-session',
                },
              }),
          policy,
          latencyStress: null,
          jevInstructionsHash: Result.getOrThrow(canonicalHashV1Result(jevInstructions)),
          replicate: `measured-bootstrap-${randomUUID()}`,
          inference: {
            ...(boundary === 'retained-responses'
              ? {
                  mode: 'retained-responses',
                  recording,
                  recordingHash: Result.getOrThrow(canonicalHashV1Result(recording)),
                }
              : { mode: 'measured-providers' }),
            maximumCalls: 1000,
            models: { jev: jevModel },
            inputDefinition: 'bayn.jev-entry-state.v24',
            costs: replayRateCardFixture({
              jev: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
              chart: {
                inputMicrosPerMillionTokens: '100000',
                outputMicrosPerMillionTokens: '0',
                cachedInputMicrosPerMillionTokens: '10000',
                cacheWriteInputMicrosPerMillionTokens: '125000',
              },
            }),
          },
          allocatedDataCostPerSessionMicros: boundary === 'unknown-data-cost' ? null : trading ? '1000000000' : '0',
          interval: tapeRange,
          ...(tapeReference === undefined ? {} : { equityExecutionTape: tapeReference }),
          source,
          openingCashMicros: '100000000000',
          fractionalTrading: false,
          calendar: [
            {
              session_open: '0930',
              session_close: boundary !== 'UTC-midnight' && !trading ? '0931' : '1600',
              date: '2026-09-04',
              open: '09:30',
              close: boundary !== 'UTC-midnight' && !trading ? '09:31' : '16:00',
            },
            { session_open: '0930', session_close: '1600', date: '2026-09-08', open: '09:30', close: '16:00' },
          ],
          assets: market.universe.map((symbol, index) => ({
            id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
            symbol,
            class: 'us_equity',
            exchange: 'NASDAQ',
            status: 'active',
            tradable: true,
            fractionable: true,
            ...(alphaFixture === null ? {} : { marginable: true, shortable: true, easy_to_borrow: true }),
          })),
          assetObservationAt: '2026-09-04T13:29:00.000Z',
          assetObservationPolicy: 'retained-as-of-session',
          build,
          assumptions: {
            instruments: replayTestInstruments,
            latencyMs: 100,
            slippageBps: 0,
            availableLiquidityPpm: 1000000,
            feeMultiplierPpm: 1000000,
          },
          cadence: {
            pollIntervalMs: 30000,
            reconciliationIntervalMs: 30000,
            reconciliationPassTimeoutMs: 30000,
            reconciliationStaleThresholdMs: 120000,
          },
        },
        retainedReplayCaptureFixture(source),
      ),
    )
    const databases = {
      operationTimeoutMs: 30000,
      postgres: { url: Redacted.make(baynTestPostgresUrl), tls: false, caPath: '/unused' },
      tigerBeetle: { clusterId: 20912n, ledger: 70912, replicaAddresses: [baynTestTigerBeetleAddress] },
    }
    const base = Layer.mergeAll(WriterFenceLive, JournalLive(databases)).pipe(
      Layer.provideMerge(PostgresClientLive(databases)),
    )
    const stores = Layer.mergeAll(
      IntentStoreLive,
      BlockedCycleIntentStoreLive,
      MutationStoreLive,
      ExecutionCycleClosureStoreLive,
      PersistedCapitalGrantStoreLive,
    ).pipe(Layer.provideMerge(base))
    await Effect.runPromise(
      Effect.gen(function* () {
        const providerClock = yield* Clock.clockWith(Effect.succeed)
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: `${import.meta.dir}/../../node_modules`,
          prefix: '.backtest-cli-test-',
        })
        const path = `${directory}/arrivals.ndjson.gz`
        yield* fs.writeFile(path, gzipSync(retained.body))
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        const passes: BacktestPass[] = []
        const report = yield* runBacktest(
          prepared,
          path,
          databases,
          (pass) =>
            Effect.sync(() => {
              passes.push(pass)
            }),
          () => Effect.die('A quiet opening fixture must not call the provider'),
          boundary === 'retained-responses' || !prepared.requiresInference
            ? null
            : {
                jev: entryProviderFixture(
                  { evaluate: () => Effect.die('A quiet opening fixture must not infer') },
                  chartProviderFixture,
                ),
              },
          tape,
        ).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(OperationDeadlineClock, {
            sleep: providerClock.sleep.bind(providerClock),
            currentTimeMillisUnsafe: providerClock.currentTimeMillisUnsafe.bind(providerClock),
            currentTimeNanosUnsafe: providerClock.currentTimeNanosUnsafe.bind(providerClock),
            currentTimeNanos: providerClock.currentTimeNanos,
            monotonicTimeNanosUnsafe: providerClock.monotonicTimeNanosUnsafe.bind(providerClock),
            monotonicTimeNanos: providerClock.monotonicTimeNanos,
            currentTimeMillis: providerClock.currentTimeMillis.pipe(
              Effect.tap(() => Effect.sleep('25 millis').pipe(Effect.provideService(Clock.Clock, providerClock))),
            ),
          }),
        )
        if (alphaFixture !== null) {
          const denials = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                symbol: Schema.String,
                side: Schema.String,
                event_type: Schema.String,
                denial_reason: Schema.NullOr(Schema.String),
              }),
            ),
          )(
            yield* sql`SELECT intent.symbol, intent.side, event.event_type, event.denial_reason
            FROM mutation_events AS event JOIN intents AS intent USING (intent_id)
            WHERE event.event_type IN ('SUBMIT_DENIED', 'SUBMIT_REJECTED')
            ORDER BY event.occurred_at, event.event_id LIMIT 16`,
          )
          const documents = report.decisions.map((row) => Result.getOrThrow(decodeExecutionDecisionDocument(row)))
          yield* Effect.logInfo('Native alpha replay integration evidence').pipe(
            Effect.annotateLogs({
              targets: JSON.stringify(
                documents.map((document) => ({
                  selectedSymbols:
                    document.strategyDecision?.schemaVersion === 'bayn.intraday-alpha-target.v2'
                      ? document.strategyDecision.selectedSymbols
                      : null,
                  phase:
                    document.strategyDecision?.schemaVersion === 'bayn.intraday-alpha-target.v2'
                      ? document.strategyDecision.phase
                      : null,
                  plannedLegs: document.targetPlan.intentTargets.length,
                })),
              ),
              shortEligibility: JSON.stringify(
                report.alphaObservations?.map(({ payload }) => ({
                  observedAt: payload.observedAt,
                  eligibility: Object.fromEntries(
                    ['MU', 'SNDK'].map((symbol) => [symbol, payload.equityShortEligibility?.[symbol] ?? null]),
                  ),
                })),
              ),
              denials: JSON.stringify(denials),
              orderSymbols: JSON.stringify(report.brokerState.orders.map(({ order }) => order.symbol)),
              fillSymbols: JSON.stringify(report.brokerState.fills.map((fill) => fill.symbol)),
              firstIssuedAt: passes[0]?.executionIssuedAt ?? null,
              lastIssuedAt: passes.at(-1)?.executionIssuedAt ?? null,
              lastObservedAt: passes.at(-1)?.observedAt ?? null,
            }),
          )
        }
        expect(Date.parse(passes[0]?.observedAt ?? '')).toBeGreaterThanOrEqual(openMs)
        if (alphaFixture === null) expect(Date.parse(passes.at(-1)?.observedAt ?? '')).toBeGreaterThanOrEqual(closeMs)
        else {
          expect(passes.length).toBeGreaterThan(0)
          expect(
            passes.every(
              (pass) => Date.parse(pass.executionIssuedAt) >= openMs && Date.parse(pass.executionIssuedAt) <= closeMs,
            ),
          ).toBe(true)
          expect(
            passes.every(
              (pass, index) =>
                index === 0 ||
                Date.parse(pass.executionIssuedAt) >= Date.parse(passes[index - 1]?.executionIssuedAt ?? ''),
            ),
          ).toBe(true)
          expect(Date.parse(passes.at(-1)?.observedAt ?? '')).toBeLessThanOrEqual(
            report.sessions.at(-1)?.schedule.completedAtMs ?? Number.NaN,
          )
        }
        expect(report.initialization.startedAt).toBe(new Date(openMs - 60_000).toISOString())
        expect(Date.parse(report.initialization.completedAt)).toBeLessThan(openMs)
        expect(report.initialization.elapsedMs).toBeGreaterThanOrEqual(25)
        expect(report.brokerState.ledger.openingCashMicros).toBe('100000000000')
        expect(report.brokerState.ledger.positions).toEqual([])
        expect(Result.getOrThrow(canonicalHashV1Result(report.brokerCheckpoint.state))).toBe(
          Result.getOrThrow(canonicalHashV1Result(report.brokerState)),
        )
        expect(Date.parse(report.brokerCheckpoint.observedAt)).toBeGreaterThanOrEqual(closeMs)
        expect(report.batches).toEqual([])
        expect(report.inference.providerDispatchCount).toBe(0)
        expect(report.inference.retainedCallCount).toBe(0)
        expect(report.sessions[0]?.schedule.firstPollAtMs).toBe(openMs)
        expect(report.sessions.at(-1)?.schedule.lastPollAtMs).toBe(closeMs)
        expect(report.sessions).toHaveLength(boundary !== 'UTC-midnight' ? 1 : 2)
        expect(report.schedule.failedPassCount).toBe(0)
        expect(report.brokerState.createdAt).toBe(new Date(openMs - 60_000).toISOString())
        if (boundary === 'UTC-midnight') {
          const first = report.sessions[0]?.schedule
          const second = report.sessions[1]?.schedule
          if (first === undefined || second === undefined) throw new Error('Missing UTC reporting window')
          expect(second.firstPollAtMs).toBeGreaterThanOrEqual(first.completedAtMs)
          expect(second.firstPollAtMs).toBeGreaterThanOrEqual(first.nextPollAtMs)
        }
        expect(
          Result.isFailure(
            jevBacktestOutcome({
              report,
              variantBuild: null,
              instructions: jevInstructions,
              operatingAllocations: report.sessionDates.map((sessionDate) => ({
                sessionDate,
                infrastructure: { costMicros: '0', evidenceHash: report.reportHash },
                research: { costMicros: '0', evidenceHash: report.reportHash },
              })),
            }),
          ),
        ).toBe(true)
        expect(report.processedRecords).toBe(source.recordCount)
        expect(report.comparisonInput.equityExecutionTape).toEqual(tapeReference)
        expect(report.inference.calls).toEqual([])
        if (boundary === 'unknown-data-cost') {
          expect(report.completion).toBe('INCOMPLETE')
          expect(report.dataCostMicros).toBeNull()
          expect(report.reconciledNetPnlAfterCostsMicros).toBeNull()
          expect(report.maximumObservedDrawdownMicros).toBeNull()
          expect(report.sessions.every((session) => session.allocatedDataCostMicros === null)).toBe(true)
          expect(report.sessions.every((session) => session.netEquityChangeMicros === null)).toBe(true)
          expect(report.issues).toContain(BacktestIssue.UnresolvedDataCost)
        }
        if (trading) {
          expect(report.completion, JSON.stringify({ issues: report.issues, sessions: report.sessions })).toBe(
            'COMPLETE',
          )
          expect(report.sessions.every((session) => session.schedule.unavailableDecisionPassCount === 0)).toBe(true)
          expect(report.brokerState.fills.some((fill) => fill.side === BrokerOrderSide.Buy)).toBe(true)
          expect(report.brokerState.fills.some((fill) => fill.side === BrokerOrderSide.Sell)).toBe(true)
          if (tape !== undefined)
            expect(new Set(report.brokerState.ledger.fills.map((fill) => fill.quoteSource.topic))).toEqual(
              new Set(['bayn.research.alpaca-sip.quotes.v1']),
            )
          if (alphaFixture === null) expect(report.momentumObservations.length).toBeGreaterThan(0)
          else {
            expect(report.schemaVersion).toBe(
              preparedFixture === null ? 'bayn.backtest-report.v10' : 'bayn.backtest-report.v11',
            )
            expect(report.momentumObservations).toEqual([])
            expect(report.alphaObservations?.length).toBeGreaterThan(0)
            expect(report.alphaBaselineGaps).toEqual([])
            for (const observation of report.alphaObservations ?? []) {
              const use = observation.baselineUse
              expect(use.observationHash).toBe(observation.contentHash)
              expect(use.cycleId).toBe(observation.payload.cycleId)
              expect(use.authorityGenerationHash).toBe(observation.payload.authorityGenerationHash)
              expect(Date.parse(use.commandIssuedAt)).toBeLessThanOrEqual(Date.parse(use.admissionObservedAt))
              expect(Date.parse(use.admissionObservedAt)).toBeLessThanOrEqual(
                Date.parse(observation.payload.observedAt),
              )
              expect(Date.parse(observation.payload.observedAt)).toBeLessThan(Date.parse(use.admissionExpiresAt))
              if (preparedFixture === null) {
                if (use.schemaVersion !== 'bayn.replay-alpha-baseline-use.v1')
                  throw new Error('Retained v12 replay changed its baseline-use contract')
                expect(use.sourceObservationHash).toBe(alphaFixture.alphaBaselineSources[0]?.observationHash)
                expect(use.sourceWitnessHash).toBe(alphaFixture.alphaBaselineSources[0]?.witnessSourceHash)
              } else {
                if (use.schemaVersion !== 'bayn.replay-alpha-baseline-use.v2')
                  throw new Error('Prepared v13 replay omitted its original command and source receipt')
                expect(use.sourcePreparationHash).toBe(preparedFixture.source.preparationHash)
                expect(use.sourceWitnessHash).toBe(preparedFixture.source.witnessSourceHash)
                expect(use.baselineHash).toBe(
                  Result.getOrThrow(canonicalHashV1Result(preparedFixture.source.payload.acquisition.trailingBaseline)),
                )
                expect(Date.parse(preparedFixture.source.availableAt)).toBeLessThanOrEqual(
                  Date.parse(use.commandIssuedAt),
                )
              }
            }
            const documents = report.decisions.map((row) => Result.getOrThrow(decodeExecutionDecisionDocument(row)))
            const selected = documents.find(
              (document) =>
                document.strategyDecision?.schemaVersion === 'bayn.intraday-alpha-target.v2' &&
                document.strategyDecision.selectedSymbols.length === 4,
            )
            if (selected?.strategyDecision?.schemaVersion !== 'bayn.intraday-alpha-target.v2')
              throw new Error('Native alpha replay did not persist its genuine four-leg target')
            expect(selected.strategyDecision.phase).toBe(IntradayAlphaPhase.MiddayReversion)
            expect(new Set(selected.strategyDecision.selectedSymbols)).toEqual(new Set(['COHR', 'LITE', 'MU', 'SNDK']))
            expect(selected.targetPlan.intentTargets).toHaveLength(4)
            expect(report.brokerState.fills.length).toBeGreaterThanOrEqual(8)
            expect(new Set(report.brokerState.fills.map((fill) => fill.symbol))).toEqual(
              new Set(['COHR', 'LITE', 'MU', 'SNDK']),
            )
            expect(
              report.brokerState.orders.filter(({ order }) => order.parentBrokerOrderId !== undefined).length,
            ).toBeGreaterThanOrEqual(8)
          }
          const executionProfit = report.reconciledExecutionPnlAfterCostsMicros
          const netProfit = report.reconciledNetPnlAfterCostsMicros
          if (executionProfit === null || netProfit === null)
            throw new Error('Completed trade lacks reconciled economics')
          expect(BigInt(executionProfit)).toBeGreaterThan(0n)
          expect(netProfit).toBe((BigInt(executionProfit) - 1_000_000_000n).toString())
          if (alphaFixture === null) expect(BigInt(netProfit)).toBeLessThan(0n)
        }
        if (boundary === 'retained-responses' || !prepared.requiresInference) {
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          const inputPath = `${directory}/input.json`
          const receiptPath = `${directory}/source-receipt.json`
          const outputPath = `${directory}/command-output`
          const tapePath = `${directory}/execution-tape.json`
          const commandPath = trading ? `${directory}/backtest-command.js` : `${import.meta.dir}/../backtest-command.ts`
          const commandRuntime = trading ? Bun.which('node') : process.execPath
          if (commandRuntime === null) throw new Error('Compiled replay acceptance requires the pinned Node runtime')
          if (trading) {
            const activeBuild = {
              ...rootBuild,
              strategyBehaviorHash: activeStrategyBehaviorHash,
              strategyParameterHash: Result.getOrThrow(
                canonicalHashV1Result(Result.getOrThrow(loadActiveStrategyProtocol())),
              ),
            }
            yield* writeCompiledReplayCommand(commandPath, undefined, alphaFixture === null ? undefined : activeBuild)
          }
          const receipt = JSON.stringify(prepared.sourceReceipt.value)
          yield* fs.writeFileString(
            inputPath,
            JSON.stringify({ ...prepared.input, replicate: `${prepared.input.replicate}-cli` }),
          )
          yield* fs.writeFileString(receiptPath, receipt)
          if (tapeText !== undefined) yield* fs.writeFileString(tapePath, tapeText)
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const child = yield* spawner.spawn(
            ChildProcess.make(
              commandRuntime,
              [
                commandPath,
                '--input',
                inputPath,
                '--arrivals',
                path,
                '--source-receipt',
                receiptPath,
                '--source-receipt-sha256',
                sha256(receipt),
                '--output',
                outputPath,
                ...(tapeText === undefined ? [] : ['--equity-execution-tape', tapePath]),
              ],
              {
                env: {
                  BAYN_EGRESS_PROXY: '',
                  BAYN_JEV_API_KEY: '',
                  BAYN_BACKTEST_POSTGRES_URL: baynTestPostgresUrl,
                  BAYN_BACKTEST_TIGERBEETLE_ADDRESS: baynTestTigerBeetleAddress,
                  BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID: String(databases.tigerBeetle.clusterId),
                  BAYN_BACKTEST_TIGERBEETLE_LEDGER: String(databases.tigerBeetle.ledger),
                },
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'inherit',
              },
            ),
          )
          expect(Number(yield* child.exitCode)).toBe(0)
          const cliReport = yield* fs.readFileString(`${outputPath}/report.json`).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                  Schema.Struct({
                    schemaVersion: Schema.Literal(
                      alphaFixture === null
                        ? 'bayn.backtest-report.v9'
                        : preparedFixture === null
                          ? 'bayn.backtest-report.v10'
                          : 'bayn.backtest-report.v11',
                    ),
                    profitability: Schema.Literal('UNPROVEN'),
                    completion: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
                    build: BacktestBuildEvidenceSchema,
                    executableSha256: Schema.String,
                    reconciledExecutionPnlAfterCostsMicros: Schema.String,
                    reconciledNetPnlAfterCostsMicros: Schema.NullOr(Schema.String),
                    comparisonInput: Schema.Struct({
                      equityExecutionTape: Schema.optionalKey(EquityExecutionTapeReferenceSchema),
                    }),
                    brokerCheckpoint: ReplayBrokerCheckpointSchema,
                    alphaObservations: Schema.optionalKey(
                      Schema.Array(Schema.Union([ReplayAlphaObservationSchema, PreparedReplayAlphaObservationSchema])),
                    ),
                    inference: Schema.Struct({
                      providerDispatchCount: Schema.Number,
                      retainedCallCount: Schema.Number,
                    }),
                  }),
                ),
              ),
            ),
          )
          expect(cliReport.inference).toEqual({ providerDispatchCount: 0, retainedCallCount: 0 })
          expect(cliReport.build).toEqual({
            ...prepared.buildEvidence,
            sourceAndStrategyVerification: trading ? 'embedded' : 'configured',
          })
          expect(cliReport.comparisonInput.equityExecutionTape).toEqual(tapeReference)
          expect(cliReport.brokerCheckpoint.state.ledger.openingCashMicros).toBe('100000000000')
          if (preparedFixture !== null) {
            expect(cliReport.alphaObservations?.length).toBeGreaterThan(0)
            for (const observation of cliReport.alphaObservations ?? []) {
              const use = observation.baselineUse
              if (use.schemaVersion !== 'bayn.replay-alpha-baseline-use.v2')
                throw new Error('Compiled v13 report changed its prepared source contract')
              expect(use.sourcePreparationHash).toBe(preparedFixture.source.preparationHash)
              expect(use.sourceWitnessHash).toBe(preparedFixture.source.witnessSourceHash)
              expect(Date.parse(preparedFixture.source.availableAt)).toBeLessThanOrEqual(
                Date.parse(use.commandIssuedAt),
              )
              expect(Date.parse(use.commandIssuedAt)).toBeLessThanOrEqual(Date.parse(use.admissionObservedAt))
            }
            expect(cliReport.brokerCheckpoint.state.fills.length).toBeGreaterThanOrEqual(8)
            expect(new Set(cliReport.brokerCheckpoint.state.fills.map((fill) => fill.symbol))).toEqual(
              new Set(['COHR', 'LITE', 'MU', 'SNDK']),
            )
          }
          if (trading) {
            expect(cliReport.executableSha256).toBe(sha256(yield* fs.readFile(commandPath)))
            expect(cliReport.completion).toBe('COMPLETE')
            expect(cliReport.brokerCheckpoint.state.ledger.positions).toEqual([])
            expect(cliReport.brokerCheckpoint.state.fills.some((fill) => fill.side === BrokerOrderSide.Buy)).toBe(true)
            expect(cliReport.brokerCheckpoint.state.fills.some((fill) => fill.side === BrokerOrderSide.Sell)).toBe(true)
            if (tape !== undefined)
              expect(
                new Set(cliReport.brokerCheckpoint.state.ledger.fills.map((fill) => fill.quoteSource.topic)),
              ).toEqual(new Set(['bayn.research.alpaca-sip.quotes.v1']))
            expect(BigInt(cliReport.reconciledExecutionPnlAfterCostsMicros)).toBeGreaterThan(0n)
            expect(cliReport.reconciledNetPnlAfterCostsMicros).toBe(
              (BigInt(cliReport.reconciledExecutionPnlAfterCostsMicros) - 1_000_000_000n).toString(),
            )
            if (cliReport.reconciledNetPnlAfterCostsMicros === null) throw new Error('CLI lacks reconciled economics')
            if (alphaFixture === null) expect(BigInt(cliReport.reconciledNetPnlAfterCostsMicros)).toBeLessThan(0n)
          }
        }
      }).pipe(Effect.scoped, Effect.provide(stores), Effect.provide(NodeServices.layer)),
    )
  },
  120000,
)
