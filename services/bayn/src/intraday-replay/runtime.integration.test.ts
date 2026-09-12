import { makeSimulatedExecutionClock } from './clock'
import type { RuntimeConfig } from '../config'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer, Redacted, Ref, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { OperationDeadlineClock } from '../operation-timeout'

import { AssetClass, AssetExchange, AssetStatus, MarketCalendarResponseSchema } from '../broker/alpaca/model'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import { WriterFenceLive } from '../execution/writer-fence'
import { IntentStoreLive, BlockedCycleIntentStoreLive } from '../execution/intents'
import { MutationStoreLive } from '../execution/mutations'
import { ExecutionCycleClosureStoreLive } from '../db/execution-cycle-closure-postgres'
import { PersistedCapitalGrantStoreLive } from '../db/persisted-capital-grant'
import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { JournalLive } from '../ledger'
import { canonicalHashV1 } from '../hash'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { config as baseConfig, fixtureRuntime } from '../testing/runtime-fixtures'
import { simulationFixture } from '../testing/simulated-streaming-fixture'
import { utcInstantFromEpochMillis } from '../time'
import { makeReplayBroker, ReplayBrokerFailure } from './broker'
import { makeReplayExecutionRuntime } from './runtime'

const durableTest = baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined ? test.skip : test

durableTest(
  'production cycle creates and fills a risk-approved intent against isolated durable stores',
  async () => {
    if (baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined)
      throw new Error('Missing replay test databases')
    const url = new URL(baynTestPostgresUrl)
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.endsWith('_test') ||
      !/^127\.0\.0\.1:\d+$/.test(baynTestTigerBeetleAddress)
    )
      throw new Error('Replay acceptance requires isolated local test databases')
    const fixture = simulationFixture()
    const runId = canonicalHashV1({ attempt: randomUUID() })
    const accountId = `replay-${runId}`
    const config: RuntimeConfig = {
      ...baseConfig,
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
      IntentStoreLive,
      BlockedCycleIntentStoreLive,
      MutationStoreLive,
      ExecutionCycleClosureStoreLive,
      PersistedCapitalGrantStoreLive,
    ).pipe(Layer.provideMerge(base))
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const initialMs = Date.parse(fixture.query.observedAt)
        yield* TestClock.setTime(initialMs)
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
        const clock = yield* makeSimulatedExecutionClock(runId, fixture.source.sourceManifestHash)
        const wrongAccount = yield* Effect.exit(
          sql`INSERT INTO simulated_execution_clocks VALUES ('paper-account-1', ${fixture.source.sourceManifestHash}, clock_timestamp())`,
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
        const cursor = {
          ...fixture.cursor,
          source: { ...fixture.source, runId },
          runId,
          projection: { ...fixture.cursor.projection, epoch: `historical-${runId}` },
        }
        const broker = yield* makeReplayBroker({
          runId,
          openingCashMicros: '100000000000',
          protocol: fixture.protocol,
          assumptions: { latencyMs: 10, slippageBps: 0, availableLiquidityPpm: 1000000, feeMultiplierPpm: 1000000 },
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
            clock.advanceTo(utcInstantFromEpochMillis(atMs)).pipe(
              Effect.andThen(TestClock.setTime(atMs)),
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
          strategy: fixtureRuntime,
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
          source: { ...fixture.source, runId },
          cursor: Effect.succeed(cursor),
          clock,
          recordPass: (pass: Parameters<import('../app').RecordAutonomousCyclePass>[0]) =>
            Ref.update(passes, (values) => [...values, pass]),
          pollIntervalMs: 1000,
          reconciliationIntervalMs: 1000,
          reconciliationPassTimeoutMs: 1000,
        }
        const runtime = yield* makeReplayExecutionRuntime(runtimeInput)
        yield* clock.advanceTo(utcInstantFromEpochMillis(initialMs + 1))
        yield* TestClock.setTime(initialMs + 1)
        for (let pass = 0; pass < 20; pass++) {
          const advanced = yield* runtime.advance
          if (advanced.observation.result === 'FAILURE' || (yield* broker.snapshot).fills.length > 0) break
          const nextMs = (yield* Clock.currentTimeMillis) + 1000
          yield* clock.advanceTo(utcInstantFromEpochMillis(nextMs))
          yield* TestClock.setTime(nextMs)
        }
        const settledMs = (yield* Clock.currentTimeMillis) + 1
        yield* clock.advanceTo(utcInstantFromEpochMillis(settledMs))
        yield* TestClock.setTime(settledMs)
        const brokerState = yield* broker.snapshot
        const reconciliation = yield* runtime.reconcile
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
        const rows = yield* sql<Record<string, unknown>>`SELECT
      (SELECT count(*)::int FROM intents WHERE account_id = ${accountId}) AS intents,
      (SELECT count(*)::int FROM fills WHERE account_id = ${accountId}) AS fills,
      (SELECT count(*)::int FROM accounting_transactions WHERE account_id = ${accountId}) AS transactions`
        return { brokerState, reconciliation, rows, passes: yield* Ref.get(passes) }
      }).pipe(
        Effect.scoped,
        Effect.provide(stores),
        Effect.provide(TestClock.layer()),
        Effect.provide(NodeServices.layer),
      ),
    )
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
