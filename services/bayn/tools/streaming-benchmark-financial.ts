import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Exit, Layer, Redacted, Result, Schema, Tracer } from 'effect'
import { TestClock } from 'effect/testing'
import { writeFile } from 'node:fs/promises'

import { AssetClass, AssetExchange, AssetStatus, MarketCalendarResponseSchema } from '../src/broker/alpaca/model'
import { normalizeAssetResult } from '../src/broker/alpaca/normalizers'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../src/broker/identity'
import type { RuntimeConfig } from '../src/config/model'
import { BlockedCycleIntentStoreLive } from '../src/execution/intents/blocked-cycle-postgres'
import { IntentStoreLive } from '../src/execution/intents/postgres'
import { MutationStoreLive } from '../src/execution/mutations/program'
import { WriterFenceLive } from '../src/execution/writer-fence'
import { BrokerAccess, noCapitalAuthority } from '../src/execution/authority'
import { ExecutionCycleClosureStoreLive } from '../src/db/execution-cycle-closure-postgres'
import { PersistedCapitalGrantStoreLive } from '../src/db/persisted-capital-grant'
import { PostgresClientLive } from '../src/db/postgres-client'
import { postgresMigrations } from '../src/db/postgres-migrations'
import { canonicalHashV1Result, sha256 } from '../src/hash'
import { makeSimulatedExecutionClock } from '../src/intraday-replay/clock'
import { makeReplayBroker } from '../src/intraday-replay/broker'
import {
  makeReplayInferenceBudget,
  makeReplayInferenceTiming,
  type ReplayInferenceCall,
} from '../src/intraday-replay/inference-timing'
import { makeReplayExecutionRuntime } from '../src/intraday-replay/runtime'
import { driveReplaySession, makeReplayTimeline } from '../src/intraday-replay/session'
import { JevClient, JevError } from '../src/jev/client'
import { JevFailure } from '../src/jev/contract'
import { entryProviderFixture } from '../src/jev/entry-inference.test-support'
import { equityMarketProfile } from '../src/jev/markets'
import { nativeJevInference } from '../src/jev/native.test-support'
import { JournalLive } from '../src/ledger'
import {
  advanceHistoricalMarketCursor,
  createHistoricalMarketCursor,
  type HistoricalMarketCursor,
} from '../src/market-data/streaming/historical'
import { observedQuoteAt } from '../src/market-data/streaming/projection'
import { OperationDeadlineClock } from '../src/operation-timeout'
import { momentumTradeReplayFixture } from '../src/testing/retained-replay-fixture'
import { config as baseConfig, fixtureRuntime } from '../src/testing/runtime-fixtures'
import { utcInstantFromEpochMillis } from '../src/time'

const Arguments = Schema.Struct({
  postgresUrl: Schema.String,
  tigerBeetleAddress: Schema.String,
  reportPath: Schema.String,
  sourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  scenario: Schema.Literals(['trade', 'no-trade', 'provider-unknown']),
})
const [postgresUrl, tigerBeetleAddress, reportPath, sourceRevision, scenario = 'trade'] = process.argv.slice(2)
const args = Schema.decodeUnknownSync(Arguments)({
  postgresUrl,
  tigerBeetleAddress,
  reportPath,
  sourceRevision,
  scenario,
})
if (process.versions.node !== '24.11.1') throw new Error('Matched financial benchmark requires Node 24.11.1')
const url = new URL(args.postgresUrl)
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test') ||
  !/^127\.0\.0\.1:\d+$/.test(args.tigerBeetleAddress) ||
  !args.reportPath.startsWith('/')
)
  throw new Error(
    'Financial benchmark requires a local disposable *_test database, local TigerBeetle, and absolute report path',
  )

const physicalClock = Clock.Clock.defaultValue()
const calls: ReplayInferenceCall[] = []
const stages = new Map<
  string,
  { count: number; failed: number; totalInclusiveMs: number; maximumInclusiveMs: number }
>()
class PhysicalSpan extends Tracer.NativeSpan {
  readonly physicalStart = performance.now()
  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    if (this.status._tag === 'Ended') return
    super.end(endTime, exit)
    if (!this.name.startsWith('bayn.') && !this.name.startsWith('sql.')) return
    const duration = performance.now() - this.physicalStart
    const previous = stages.get(this.name) ?? { count: 0, failed: 0, totalInclusiveMs: 0, maximumInclusiveMs: 0 }
    previous.count++
    previous.failed += Exit.isFailure(exit) ? 1 : 0
    previous.totalInclusiveMs += duration
    previous.maximumInclusiveMs = Math.max(previous.maximumInclusiveMs, duration)
    stages.set(this.name, previous)
  }
}
const tracer = Tracer.make({ span: (options) => new PhysicalSpan(options) })
const retained = momentumTradeReplayFixture()
const fixture = retained.input
const initialAtMs = Date.parse(fixture.query.observedAt)
const lastAtMs = initialAtMs + 40_000
const sourceHash = Result.getOrThrow(
  canonicalHashV1Result({
    calendar: fixture.input.calendar,
    events: retained.events,
    marketSources: fixture.source.marketSources,
  }),
)
const runId = sha256(`bayn.matched-financial-work.v1:${args.scenario}:${sourceHash}`)
const source = { ...fixture.source, runId, sourceManifestHash: sourceHash }
const accountId = `replay-${runId}`
const config: RuntimeConfig = {
  ...baseConfig,
  build: {
    ...baseConfig.build,
    sourceRevision: args.sourceRevision,
    imageRepository: 'benchmark.invalid/bayn',
    imageDigest: `sha256:${sha256(args.sourceRevision)}`,
  },
  operationTimeoutMs: 10_000,
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
  postgres: { url: Redacted.make(args.postgresUrl), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 20912n, ledger: 70912, replicaAddresses: [args.tigerBeetleAddress] },
}
const calendar = Schema.decodeUnknownSync(MarketCalendarResponseSchema)(fixture.input.calendar)
const assets = equityMarketProfile.universe.map((symbol, index) =>
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
)
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
const provider = entryProviderFixture({
  evaluate: (raw) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      yield* Effect.sleep(25)
      if (args.scenario === 'provider-unknown')
        return yield* new JevError({
          failure: JevFailure.Transport,
          message: 'Controlled unknown provider response after dispatch',
        })
      const now = yield* Clock.currentTimeMillis
      const request = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ state: Schema.Struct({ symbol: Schema.String }) }),
      )(raw).pipe(Effect.orDie)
      const supports = args.scenario === 'trade' && request.state.symbol === 'AAPL'
      return {
        ...nativeJevInference(raw, utcInstantFromEpochMillis(now), supports),
        startedAt: utcInstantFromEpochMillis(started),
      }
    }),
})

const program = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const [databaseVersion] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Struct({ version: Schema.String })]),
  )(yield* sql`SELECT current_setting('server_version_num') AS version`)
  if (!databaseVersion.version.startsWith('18'))
    return yield* Effect.die('Matched financial benchmark requires PostgreSQL 18')
  const [fresh] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ fresh: Schema.Boolean })]))(
    yield* sql`SELECT NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public') AS fresh`,
  )
  if (!fresh.fresh) return yield* Effect.die('Benchmark refuses to change a nonempty database')
  yield* postgresMigrations
  yield* TestClock.setTime(initialAtMs - 60_000)
  const clock = yield* makeSimulatedExecutionClock(runId, sourceHash, physicalClock)
  let cursor: HistoricalMarketCursor = Result.getOrThrow(
    createHistoricalMarketCursor(runId, source.marketSources, undefined, source),
  )
  let nextArrival = 0
  let broker: Effect.Success<ReturnType<typeof makeReplayBroker>> | undefined
  const publish = (atMs: number) =>
    Effect.gen(function* () {
      while (nextArrival < retained.events.length) {
        const arrival = retained.events[nextArrival]
        if (arrival === undefined || arrival.availableAtMs > atMs) break
        const previous = cursor.projection.quotes
        cursor = yield* Effect.fromResult(advanceHistoricalMarketCursor(cursor, arrival))
        const changed = [...cursor.projection.quotes].find(([symbol, quote]) => previous.get(symbol) !== quote)?.[1]
        if (broker !== undefined) yield* broker.observeMarket(arrival.availableAtMs, changed ?? null)
        nextArrival++
      }
    })
  const timeline = yield* makeReplayTimeline(
    { advanceTo: publish },
    clock,
    lastAtMs + config.operationTimeoutMs + 10_000,
  )
  yield* timeline.advanceTo(initialAtMs - 60_000)
  const budget = makeReplayInferenceBudget(1000)
  const timing = yield* makeReplayInferenceTiming({
    providers: { jev: provider },
    budget,
    providerClock: physicalClock,
    ...timeline,
    measureDatabaseTime: clock.measure,
    excludedSourceMillis: clock.excludedSourceMillis,
    retain: (call) =>
      Effect.sync(() => {
        calls.push(call)
      }),
  })
  broker = yield* makeReplayBroker({
    runId,
    sourceManifestHash: sourceHash,
    openingCashMicros: '100000000000',
    protocol: { ...fixture.protocol, ...equityMarketProfile },
    assumptions: { latencyMs: 10, slippageBps: 0, availableLiquidityPpm: 1_000_000, feeMultiplierPpm: 1_000_000 },
    fractionalTrading: false,
    calendar,
    assets,
    quoteAt: (symbol, atMs, source) => Effect.sync(() => observedQuoteAt(cursor.projection, symbol, atMs, source)),
    submissionTime: timing.currentUtcInstant,
    advanceToArrival: timeline.advanceTo,
  })
  const passes: Array<{
    wallMs: number
    cpuUserMicros: number
    cpuSystemMicros: number
    observation: unknown
    result: unknown
  }> = []
  const runtime = yield* timing.run(
    makeReplayExecutionRuntime({
      decisionLatencyStress: null,
      config,
      strategy: fixtureRuntime,
      broker,
      source,
      cursor: Effect.sync(() => cursor),
      clock,
      currentUtcInstant: timing.currentUtcInstant,
      recordPass: () => Effect.void,
      pollIntervalMs: 1000,
      reconciliationIntervalMs: 10_000,
      reconciliationPassTimeoutMs: 10_000,
    }).pipe(Effect.provideService(JevClient, timing.clients.jev)),
  )
  stages.clear()
  const wallStart = performance.now()
  const cpuStart = process.cpuUsage()
  const advance = Effect.suspend(() => {
    const started = performance.now()
    const cpu = process.cpuUsage()
    return timing.run(runtime.advance).pipe(
      Effect.tap((pass) =>
        Effect.sync(() => {
          const used = process.cpuUsage(cpu)
          passes.push({
            wallMs: performance.now() - started,
            cpuUserMicros: used.user,
            cpuSystemMicros: used.system,
            observation: pass.observation,
            result: pass.result ?? null,
          })
        }),
      ),
    )
  })
  const schedule = yield* driveReplaySession({ ...runtime, advance }, timeline.advanceTo, initialAtMs, lastAtMs, true)
  const reconciliation = yield* timing.run(runtime.reconcile)
  const physicalWallMs = performance.now() - wallStart
  const cpu = process.cpuUsage(cpuStart)
  const measuredStages = [...stages].map(([name, timings]) => ({ name, ...timings }))
  const state = yield* broker.snapshot
  const [counts] = yield* sql`SELECT
    (SELECT count(*)::int FROM intents WHERE account_id=${accountId}) AS intents,
    (SELECT count(*)::int FROM mutation_events m JOIN intents i USING (intent_id) WHERE i.account_id=${accountId} AND m.event_type='SUBMIT_STARTED') AS submit_started,
    (SELECT count(*)::int FROM fills WHERE account_id=${accountId}) AS fills,
    (SELECT count(*)::int FROM accounting_transactions WHERE account_id=${accountId}) AS accounting_transactions,
    (SELECT count(*)::int FROM accounting_receipts r JOIN accounting_transactions t USING (broker_event_id) WHERE t.account_id=${accountId}) AS accounting_receipts,
    (SELECT count(*)::int FROM jev_evaluation_requests) AS inference_requests,
    (SELECT count(*)::int FROM jev_evaluation_receipts) AS inference_receipts,
    (SELECT count(*)::int FROM jev_batch_plans) AS batch_plans,
    (SELECT count(*)::int FROM jev_batch_results) AS batch_results,
    (SELECT coalesce(sum(pg_column_size(document)),0)::text FROM autonomous_cycle_shadow_decisions) AS decision_storage_bytes`
  const accounting = yield* sql<{
    json: string
  }>`SELECT row_to_json(t)::text AS json FROM accounting_transactions t WHERE account_id=${accountId} ORDER BY occurred_at,transaction_id`
  const decisions = yield* sql`SELECT document FROM autonomous_cycle_shadow_decisions ORDER BY created_at`
  const candidateOutcomes = yield* sql`SELECT p.payload AS plan, r.payload AS result
    FROM jev_batch_plans p LEFT JOIN jev_batch_results r USING(batch_id) ORDER BY p.batch_id`
  const authority = yield* runtime.store.authorityGeneration.readAuthorityState
  if (
    schedule.failedPassCount !== 0 ||
    reconciliation.report.reconciliation.status !== 'EXACT' ||
    reconciliation.brokerState.unknownOrderCount !== 0 ||
    reconciliation.riskContext.unknownMutationCount !== 0
  )
    return yield* Effect.die(
      'Financial proof failed: unsuccessful pass, inexact reconciliation, or unresolved mutation',
    )
  if (args.scenario !== 'trade' && (state.orders.length !== 0 || state.fills.length !== 0))
    return yield* Effect.die('A rejected or unknown inference produced financial side effects')
  if (args.scenario === 'trade' && state.fills.length === 0)
    return yield* Effect.die('Trade fixture did not exercise financial posting')
  const report = {
    schemaVersion: 'bayn.matched-financial-benchmark.v1',
    sourceRevision: args.sourceRevision,
    scenario: args.scenario,
    versions: { node: process.versions.node, postgres: databaseVersion.version },
    scope:
      'Actual production financial engine, PostgreSQL persistence, TigerBeetle posting; deterministic simulated broker and controlled provider; offline polling cadence, not streaming transport latency',
    excluded: ['Dorvud WebSocket', 'Flink', 'Kafka', 'Restate', 'provider HTTP/network', 'live broker orders'],
    measurement: {
      physicalWallMs,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      cpuScope: 'this Node process only; excludes PostgreSQL and TigerBeetle CPU',
      initializationExcluded: true,
      semanticClock: 'original recorded source dates plus physical database/provider elapsed; not wall latency',
      inclusiveStagesMustNotBeAdded: true,
    },
    workload: {
      sourceHash,
      inputBytesHash: sha256(retained.body),
      records: retained.events.length,
      publishedRecords: nextArrival,
      runId,
      accountId,
      originalEligibleAt: fixture.query.observedAt,
      originalWindowEndAt: fixture.query.rangeEndAt,
      lastAt: utcInstantFromEpochMillis(lastAtMs),
      cadenceMs: 1000,
      providerJevDelayMs: 25,
      openingCashMicros: '100000000000',
    },
    opportunities: {
      expectedSignalWindows: 1,
      declaredCandidateSymbols: fixture.snapshot.manifest.candidateSymbols ?? [],
      persistedCandidateOutcomes: candidateOutcomes,
      schedule,
      providerDispatchCount: budget.dispatchCount(),
      providerCalls: calls,
    },
    work: {
      counts,
      passes,
      spans: measuredStages,
      physicalSqlQueryCount: null,
      lockWaitMs: null,
    },
    financial: { state, reconciliation, authority, accounting: accounting.map((row) => row.json), decisions },
  }
  yield* Effect.tryPromise(() => writeFile(args.reportPath, JSON.stringify(report, null, 2) + '\n'))
}).pipe(Effect.scoped, Effect.withTracer(tracer), Effect.provideService(OperationDeadlineClock, physicalClock))

// @effect-diagnostics-next-line strictEffectProvide:off -- standalone benchmark entrypoint owns its database, ledger and simulated clock resources
NodeRuntime.runMain(program.pipe(Effect.provide(Layer.mergeAll(stores, TestClock.layer(), NodeServices.layer))))
