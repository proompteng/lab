import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, FileSystem, Layer, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { PostgresClientLive } from '../db/postgres-client'
import { ExecutionCycleClosureStoreLive } from '../db/execution-cycle-closure-postgres'
import { PersistedCapitalGrantStoreLive } from '../db/persisted-capital-grant'
import { IntentStoreLive, BlockedCycleIntentStoreLive } from '../execution/intents'
import { MutationStoreLive } from '../execution/mutations'
import { WriterFenceLive } from '../execution/writer-fence'
import { JournalLive } from '../ledger'
import { JevClient } from '../jev/client'
import { jevModel } from '../jev/contract'
import { OperationDeadlineClock } from '../operation-timeout'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { retainedReplayFixture, retainedReplayCaptureFixture } from '../testing/retained-replay-fixture'
import { config } from '../testing/runtime-fixtures'
import { prepareBacktest, runBacktest, type BacktestPass } from './backtest'
import { postgresMigrations } from '../db/postgres-migrations'
import { canonicalHashV1OrThrow } from '../hash'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { AssetClass, AssetExchange, AssetStatus } from '../broker/alpaca/model'
import { IntentState, OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { streamingFixture } from '../testing/streaming-market-fixture'
import {
  emptyStreamingProjection,
  incorporateRecordedMarketValue,
  observedQuoteAt,
} from '../market-data/streaming/projection'
import { makeReplayBroker, ReplayBrokerFailure } from './broker'
import { makeSimulatedExecutionClock } from './clock'
import { makeReplayJevTiming } from './jev-timing'
import { makeReplayTimeline } from './session'

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
    const runId = canonicalHashV1OrThrow({ test: 'measured-closing-cut', run: randomUUID() })
    const sourceHash = canonicalHashV1OrThrow({ runId })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* postgresMigrations
        const sql = yield* PgClient.PgClient
        const providerClock = yield* TestClock.withLive(Clock.clockWith(Effect.succeed))
        yield* TestClock.setTime(startMs)
        const clock = yield* makeSimulatedExecutionClock(runId, sourceHash)
        const universe = {
          universeId: protocol.universeId,
          universeSymbolHash: protocol.universeSymbolHash,
          symbols: protocol.universe,
          topics: { ...protocol.sourceTopics, features: 'torghut.market-features.v1' },
        }
        const quotes = [
          [startMs, 100],
          [closeMs - 50, 99],
          [closeMs + 50, 98],
        ] as const
        let projection = emptyStreamingProjection('measured-closing-cut')
        let consumed = 0
        let sourceCut = startMs
        const advanceTo = yield* makeReplayTimeline(
          {
            advanceTo: (atMs) =>
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
          calendar: [{ date: '2026-09-04', open: '09:30', close: '16:00' }],
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
          quoteAt: (symbol, atMs) => Effect.sync(() => observedQuoteAt(projection, symbol, atMs)),
        })
        yield* broker.mutation.submit({
          schemaVersion: 'bayn.paper-intent.v3',
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
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityMicros: '10000000',
          notionalLimitMicros: '1000000000',
          state: IntentState.IoStarted,
          createdAt: new Date(startMs).toISOString(),
        })
        yield* advanceTo(closeMs - 200)
        const timing = yield* makeReplayJevTiming({
          provider: { evaluate: () => Effect.die('Closing-cut regression does not infer') },
          providerClock,
          advanceTo,
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
        const close = yield* broker.completeSession('2026-09-04')
        const state = yield* broker.snapshot
        const current = (yield* broker.read.account).value
        expect(now).toBeGreaterThan(closeMs + 50)
        expect(close.equityMicros).toBe((BigInt(state.ledger.cashMicros) + 990000000n).toString())
        expect(sourceCut).toBe(now)
        expect(consumed).toBe(3)
        expect(current.equityMicros).toBe((BigInt(state.ledger.cashMicros) + 980000000n).toString())
        expect(state.ledger.positions[0]?.quantityMicros).toBe('10000000')
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

durableTest(
  'native backtest retains the opening boundary after measured bootstrap latency',
  async () => {
    if (baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined)
      throw new Error('Missing isolated replay databases')
    const url = new URL(baynTestPostgresUrl)
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.endsWith('_test') ||
      !/^127\.0\.0\.1:\d+$/.test(baynTestTigerBeetleAddress)
    )
      throw new Error('Backtest acceptance requires isolated local test databases')
    const retained = retainedReplayFixture()
    const openMs = Date.parse('2026-09-04T13:30:00Z')
    const closeMs = openMs + 60_000
    const source = { ...retained.manifest, coverageStartMs: openMs, coverageEndMs: Date.parse('2026-09-04T20:00:00Z') }
    const { verification: _verification, ...build } = config.build
    const prepared = Result.getOrThrow(
      prepareBacktest(
        {
          schemaVersion: 'bayn.backtest.v3',
          replicate: `measured-bootstrap-${randomUUID()}`,
          inference: {
            mode: 'measured-provider',
            model: jevModel,
            inputDefinition: 'bayn.jev-trading-signal-state.v2',
            costs: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
          },
          allocatedDataCostPerSessionMicros: '0',
          sessionDates: ['2026-09-04'],
          source,
          openingCashMicros: '100000000000',
          fractionalTrading: false,
          calendar: [
            { date: '2026-09-04', open: '09:30', close: '09:31' },
            { date: '2026-09-08', open: '09:30', close: '16:00' },
          ],
          assets: retained.input.protocol.universe.map((symbol, index) => ({
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
          assumptions: { latencyMs: 100, slippageBps: 0, availableLiquidityPpm: 1000000, feeMultiplierPpm: 1000000 },
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
        const directory = yield* fs.makeTempDirectoryScoped()
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
        ).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(OperationDeadlineClock, {
            sleep: providerClock.sleep.bind(providerClock),
            currentTimeMillisUnsafe: providerClock.currentTimeMillisUnsafe.bind(providerClock),
            currentTimeNanosUnsafe: providerClock.currentTimeNanosUnsafe.bind(providerClock),
            currentTimeNanos: providerClock.currentTimeNanos,
            currentTimeMillis: providerClock.currentTimeMillis.pipe(
              Effect.tap(() => Effect.sleep('25 millis').pipe(Effect.provideService(Clock.Clock, providerClock))),
            ),
          }),
          Effect.provideService(JevClient, { evaluate: () => Effect.die('A quiet opening fixture must not infer') }),
        )
        expect(Date.parse(passes[0]?.observedAt ?? '')).toBeGreaterThanOrEqual(openMs)
        expect(Date.parse(passes.at(-1)?.observedAt ?? '')).toBeGreaterThanOrEqual(closeMs)
        expect(report.initialization.startedAt).toBe(new Date(openMs - 60_000).toISOString())
        expect(Date.parse(report.initialization.completedAt)).toBeLessThan(openMs)
        expect(report.initialization.elapsedMs).toBeGreaterThanOrEqual(25)
        expect(report.brokerState.ledger.openingCashMicros).toBe('100000000000')
        expect(report.brokerState.ledger.positions).toEqual([])
        expect(report.sessions[0]?.schedule.firstPollAtMs).toBe(openMs)
        expect(report.sessions[0]?.schedule.lastPollAtMs).toBe(closeMs)
        expect(report.processedRecords).toBe(source.recordCount)
        expect(report.inference.calls).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(stores), Effect.provide(NodeServices.layer)),
    )
  },
  30000,
)
