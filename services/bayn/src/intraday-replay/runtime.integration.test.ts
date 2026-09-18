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
import { config as baseConfig, fixtureRuntime } from '../testing/runtime-fixtures'
import { makeActiveStrategyRuntime } from '../strategy'
import { IntradayExitTiming, intradayExitTimingProtocol } from '../strategy/intraday-momentum/research'
import { simulationFixture } from '../testing/simulated-streaming-fixture'
import { historicalRawArrivals } from '../testing/historical-streaming-fixture'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import {
  advanceHistoricalMarketCursor,
  compareArrivalPositions,
  arrivalPosition,
  type HistoricalMarketCursor,
} from '../market-data/streaming/historical'
import { utcInstantFromEpochMillis } from '../time'
import { makeReplayBroker, ReplayBrokerFailure } from './broker'
import { makeReplayExecutionRuntime } from './runtime'
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
  ['fill', IntradayExitTiming.Current],
  ['recovery', IntradayExitTiming.Current],
  ['recovery-filled', IntradayExitTiming.Current],
  ['fill', IntradayExitTiming.FifteenMinutes],
  ['fill', IntradayExitTiming.ThirtyMinutes],
] as const)(
  'production cycle and durable accounting: %s / %s',
  async (scenario, exitTiming) => {
    if (baynTestPostgresUrl === undefined || baynTestTigerBeetleAddress === undefined)
      throw new Error('Missing replay test databases')
    const url = new URL(baynTestPostgresUrl)
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.endsWith('_test') ||
      !/^127\.0\.0\.1:\d+$/.test(baynTestTigerBeetleAddress)
    )
      throw new Error('Replay acceptance requires isolated local test databases')
    const protocol = Result.getOrThrow(intradayExitTimingProtocol(exitTiming))
    const fixture = { ...simulationFixture(), protocol }
    const strategyRuntime = makeActiveStrategyRuntime(protocol, {
      ...fixtureRuntime.provenance,
      strategy: { ...fixtureRuntime.provenance.strategy, parameterHash: canonicalHashV1(protocol) },
    })
    const closeAtMs =
      scenario === 'fill'
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
        record: { ...arrival.record, offset: String(BigInt(arrival.record.offset) + 10000n) },
      }))
      .toSorted((a, b) => compareArrivalPositions(arrivalPosition(a), arrivalPosition(b)))
    const runId = canonicalHashV1({ attempt: randomUUID() })
    const source = {
      ...fixture.source,
      runId,
      sourceManifestHash: canonicalHashV1({
        ...fixture.input,
        arrivals: { ...fixture.input.arrivals, events: [...fixture.input.arrivals.events, ...closeArrivals] },
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
          strategy: strategyRuntime,
          exitTiming,
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
          cursor: Effect.sync(() => cursor),
          clock,
          recordPass: (pass: Parameters<import('../app').RecordAutonomousCyclePass>[0]) =>
            Ref.update(passes, (values) => [...values, pass]),
          pollIntervalMs: 1000,
          reconciliationIntervalMs: 1000,
          reconciliationPassTimeoutMs: scenario === 'fill' ? 1000 : config.operationTimeoutMs,
        }
        const runtime = yield* makeReplayExecutionRuntime(runtimeInput)
        if (scenario !== 'fill') {
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
                  reconciliationIntervalMs: loseResponse ? 1000 : config.operationTimeoutMs,
                  reconciliationPassTimeoutMs: loseResponse ? 1000 : config.operationTimeoutMs,
                },
                execution: {
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
          for (let attempt = 0; attempt < 20 && lostResponses === 0; attempt++) {
            yield* advanceBy(1000)
            yield* healthy.advance.pipe(Effect.provideService(OperationDeadlineClock, liveClock))
          }
          expect(lostResponses).toBe(1)
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
        yield* runtime.reconcile
        let waiting = yield* runtime.advance
        for (
          let attempt = 0;
          attempt < 4 && waiting.result?.outcome === 'RECOVERED' && waiting.result.waitReason !== 'open-position';
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
          waitReason: 'open-position',
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
        expect(brokerState.ledger.positions).toHaveLength(0)
        expect(brokerState.fills.map((fill) => fill.side)).toEqual([OrderSide.Buy, OrderSide.Sell])
        const rows = yield* sql<Record<string, unknown>>`SELECT
      (SELECT count(*)::int FROM intents WHERE account_id = ${accountId}) AS intents,
      (SELECT count(*)::int FROM fills WHERE account_id = ${accountId}) AS fills,
      (SELECT count(*)::int FROM accounting_transactions WHERE account_id = ${accountId}) AS transactions`
        return { _tag: 'Fill' as const, brokerState, reconciliation, rows, passes: yield* Ref.get(passes) }
      }).pipe(
        Effect.scoped,
        Effect.provide(stores),
        Effect.provide(TestClock.layer()),
        Effect.provide(NodeServices.layer),
      ),
    )
    if (outcome._tag === 'Recovery') return
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
