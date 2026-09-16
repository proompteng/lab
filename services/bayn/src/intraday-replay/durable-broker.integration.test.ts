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
import { Authority, IntentState, OrderSide, OrderType, TimeInForce, type Intent } from '../execution/contracts'
import { makeExecutionPersistence } from '../db/execution-store/postgres'
import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import type { RuntimeConfig } from '../config'
import { JournalLive } from '../ledger'
import { runReconciliation } from '../simulation-reconciliation/broker-reconciler-program'
import { canonicalHashV1Result } from '../hash'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { config as fixtureConfig } from '../testing/runtime-fixtures'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { currentUtcInstant } from '../time'
import { makeReplayBroker } from './broker'

const durableTest = baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined ? test.skip : test

durableTest(
  'production accounting survives client restart against PostgreSQL and real TigerBeetle',
  async () => {
    if (baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined)
      throw new Error('Both isolated database endpoints are required')
    const url = new URL(baynTestPostgresUrl)
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.endsWith('_test') ||
      !/^127\.0\.0\.1:\d+$/.test(baynTestTigerBeetleAddress)
    )
      throw new Error('Durable replay acceptance requires local PostgreSQL _test and local TigerBeetle')
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
    const entryMs = Date.parse('2026-09-04T14:31:00.000Z')
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-04T00:00:00.000Z'))
        const broker = yield* makeReplayBroker({
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
                '2026-09-04T00:00:00.000Z',
              ),
            ),
          ],
          quoteAt: (_symbol, nowMs) => {
            const price = nowMs >= entryMs + 200 ? 101 : 100
            const value = {
              ...quote,
              eventAt: new Date(nowMs).toISOString(),
              ingestedAt: new Date(nowMs).toISOString(),
              bidPrice: price,
              askPrice: price,
              bidSize: 100,
              askSize: 100,
            }
            return Effect.succeed({
              value,
              availableAtMs: nowMs,
              sequence: 1,
              recordHash: Result.getOrThrow(canonicalHashV1Result(value)),
            })
          },
        })
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
          schemaVersion: 'bayn.paper-intent.v3',
          intentId: (side === OrderSide.Buy ? '1' : '2').repeat(64),
          authorityGenerationHash,
          riskDecisionId: '3'.repeat(64),
          strategyName: 'intraday-momentum',
          cycleId: '4'.repeat(64),
          decisionHash: '5'.repeat(64),
          policyHash: '6'.repeat(64),
          accountId,
          clientOrderId: `replay-${side}`,
          symbol: 'AAPL',
          side,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityMicros: '3000000',
          notionalLimitMicros: '300000000',
          state: IntentState.IoStarted,
          createdAt: '2026-09-04T14:31:00.000Z',
        })
        for (const side of [OrderSide.Buy, OrderSide.Sell]) {
          const request = yield* broker.mutation.submit(order(side)).pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestClock.adjust(100)
          yield* Fiber.join(request)
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
    expect(result.rows[0]).toEqual({ fills: 2, transactions: 2 })
    expect(result.restarted.brokerState.account.cashMicros).toBe(result.broker.ledger.cashMicros)
    expect(result.restarted.brokerState.positions).toEqual([])
    // These externally supplied broker orders deliberately have no production intent bindings.
    expect(result.restarted.brokerState.unknownOrderCount).toBe(2)
  },
  60_000,
)
