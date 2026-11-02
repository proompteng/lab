import { cashSpotLimitTimeInForce } from '../execution/order-terms'
import { instrumentMarket } from '../instruments'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Fiber, Layer, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { AssetClass, AssetExchange, AssetStatus } from '../broker/alpaca/model'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import { Authority, IntentState, OrderSide, OrderType, type Intent } from '../execution/contracts'
import { makeExecutionPersistence } from '../db/execution-store/postgres'
import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import type { RuntimeConfig } from '../config/model'
import { JournalLive } from '../ledger'
import { runReconciliation } from '../simulation-reconciliation/broker-reconciler-program'
import { canonicalHashV1Result } from '../hash'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { config as fixtureConfig } from '../testing/runtime-fixtures'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { currentUtcInstant } from '../time'
import { makeReplayBroker, type ReplayBrokerConfig } from './broker'
import { prepareAccounting } from '../accounting/domain'
import { prepareCashSettlement } from '../accounting/cash-settlement'
import { readForwardPerformanceLedger } from '../forward-performance/tigerbeetle'
import { Journal } from '../ledger'

const durableTest = baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined ? test.skip : test

durableTest.each(['100004900', '100005100'])(
  'native cash settlement %s posts exactly once in real TigerBeetle across client restart',
  async (priceMicros) => {
    if (baynTestTigerBeetleAddress === undefined || !/^127\.0\.0\.1:\d+$/.test(baynTestTigerBeetleAddress))
      throw new Error('Cash settlement acceptance requires an isolated loopback TigerBeetle')
    const runId = Result.getOrThrow(canonicalHashV1Result({ cashSettlementAttempt: randomUUID() }))
    const accountId = `cash-settlement-${runId}`
    const config = {
      operationTimeoutMs: 10_000,
      tigerBeetle: { clusterId: 20912n, replicaAddresses: [baynTestTigerBeetleAddress], ledger: 70912 },
    }
    const fill = Result.getOrThrow(
      prepareAccounting(
        runId,
        {
          schemaVersion: 'bayn.fill.v2',
          accountId,
          fillId: runId,
          brokerOrderId: runId,
          clientOrderId: runId,
          symbol: 'BTC/USD',
          side: OrderSide.Buy,
          quantityAtoms: '1000000000',
          priceAtoms: (BigInt(priceMicros) * 1000n).toString(),
          feeMicros: '0',
          occurredAt: '2026-10-16T00:00:00.000Z',
        },
        { quantityAtoms: '0', costMicros: '0' },
        config.tigerBeetle.ledger,
      ),
    )
    const settlement = Result.getOrThrow(
      prepareCashSettlement(
        {
          schemaVersion: 'bayn.broker-cash-settlement.v1',
          accountId,
          transactionId: fill.transaction.transactionId,
          transactionContentHash: fill.transaction.contentHash,
          brokerEventId: fill.transaction.brokerEventId,
          cashDeltaMicros: fill.transaction.cashDeltaMicros,
          occurredAt: fill.transaction.occurredAt,
          cashReportingQuantumMicros: '10000',
          precisionAccountEventId: runId,
          observedAt: '2026-10-16T00:01:00.000Z',
        },
        config.tigerBeetle.ledger,
      ),
    )
    const plans = [fill.ledger, settlement.plan]
    const post = Effect.gen(function* () {
      const journal = yield* Journal
      for (const plan of plans) yield* journal.post(plan)
      return yield* journal.verifyAccount(accountId, plans)
    }).pipe(Effect.provide(JournalLive(config)))
    expect(await Effect.runPromise(post)).toBe(true)
    expect(await Effect.runPromise(post)).toBe(true)
    const read = await Effect.runPromise(Effect.scoped(readForwardPerformanceLedger(config, accountId, plans)))
    expect(read.ledgerExact).toBe(true)
    expect(read.totals.cashSettlementRoundingMicros).toBe(settlement.roundingDeltaMicros)
    expect(read.totals.cashYieldMicros).toBe('0')
    expect(read.totals.realizedGainMicros).toBe('0')
    expect(read.totals.brokerExecutionFeesMicros).toBe('0')
    expect(BigInt(fill.transaction.cashDeltaMicros) + BigInt(settlement.roundingDeltaMicros)).toBe(
      -100000000n - (priceMicros === '100005100' ? 10000n : 0n),
    )
  },
  30_000,
)

durableTest.each(['day', 'day-partial', 'fractional', 'BTC/USD', 'ETH/USD', 'SOL/USD'] as const)(
  'production %s accounting survives client restart against PostgreSQL and real TigerBeetle',
  async (scenario) => {
    if (baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined)
      throw new Error('Both isolated database endpoints are required')
    const url = new URL(baynTestPostgresUrl)
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.endsWith('_test') ||
      !/^127\.0\.0\.1:\d+$/.test(baynTestTigerBeetleAddress)
    )
      throw new Error('Durable replay acceptance requires local PostgreSQL _test and local TigerBeetle')
    const continuous = scenario.includes('/')
    const symbol = continuous ? scenario : 'AAPL'
    const runId = Result.getOrThrow(canonicalHashV1Result({ acceptanceAttempt: randomUUID() }))
    const accountId = `replay-${runId}`
    const authorityGenerationHash = 'e'.repeat(64)
    const brokerIdentity = Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId,
      }),
    )
    const config: RuntimeConfig = {
      ...fixtureConfig,
      operationTimeoutMs: 10_000,
      execution: { brokerIdentity, brokerAccess: BrokerAccess.ReadOnly, capitalAuthority: noCapitalAuthority },
      postgres: { url: Redacted.make(baynTestPostgresUrl), tls: false, caPath: '/unused' },
      tigerBeetle: { clusterId: 20912n, replicaAddresses: [baynTestTigerBeetleAddress], ledger: 70912 },
    }
    const stores = () =>
      Layer.mergeAll(WriterFenceLive, JournalLive(config)).pipe(
        Layer.provideMerge(PostgresClientLive(config)),
        Layer.provide(NodeServices.layer),
      )
    const replayClock = (sql: PgClient.PgClient) => ({
      now: sql`(SELECT observed_at FROM replay_acceptance_clock WHERE singleton)`,
    })
    const { protocol, snapshot } = streamingFixture()
    const quote = snapshot.quotes.find((value) => value.symbol === 'AAPL')
    if (quote === undefined) throw new Error('Missing AAPL fixture')
    const entryMs = Date.parse(continuous ? '2026-10-11T23:59:59.950Z' : '2026-09-04T14:31:00.000Z')
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-04T00:00:00.000Z'))
        const brokerConfig = {
          runId,
          sourceManifestHash: 'f'.repeat(64),
          openingCashMicros: '10000000000',
          protocol,
          assumptions: {
            latencyMs: 100,
            slippageBps: 0,
            availableLiquidityPpm: 1_000_000,
            feeMultiplierPpm: 1_000_000,
          },
          fractionalTrading: scenario === 'fractional' || continuous,
          calendar: continuous
            ? []
            : [{ session_open: '0930', session_close: '1600', date: '2026-09-04', open: '09:30', close: '16:00' }],
          assets: [
            Result.getOrThrow(
              normalizeAssetResult(
                {
                  id: '12345678-1234-4234-8234-123456789abc',
                  symbol,
                  class: continuous ? AssetClass.Crypto : AssetClass.UsEquity,
                  exchange: continuous ? AssetExchange.Crypto : AssetExchange.Nasdaq,
                  status: AssetStatus.Active,
                  tradable: true,
                  fractionable: true,
                  ...(continuous
                    ? { min_order_size: '0.00001', min_trade_increment: '0.000000001', price_increment: '0.000000001' }
                    : {}),
                },
                symbol,
                '2026-09-04T00:00:00.000Z',
              ),
            ),
          ],
          quoteAt: (_symbol: string, nowMs: number) => {
            const price = nowMs >= entryMs + 200 ? 101 : 100
            const value = {
              ...quote,
              symbol,
              ...(continuous
                ? { feed: 'us' as const, delayClass: 'real_time_crypto' as const, marketSession: 'continuous' as const }
                : {}),
              eventAt: new Date(nowMs).toISOString(),
              ingestedAt: new Date(nowMs).toISOString(),
              bidPrice: price,
              askPrice: price,
              bidSize: 100,
              askSize: scenario === 'day-partial' && nowMs < entryMs + 150 ? 1 : 100,
            }
            return Effect.succeed({
              value,
              availableAtMs: nowMs,
              sequence: 1,
              recordHash: Result.getOrThrow(canonicalHashV1Result(value)),
            })
          },
        } satisfies ReplayBrokerConfig
        let broker = yield* makeReplayBroker(brokerConfig)
        const reconcile = Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const observedAt = yield* currentUtcInstant
          yield* sql`UPDATE replay_acceptance_clock SET observed_at = ${observedAt}::timestamptz WHERE singleton`
          const store = yield* makeExecutionPersistence(config, replayClock(sql))
          const fence = yield* WriterFence
          return yield* runReconciliation({ read: broker.read, store, fence, now: currentUtcInstant })
        })
        yield* Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* postgresMigrations
          yield* sql`CREATE TABLE replay_acceptance_clock (
            singleton boolean PRIMARY KEY CHECK (singleton), observed_at timestamptz NOT NULL)`
          const observedAt = yield* currentUtcInstant
          yield* sql`INSERT INTO replay_acceptance_clock VALUES (true, ${observedAt}::timestamptz)`
          const store = yield* makeExecutionPersistence(config, replayClock(sql))
          const authority = yield* store.authorityGeneration.ensureAuthorityGeneration({
            generationHash: authorityGenerationHash,
            maximum: Authority.Observe,
          })
          expect(authority.updatedAt).toBe(observedAt)
          const baseline = yield* reconcile
          expect(baseline.report.metrics.accountingExact).toBe(true)
        }).pipe(Effect.provide(stores()), Effect.provide(NodeServices.layer))
        yield* TestClock.setTime(entryMs)
        const order = (side: OrderSide): Intent => ({
          schemaVersion: 'bayn.execution-intent.v5',
          intentId: (side === OrderSide.Buy ? '1' : '2').repeat(64),
          authorityGenerationHash,
          riskDecisionId: '3'.repeat(64),
          strategyName: 'intraday-momentum',
          cycleId: '4'.repeat(64),
          decisionHash: '5'.repeat(64),
          policyHash: '6'.repeat(64),
          accountId,
          clientOrderId: `replay-${side}`,
          symbol,
          side,
          orderType: OrderType.Limit,
          timeInForce: cashSpotLimitTimeInForce(instrumentMarket(symbol)),
          quantityAtoms: '3000000000',
          notionalLimitMicros: '300000000',
          limitPriceMicros: '100000000',
          state: IntentState.IoStarted,
          createdAt: new Date(entryMs).toISOString(),
        })
        const orders = continuous
          ? [
              order(OrderSide.Buy),
              {
                ...order(OrderSide.Sell),
                quantityAtoms: '2992500000',
                notionalLimitMicros: '299250000',
              },
            ]
          : scenario === 'day' || scenario === 'day-partial'
            ? [order(OrderSide.Buy), order(OrderSide.Sell)]
            : [
                order(OrderSide.Buy),
                ...['500000000', '2500000000'].map((quantityAtoms, index) => ({
                  ...order(OrderSide.Sell),
                  clientOrderId: `fractional-${index}`,
                  quantityAtoms,
                  notionalLimitMicros: ((BigInt(quantityAtoms) * 100000000n) / 1000000000n).toString(),
                })),
              ]
        for (const requestIntent of orders) {
          const request = yield* broker.mutation
            .submit(requestIntent)
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestClock.adjust(100)
          yield* Fiber.join(request)
          if (scenario === 'day-partial' && requestIntent.side === OrderSide.Buy) {
            yield* TestClock.adjust(1)
            const partial = yield* reconcile.pipe(Effect.provide(stores()))
            expect(partial.report.metrics.accountingExact).toBe(true)
            expect(partial.brokerState.positions[0]?.quantityAtoms).toBe('1000000000')
            const checkpoint = yield* broker.checkpoint
            broker = yield* makeReplayBroker({
              ...brokerConfig,
              restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
            })
            yield* TestClock.setTime(entryMs + 150)
            const nextQuote = yield* brokerConfig.quoteAt(symbol, entryMs + 150)
            yield* broker.observeMarket(entryMs + 150, nextQuote)
            yield* TestClock.adjust(1)
            const completed = yield* reconcile.pipe(Effect.provide(stores()))
            expect(completed.report.metrics.accountingExact).toBe(true)
            expect(completed.brokerState.positions[0]?.quantityAtoms).toBe('3000000000')
          }
        }
        yield* TestClock.adjust(1)
        const first = yield* reconcile.pipe(Effect.provide(stores()))
        yield* TestClock.adjust(1)
        const restarted = yield* reconcile.pipe(Effect.provide(stores()))
        const rows = yield* Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql<{ fills: number; transactions: number }>`SELECT
        (SELECT count(*)::int FROM fills WHERE account_id = ${accountId}) AS fills,
        (SELECT count(*)::int FROM accounting_transactions WHERE account_id = ${accountId}) AS transactions`
        }).pipe(Effect.provide(stores()))
        return { first, restarted, rows, broker: yield* broker.snapshot, observedAtMs: yield* Clock.currentTimeMillis }
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
    expect(result.first.report.metrics.accountingExact).toBe(true)
    expect(result.restarted.report.metrics.accountingExact).toBe(true)
    expect(result.rows[0]).toEqual({
      fills: scenario === 'fractional' || scenario === 'day-partial' ? 3 : 2,
      transactions: scenario === 'fractional' || scenario === 'day-partial' ? 3 : 2,
    })
    expect(result.restarted.brokerState.account.cashMicros).toBe(result.broker.ledger.cashMicros)
    expect(result.restarted.brokerState.positions).toEqual([])
    if (continuous) {
      expect(result.broker.fees).toHaveLength(2)
      expect(result.broker.fees[0]?.coinDebit?.quantityAtoms).toBe('7500000')
      expect(result.broker.fees[1]?.netAmountMicros).toBe('-760000')
      expect(result.broker.ledger.executionFeesMicros).toBe('1510000')
      expect(result.broker.fills.map((fill) => fill.transactionTime.slice(0, 10))).toEqual(['2026-10-12', '2026-10-12'])
    }
    // These externally supplied broker orders deliberately have no production intent bindings.
    expect(result.restarted.brokerState.unknownOrderCount).toBe(scenario === 'fractional' ? 3 : 2)
  },
  60_000,
)
