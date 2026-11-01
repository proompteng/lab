import { replayRateCardFixture } from '../testing/inference-rate-card.test-support'
import { nativeReplayPolicyIdentity } from './native-policy'
import { loadActiveStrategyProtocol } from '../strategy'
import { chartProviderFixture } from '../jev/entry-inference.test-support'
import { makeReplayInferenceBudget } from './inference-timing'
import { replayTestInstruments } from '../testing/replay-instruments'
import { equityMarketProfile } from '../jev/markets'

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
  retainedReplayFixture,
  retainedReplayCaptureFixture,
  momentumTradeReplayFixture,
} from '../testing/retained-replay-fixture'
import { config } from '../testing/runtime-fixtures'
import { BacktestIssue, prepareBacktest, runBacktest, type BacktestPass } from './backtest'
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
import { withLatencyCliPhase } from './latency-cli-progress.test-support'

const durableTest = baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined ? test.skip : test

const writeCompiledReplayCommand = (path: string, entrypoint = `${import.meta.dir}/../backtest-command.ts`) =>
  Effect.gen(function* () {
    const compiled = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: [entrypoint],
        target: 'node',
        external: ['tigerbeetle-node', '@platformatic/kafka'],
        define: {
          __BAYN_BUILD_SOURCE_REVISION__: JSON.stringify(config.build.sourceRevision),
          __BAYN_BUILD_IMAGE_REPOSITORY__: JSON.stringify(config.build.imageRepository),
          __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__: JSON.stringify(config.build.strategyBehaviorHash),
          __BAYN_BUILD_STRATEGY_PARAMETER_HASH__: JSON.stringify(config.build.strategyParameterHash),
        },
      }),
    )
    expect(compiled.success).toBe(true)
    const output = compiled.outputs[0]
    if (output === undefined || compiled.outputs.length !== 1) throw new Error('Missing compiled replay executable')
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFile(path, new Uint8Array(yield* Effect.promise(() => output.arrayBuffer())))
  })

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
            jev: { evaluate: () => Effect.die('Closing-cut regression does not infer') },
            chart: chartProviderFixture,
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
] as const)(
  'native backtest retains %s polling through measured bootstrap and cleanup latency',
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
    const trading = boundary === 'momentum-trading'
    const retained = trading ? momentumTradeReplayFixture() : retainedReplayFixture()
    const openMs = Date.parse(
      trading
        ? retained.input.query.observedAt
        : boundary !== 'UTC-midnight'
          ? '2026-09-04T13:30:00Z'
          : '2026-09-04T23:59:30Z',
    )
    const closeMs = openMs + (trading ? 40_000 : 60_000)
    const source = {
      ...retained.manifest,
      coverageStartMs: Math.min(openMs, retained.manifest.coverageStartMs),
      coverageEndMs: Math.max(closeMs, retained.manifest.coverageEndMs),
    }
    const { verification: _verification, ...rootBuild } = config.build
    const policy = boundary.startsWith('momentum-') ? JevResearchPolicy.Momentum : JevResearchPolicy.Candidate
    const identity = Result.getOrThrow(
      nativeReplayPolicyIdentity(policy, Result.getOrThrow(loadActiveStrategyProtocol())),
    )
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
          schemaVersion: 'bayn.backtest.v10',
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
            models: { jev: jevModel, chart: 'gpt-6-luna' },
            inputDefinition: 'bayn.jev-entry-state.v23',
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
          interval: { startAt: new Date(openMs).toISOString(), endAt: new Date(closeMs).toISOString() },
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
          assets: equityMarketProfile.universe.map((symbol, index) => ({
            id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
            symbol,
            class: 'us_equity',
            exchange: 'NASDAQ',
            status: 'active',
            tradable: true,
            fractionable: true,
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
          boundary === 'retained-responses' || policy === JevResearchPolicy.Momentum
            ? null
            : {
                chart: chartProviderFixture,
                jev: { evaluate: () => Effect.die('A quiet opening fixture must not infer') },
              },
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
        expect(Date.parse(passes[0]?.observedAt ?? '')).toBeGreaterThanOrEqual(openMs)
        expect(Date.parse(passes.at(-1)?.observedAt ?? '')).toBeGreaterThanOrEqual(closeMs)
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
          expect(report.momentumObservations.length).toBeGreaterThan(0)
          const executionProfit = report.reconciledExecutionPnlAfterCostsMicros
          const netProfit = report.reconciledNetPnlAfterCostsMicros
          if (executionProfit === null || netProfit === null)
            throw new Error('Completed trade lacks reconciled economics')
          expect(BigInt(executionProfit)).toBeGreaterThan(0n)
          expect(netProfit).toBe((BigInt(executionProfit) - 1_000_000_000n).toString())
          expect(BigInt(netProfit)).toBeLessThan(0n)
        }
        if (boundary === 'retained-responses' || policy === JevResearchPolicy.Momentum) {
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          const inputPath = `${directory}/input.json`
          const receiptPath = `${directory}/source-receipt.json`
          const outputPath = `${directory}/command-output`
          const commandPath = trading ? `${directory}/backtest-command.js` : `${import.meta.dir}/../backtest-command.ts`
          const commandRuntime = trading ? Bun.which('node') : process.execPath
          if (commandRuntime === null) throw new Error('Compiled replay acceptance requires the pinned Node runtime')
          if (trading) yield* writeCompiledReplayCommand(commandPath)
          const receipt = JSON.stringify(prepared.sourceReceipt.value)
          yield* fs.writeFileString(
            inputPath,
            JSON.stringify({ ...prepared.input, replicate: `${prepared.input.replicate}-cli` }),
          )
          yield* fs.writeFileString(receiptPath, receipt)
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
              ],
              {
                env: {
                  BAYN_PUBLIC_INFORMATION_PROXY: '',
                  BAYN_OPENAI_API_KEY: '',
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
                    schemaVersion: Schema.Literal('bayn.backtest-report.v9'),
                    profitability: Schema.Literal('UNPROVEN'),
                    completion: Schema.Literals(['COMPLETE', 'INCOMPLETE']),
                    executableSha256: Schema.String,
                    reconciledExecutionPnlAfterCostsMicros: Schema.String,
                    reconciledNetPnlAfterCostsMicros: Schema.NullOr(Schema.String),
                    brokerCheckpoint: ReplayBrokerCheckpointSchema,
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
          expect(cliReport.brokerCheckpoint.state.ledger.openingCashMicros).toBe('100000000000')
          if (trading) {
            expect(cliReport.executableSha256).toBe(sha256(yield* fs.readFile(commandPath)))
            expect(cliReport.completion).toBe('COMPLETE')
            expect(cliReport.brokerCheckpoint.state.ledger.positions).toEqual([])
            expect(cliReport.brokerCheckpoint.state.fills.some((fill) => fill.side === BrokerOrderSide.Buy)).toBe(true)
            expect(cliReport.brokerCheckpoint.state.fills.some((fill) => fill.side === BrokerOrderSide.Sell)).toBe(true)
            expect(BigInt(cliReport.reconciledExecutionPnlAfterCostsMicros)).toBeGreaterThan(0n)
            expect(cliReport.reconciledNetPnlAfterCostsMicros).toBe(
              (BigInt(cliReport.reconciledExecutionPnlAfterCostsMicros) - 1_000_000_000n).toString(),
            )
            if (cliReport.reconciledNetPnlAfterCostsMicros === null) throw new Error('CLI lacks reconciled economics')
            expect(BigInt(cliReport.reconciledNetPnlAfterCostsMicros)).toBeLessThan(0n)
          }
        }
      }).pipe(Effect.scoped, Effect.provide(stores), Effect.provide(NodeServices.layer)),
    )
  },
  120000,
)

durableTest.each([
  { policy: JevResearchPolicy.Candidate, trading: false },
  { policy: JevResearchPolicy.Ablation, trading: false },
  { policy: JevResearchPolicy.Momentum, trading: false },
  { policy: JevResearchPolicy.Momentum, trading: true },
])(
  'native $policy latency CLI retains twenty sessions with trading=$trading',
  async ({ policy, trading }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: `${import.meta.dir}/../../node_modules`,
          prefix: '.latency-cli-test-',
        })
        const executablePath = `${directory}/backtest-command.js`
        const workerPath = `${directory}/latency-cli.js`
        yield* Effect.gen(function* () {
          yield* writeCompiledReplayCommand(executablePath, `${import.meta.dir}/replay-phase-command.test-support.ts`)
          yield* writeCompiledReplayCommand(workerPath, `${import.meta.dir}/latency-cli.test-support.ts`)
        }).pipe(withLatencyCliPhase('compile'))
        const node = Bun.which('node')
        if (node === null) throw new Error('Compiled replay acceptance requires the pinned Node runtime')
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const child = yield* spawner.spawn(
          ChildProcess.make(node, [workerPath, policy, trading ? 'trading' : 'missing', directory, executablePath], {
            stdin: 'ignore',
            stdout: 'inherit',
            stderr: 'inherit',
          }),
        )
        yield* child.exitCode.pipe(
          Effect.tap((code) => Effect.sync(() => expect(Number(code)).toBe(0))),
          withLatencyCliPhase('worker'),
        )
        const result = yield* fs.readFileString(`${directory}/acceptance.json`).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  policy: Schema.String,
                  trading: Schema.Boolean,
                  sessionCount: Schema.Number,
                  filledSessions: Schema.Number,
                  executionProfitMicros: Schema.String,
                  qualificationProfitMicros: Schema.String,
                  complete: Schema.Boolean,
                  providerDispatchCount: Schema.Number,
                  receiptEconomicsComplete: Schema.Boolean,
                  executableHash: Schema.String,
                }),
              ),
            ),
          ),
        )
        expect(result).toMatchObject({
          policy,
          trading,
          sessionCount: 20,
          filledSessions: trading ? 20 : 0,
          complete: true,
          providerDispatchCount: 0,
          receiptEconomicsComplete: false,
          executableHash: sha256(yield* fs.readFile(executablePath)),
        })
        expect(BigInt(result.qualificationProfitMicros)).toBe(BigInt(result.executionProfitMicros) - 20_000_000n)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    )
  },
  600000,
)
