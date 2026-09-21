import { OperationDeadlineClock, operationTimeoutOrElse } from '../operation-timeout'
import { utcInstantFromEpochMillis } from '../time'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { AssetResponseSchema, MarketCalendarResponseSchema } from '../broker/alpaca/model'
import { normalizeAssetResult, normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { EmbeddedBuildMetadataSchema, embeddedBuildMetadata } from '../build'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import { causeSummary } from '../broker/alpaca-mutations/model'
import { makeRuntimeProvenance } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import {
  ImageDigestSchema,
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import {
  activeStrategyBehaviorHash,
  activeStrategyName,
  loadActiveStrategyProtocol,
  makeActiveStrategyRuntime,
} from '../strategy'
import { JevClient } from '../jev/client'
import { jevModel } from '../jev/contract'
import { makeReplayJevTiming, type ReplayJevCall } from './jev-timing'
import { calculateReplayJevCosts, ReplayJevCostModelSchema } from './jev-costs'
import {
  BacktestSourceManifestSchema,
  openBacktestSource,
  validateBacktestSourceManifest,
  validateBacktestSourceCuts,
  type BacktestSourceReceipt,
} from './source'
import { makeSimulatedExecutionClock } from './clock'
import { makeReplayBroker, ReplayBrokerFailure, type ReplayBrokerState, type ReplayValuationEvidence } from './broker'
import type { CycleRunResult } from '../cycle/runner/model'
import { makeReplayExecutionRuntime } from './runtime'
import { makeReplayTimeline, driveReplaySession } from './session'
import type { RuntimeConfig } from '../config'
import type { RecordAutonomousCyclePass } from '../app'
import type { OperationalError } from '../errors'
import { postgresMigrations } from '../db/postgres-migrations'
import { ReconciliationStatus } from '../execution/contracts'
import type { ReconciliationMetrics } from '../simulation-reconciliation/broker-model'
import { decodeExecutionDecisionDocument } from '../shadow-decision-contract'
import { decodeExecutionCycleClosureResult } from '../db/execution-cycle-closure'
import { observedQuoteAt } from '../market-data/streaming/projection'

export enum BacktestIssue {
  CycleFailure = 'cycle-failure',
  InexactAccounting = 'inexact-accounting',
  UnresolvedMutation = 'unresolved-mutation',
  UnclosedPosition = 'unclosed-position',
  MissingValuation = 'missing-valuation',
  MissingDecisionData = 'missing-decision-data',
  UnresolvedModelCost = 'unresolved-model-cost',
  UnresolvedExecutionCost = 'unresolved-execution-cost',
}

export const assessBacktestSession = (input: {
  readonly failedPassCount: number
  readonly unavailableDecisionPassCount: number
  readonly valuationFailureCount: number
  readonly reconciliation: {
    readonly status: ReconciliationStatus
    readonly metrics: ReconciliationMetrics
    readonly unknownOrderCount: number
    readonly unknownMutationCount: number
  }
  readonly remainingPositionCount: number
}) => {
  const issues: BacktestIssue[] = []
  const { status, metrics, unknownOrderCount, unknownMutationCount } = input.reconciliation
  if (input.unavailableDecisionPassCount > 0) issues.push(BacktestIssue.MissingDecisionData)
  if (input.failedPassCount > 0) issues.push(BacktestIssue.CycleFailure)
  if (input.valuationFailureCount > 0) issues.push(BacktestIssue.MissingValuation)
  if (
    status !== ReconciliationStatus.Exact ||
    !metrics.accountingExact ||
    metrics.discrepancyCount !== 0 ||
    metrics.cashDifferenceMicros !== '0' ||
    metrics.positionDifferenceMicros !== '0' ||
    metrics.equityDifferenceMicros !== '0'
  )
    issues.push(BacktestIssue.InexactAccounting)
  if (unknownOrderCount !== 0 || unknownMutationCount !== 0) issues.push(BacktestIssue.UnresolvedMutation)
  if (input.remainingPositionCount > 0) issues.push(BacktestIssue.UnclosedPosition)
  return { completion: issues.length === 0 ? ('COMPLETE' as const) : ('INCOMPLETE' as const), issues }
}

export const BacktestInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.backtest.v3'),
  inference: Schema.Struct({
    mode: Schema.Literal('measured-provider'),
    model: Schema.Literal(jevModel),
    inputDefinition: Schema.Literal('bayn.jev-trading-signal-state.v2'),
    costs: ReplayJevCostModelSchema,
  }),
  allocatedDataCostPerSessionMicros: UnsignedMicrosSchema,
  replicate: StrictNonEmptyStringSchema,
  sessionDates: Schema.Array(IsoDateSchema).check(Schema.isMinLength(1)),
  source: BacktestSourceManifestSchema,
  openingCashMicros: PositiveMicrosSchema,
  fractionalTrading: Schema.Boolean,
  calendar: MarketCalendarResponseSchema,
  assets: Schema.Array(AssetResponseSchema).check(Schema.isMinLength(1)),
  assetObservationAt: UtcInstantSchema,
  assetObservationPolicy: Schema.Literals(['retained-as-of-session', 'counterfactual-current-asset-eligibility']),
  build: Schema.Struct({ ...EmbeddedBuildMetadataSchema.fields, imageDigest: ImageDigestSchema }),
  assumptions: Schema.Struct({
    latencyMs: NonNegativeIntegerSchema,
    slippageBps: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(10_000)),
    availableLiquidityPpm: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1_000_000)),
    feeMultiplierPpm: PositiveIntegerSchema.check(Schema.isBetween({ minimum: 1_000_000, maximum: 10_000_000 })),
  }),
  cadence: Schema.Struct({
    pollIntervalMs: PositiveIntegerSchema,
    reconciliationIntervalMs: PositiveIntegerSchema,
    reconciliationPassTimeoutMs: PositiveIntegerSchema,
    reconciliationStaleThresholdMs: PositiveIntegerSchema,
  }),
})

export const prepareBacktest = (input: unknown, sourceReceipt: BacktestSourceReceipt) =>
  Result.gen(function* () {
    const supplied = yield* Schema.decodeUnknownResult(BacktestInputSchema, strictParseOptions)(input)
    const decoded = {
      ...supplied,
      sessionDates: [...supplied.sessionDates].sort(),
      assets: [...supplied.assets].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)),
      calendar: [...supplied.calendar].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    }
    yield* validateBacktestSourceManifest(decoded.source)
    yield* validateBacktestSourceCuts(decoded.source, sourceReceipt)
    const baselineProtocol = yield* loadActiveStrategyProtocol()
    const baselineParameterHash = yield* canonicalHashV1Result(baselineProtocol)
    if (
      decoded.build.strategyBehaviorHash !== activeStrategyBehaviorHash ||
      decoded.build.strategyParameterHash !== baselineParameterHash
    )
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Replay must use the unchanged source-controlled strategy' }),
      )
    if (
      embeddedBuildMetadata !== undefined &&
      (yield* canonicalHashV1Result(embeddedBuildMetadata)) !==
        (yield* canonicalHashV1Result({
          sourceRevision: decoded.build.sourceRevision,
          imageRepository: decoded.build.imageRepository,
          strategyBehaviorHash: decoded.build.strategyBehaviorHash,
          strategyParameterHash: decoded.build.strategyParameterHash,
        }))
    )
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Replay build differs from the executable embedded build' }),
      )
    const protocol = baselineProtocol
    const parameterHash = baselineParameterHash
    const universe = {
      universeId: protocol.universeId,
      universeSymbolHash: protocol.universeSymbolHash,
      symbols: protocol.universe,
      topics: {
        ...protocol.sourceTopics,
        features: protocol.streamingInput.featureTopic,
        ...(decoded.source.universe.topics.technicalFeatures === undefined
          ? {}
          : { technicalFeatures: decoded.source.universe.topics.technicalFeatures }),
      },
    }
    if ((yield* canonicalHashV1Result(universe)) !== (yield* canonicalHashV1Result(decoded.source.universe)))
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Replay source universe differs from the strategy universe' }),
      )
    const calendarDays = yield* Result.all(
      decoded.calendar.map((session) =>
        normalizeMarketCalendarResult([session], { start: session.date, end: session.date }),
      ),
    )
    const calendar = { sessions: calendarDays.flatMap((day) => day.sessions) }
    if (new Set(calendar.sessions.map((session) => session.date)).size !== calendar.sessions.length)
      return yield* Result.fail(new ReplayBrokerFailure({ message: 'Backtest calendar contains duplicate sessions' }))
    const selectedDates: ReadonlySet<string> = new Set(decoded.sessionDates)
    const sessions = calendar.sessions.filter((session) => selectedDates.has(session.date))
    const firstSession = sessions[0]
    const lastSession = sessions.at(-1)
    if (
      firstSession === undefined ||
      lastSession === undefined ||
      selectedDates.size !== decoded.sessionDates.length ||
      sessions.length !== selectedDates.size
    )
      return yield* Result.fail(
        new ReplayBrokerFailure({
          message: 'Backtest requires unique sessions present in the supplied market calendar',
        }),
      )
    if (decoded.calendar.some((entry) => entry.date < firstSession.date))
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'A fresh backtest cannot include prior calendar sessions' }),
      )
    if (
      calendar.sessions.some(
        (session) =>
          session.date >= firstSession.date && session.date <= lastSession.date && !selectedDates.has(session.date),
      )
    )
      return yield* Result.fail(
        new ReplayBrokerFailure({
          message: 'A continuous backtest cannot skip calendar sessions between its boundaries',
        }),
      )
    if (!calendar.sessions.some((session) => session.date > lastSession.date))
      return yield* Result.fail(
        new ReplayBrokerFailure({
          message: 'Backtest calendar must include the next broker session after the final replay session',
        }),
      )
    const openMs = Date.parse(firstSession.openAt)
    const closeMs = Date.parse(lastSession.closeAt)
    if (decoded.assetObservationPolicy === 'retained-as-of-session' && Date.parse(decoded.assetObservationAt) > openMs)
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Retained asset observation was not available at market open' }),
      )
    if (decoded.source.coverageStartMs > openMs || decoded.source.coverageEndMs < closeMs)
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Frozen source receipt does not cover market open through close' }),
      )
    const assetSymbols = decoded.assets.map((asset) => asset.symbol)
    if (
      new Set(assetSymbols).size !== assetSymbols.length ||
      assetSymbols.length !== protocol.universe.length ||
      protocol.universe.some((symbol) => !assetSymbols.includes(symbol))
    )
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Replay asset metadata is duplicated or misses source symbols' }),
      )
    const assets = yield* Result.all(
      decoded.assets.map((asset) => normalizeAssetResult(asset, asset.symbol, decoded.assetObservationAt)),
    )
    const runId = yield* canonicalHashV1Result({ ...decoded, assets, sourceReceiptHash: sourceReceipt.contentHash })
    const identity = yield* makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: `replay-${runId}`,
    })
    const provenance = makeRuntimeProvenance({
      sourceRevision: decoded.build.sourceRevision,
      image: { repository: decoded.build.imageRepository, digest: decoded.build.imageDigest },
      strategy: {
        name: activeStrategyName,
        behaviorHash: activeStrategyBehaviorHash,
        parameterHash,
        parameterSchemaVersion: protocol.schemaVersion,
      },
    })
    return {
      input: decoded,
      sourceReceipt,
      runId,
      protocol,
      assets,
      identity,
      sessions,
      openMs,
      closeMs,
      buildEvidence: {
        sourceRevision: decoded.build.sourceRevision,
        imageRepository: decoded.build.imageRepository,
        declaredImageDigest: decoded.build.imageDigest,
        imageDigestVerification: 'unverified-input' as const,
        strategyBehaviorHash: decoded.build.strategyBehaviorHash,
        strategyParameterHash: decoded.build.strategyParameterHash,
        sourceAndStrategyVerification:
          embeddedBuildMetadata === undefined ? ('configured' as const) : ('embedded' as const),
      },
      runtimeBuild: {
        ...decoded.build,
        strategyParameterHash: parameterHash,
        verification: embeddedBuildMetadata === undefined ? ('development-configured' as const) : ('embedded' as const),
      },
      strategy: makeActiveStrategyRuntime(protocol, provenance),
    }
  })
export type PreparedBacktest = Result.Result.Success<ReturnType<typeof prepareBacktest>>
export type ReplayDatabaseConfig = Pick<RuntimeConfig, 'postgres' | 'tigerBeetle' | 'operationTimeoutMs'>

export const prepareFreshReplayDatabase = (timeoutMs = 30_000) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const schema = yield* sql<Record<string, unknown>>`SELECT
    pg_catalog.current_schemas(false) = ARRAY['public']::name[] AS valid`
    if (schema[0]?.['valid'] !== true)
      return yield* new ReplayBrokerFailure({ message: 'Fresh replay requires public as the only effective schema' })
    const existing = yield* sql<Record<string, unknown>>`SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend d
    WHERE d.refclassid = 'pg_catalog.pg_namespace'::regclass
      AND d.refobjid = 'public'::regnamespace
  ) AS present`
    if (existing[0]?.['present'] !== false)
      return yield* new ReplayBrokerFailure({
        message:
          'Fresh replay requires an unused database with an empty public schema; preserve existing stores for recovery',
      })
    yield* postgresMigrations
  }).pipe(
    operationTimeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new ReplayBrokerFailure({ message: `Replay database setup exceeded ${timeoutMs}ms` })),
    }),
  )

export type BacktestPass = Parameters<RecordAutonomousCyclePass>[0] & {
  readonly cycleResult: CycleRunResult | null
  readonly brokerState: ReplayBrokerState
  readonly valuation: ReplayValuationEvidence | null
  readonly valuationFailure: Readonly<Record<string, string>> | null
}

/** One engine, broker, portfolio, and durable account span every declared calendar session. */
export const runBacktest = (
  prepared: PreparedBacktest,
  arrivalsPath: string,
  databases: ReplayDatabaseConfig,
  recordPass: (pass: BacktestPass) => Effect.Effect<void, OperationalError>,
  recordInference: (call: ReplayJevCall) => Effect.Effect<void, ReplayBrokerFailure>,
) =>
  Effect.gen(function* () {
    const source = yield* openBacktestSource(
      arrivalsPath,
      prepared.input.source,
      prepared.runId,
      prepared.sourceReceipt,
    )
    const sql = yield* PgClient.PgClient
    yield* prepareFreshReplayDatabase(databases.operationTimeoutMs)
    const initializationStartedAtMs = prepared.openMs - 60_000
    yield* TestClock.setTime(initializationStartedAtMs)
    const clock = yield* makeSimulatedExecutionClock(prepared.runId, source.source.sourceManifestHash)
    const advanceTo = yield* makeReplayTimeline(source, clock, prepared.closeMs + databases.operationTimeoutMs + 10_000)
    yield* advanceTo(initializationStartedAtMs)
    const providerClock = yield* OperationDeadlineClock
    if (providerClock === undefined)
      return yield* new ReplayBrokerFailure({ message: 'Native Jev backtest requires its measured provider clock' })
    const inferenceCalls: ReplayJevCall[] = []
    const timing = yield* makeReplayJevTiming({
      measureDatabaseTime: clock.measure,
      provider: yield* JevClient,
      providerClock,
      advanceTo,
      retain: (call) =>
        recordInference(call).pipe(
          Effect.andThen(
            Effect.sync(() => {
              inferenceCalls.push(call)
            }),
          ),
        ),
    })
    const broker = yield* makeReplayBroker({
      runId: prepared.runId,
      submissionTime: timing.currentUtcInstant,
      sourceManifestHash: source.source.sourceManifestHash,
      openingCashMicros: prepared.input.openingCashMicros,
      protocol: prepared.protocol,
      assumptions: prepared.input.assumptions,
      fractionalTrading: prepared.input.fractionalTrading,
      assets: prepared.assets,
      calendar: prepared.input.calendar,
      advanceToArrival: advanceTo,
      quoteAt: (symbol, atMs) =>
        source.cursor.pipe(Effect.map((cursor) => observedQuoteAt(cursor.projection, symbol, atMs))),
    })
    const runtime = yield* makeReplayExecutionRuntime({
      currentUtcInstant: timing.currentUtcInstant,
      config: {
        ...databases,
        build: prepared.runtimeBuild,
        reconciliationStaleThresholdMs: prepared.input.cadence.reconciliationStaleThresholdMs,
        execution: {
          brokerIdentity: prepared.identity,
          brokerAccess: BrokerAccess.ReadOnly,
          capitalAuthority: noCapitalAuthority,
        },
      },
      strategy: prepared.strategy,
      broker,
      source: source.source,
      cursor: source.cursor,
      clock,
      recordPass: () => Effect.void,
      ...prepared.input.cadence,
    }).pipe(Effect.provideService(JevClient, timing.client), timing.run)
    const initializationCompletedAtMs = yield* Clock.currentTimeMillis
    if (initializationCompletedAtMs > prepared.openMs)
      return yield* new ReplayBrokerFailure({ message: 'Replay initialization missed the first session open' })
    const initialization = {
      startedAt: utcInstantFromEpochMillis(initializationStartedAtMs),
      completedAt: utcInstantFromEpochMillis(initializationCompletedAtMs),
      elapsedMs: initializationCompletedAtMs - initializationStartedAtMs,
      firstSessionOpenAt: utcInstantFromEpochMillis(prepared.openMs),
    }
    let peakEquity = BigInt(prepared.input.openingCashMicros)
    let maximumObservedDrawdown = 0n
    let previousClosingEquity = peakEquity
    let accruedDataCost = 0n
    const markedNetEquity = (equityMicros: string) =>
      BigInt(equityMicros) -
      accruedDataCost -
      BigInt(calculateReplayJevCosts(inferenceCalls, prepared.input.inference.costs).knownCostMicros)
    const observeEquity = (equity: bigint) => {
      if (equity > peakEquity) peakEquity = equity
      const drawdown = peakEquity - equity
      if (drawdown > maximumObservedDrawdown) maximumObservedDrawdown = drawdown
    }
    const sessions = yield* Effect.forEach(
      prepared.sessions,
      (session) =>
        Effect.gen(function* () {
          let valuationFailureCount = 0
          const firstCallIndex = inferenceCalls.length
          accruedDataCost += BigInt(prepared.input.allocatedDataCostPerSessionMicros)
          const schedule = yield* driveReplaySession(
            {
              ...runtime,
              advance: timing.run(runtime.advance).pipe(
                Effect.tap((pass) =>
                  Effect.gen(function* () {
                    const valued = yield* Effect.result(
                      Effect.all({ account: broker.read.account, valuation: broker.valuation }),
                    )
                    if (Result.isSuccess(valued))
                      observeEquity(markedNetEquity(valued.success.account.value.equityMicros))
                    else valuationFailureCount++
                    yield* recordPass({
                      ...pass.observation,
                      cycleResult: pass.result ?? null,
                      brokerState: yield* broker.snapshot,
                      valuation: Result.isSuccess(valued) ? valued.success.valuation : null,
                      valuationFailure: Result.isFailure(valued) ? causeSummary(valued.failure) : null,
                    })
                  }),
                ),
              ),
            },
            advanceTo,
            Date.parse(session.openAt),
            Date.parse(session.closeAt),
          )
          const closingEquity = yield* broker.completeSession(session.date)
          const closingNetEquity = markedNetEquity(closingEquity.equityMicros)
          observeEquity(closingNetEquity)
          yield* advanceTo(Math.max(yield* Clock.currentTimeMillis, Date.parse(session.closeAt) + 1))
          const reconciliation = yield* timing.run(runtime.reconcile)
          const state = yield* broker.snapshot
          const netEquityChangeMicros = (closingNetEquity - previousClosingEquity).toString()
          previousClosingEquity = closingNetEquity
          const modelCosts = calculateReplayJevCosts(
            inferenceCalls.slice(firstCallIndex),
            prepared.input.inference.costs,
          )
          const assessed = assessBacktestSession({
            failedPassCount: schedule.failedPassCount,
            unavailableDecisionPassCount: schedule.unavailableDecisionPassCount,
            valuationFailureCount,
            reconciliation: {
              status: reconciliation.report.reconciliation.status,
              metrics: reconciliation.report.metrics,
              unknownOrderCount: reconciliation.brokerState.unknownOrderCount,
              unknownMutationCount: reconciliation.riskContext.unknownMutationCount,
            },
            remainingPositionCount: state.ledger.positions.length,
          })
          const issues =
            modelCosts.unresolvedCallCount === 0
              ? assessed.issues
              : [...assessed.issues, BacktestIssue.UnresolvedModelCost]
          return {
            completion: issues.length === 0 ? ('COMPLETE' as const) : ('INCOMPLETE' as const),
            issues,
            sessionDate: session.date,
            schedule,
            valuationFailureCount,
            closingEquity,
            closingNetEquityMicros: closingNetEquity.toString(),
            modelCosts,
            allocatedDataCostMicros: prepared.input.allocatedDataCostPerSessionMicros,
            reconciliation,
            netEquityChangeMicros: issues.length === 0 ? netEquityChangeMicros : null,
            equityChangeAfterKnownCostsMicros: netEquityChangeMicros,
            remainingPositions: state.ledger.positions,
          }
        }),
      { concurrency: 1 },
    )
    const brokerState = yield* broker.snapshot
    const modelCosts = calculateReplayJevCosts(inferenceCalls, prepared.input.inference.costs)
    const dataCostMicros = (
      BigInt(prepared.input.allocatedDataCostPerSessionMicros) * BigInt(sessions.length)
    ).toString()
    const executionPnl = brokerState.ledger.netRealizedPnlAfterCostsMicros
    const issues = [
      ...(modelCosts.unresolvedCallCount === 0 ? [] : [BacktestIssue.UnresolvedModelCost]),
      ...(executionPnl === null ? [BacktestIssue.UnresolvedExecutionCost] : []),
    ]
    const complete = sessions.every((session) => session.completion === 'COMPLETE') && issues.length === 0
    // Consume and rehash any retained tail only after the final decision; it cannot affect execution inputs.
    yield* source.finish
    const rows = yield* sql<Record<string, unknown>>`SELECT
    (SELECT count(*)::int FROM intents WHERE account_id = ${broker.accountId}) AS intents,
    (SELECT count(*)::int FROM fills WHERE account_id = ${broker.accountId}) AS fills,
    (SELECT count(*)::int FROM accounting_transactions WHERE account_id = ${broker.accountId}) AS txns`
    const decisionRows = yield* sql<{ document: unknown }>`
      SELECT document FROM autonomous_cycle_shadow_decisions
      WHERE document #>> '{bindings,accountId}' = ${broker.accountId}
      ORDER BY created_at, cycle_id
    `
    const decisions = yield* Effect.forEach(decisionRows, ({ document }) =>
      Effect.fromResult(decodeExecutionDecisionDocument(document)),
    )
    const closingRows = yield* sql<{ document: unknown }>`
      SELECT document FROM (
        SELECT closure.document, closure.created_at FROM autonomous_cycle_paper_closures AS closure
        JOIN autonomous_cycles AS cycle USING (cycle_id) WHERE cycle.account_id = ${broker.accountId}
        UNION ALL
        SELECT replan.document, replan.created_at FROM autonomous_cycle_paper_close_replans AS replan
        JOIN autonomous_cycles AS cycle USING (cycle_id) WHERE cycle.account_id = ${broker.accountId}
      ) AS closes ORDER BY created_at, document->>'contentHash'
    `
    const closingDecisions = yield* Effect.forEach(closingRows, ({ document }) =>
      Effect.fromResult(decodeExecutionCycleClosureResult(document)),
    )
    // Preserve PostgreSQL numeric text, including 128-bit TigerBeetle IDs, without binary64 conversion.
    const accountingTransactions = yield* sql<{ json: string }>`
      SELECT row_to_json(txn)::text AS json FROM accounting_transactions AS txn
      WHERE account_id = ${broker.accountId} ORDER BY occurred_at, transaction_id
    `
    const accountingReceipts = yield* sql<{ json: string }>`
      SELECT row_to_json(receipt)::text AS json FROM accounting_receipts AS receipt
      JOIN accounting_transactions AS txn USING (broker_event_id)
      WHERE txn.account_id = ${broker.accountId} ORDER BY txn.occurred_at, receipt.receipt_id
    `
    const feeAccounting = yield* sql<{ json: string }>`
      SELECT row_to_json(fee)::text AS json FROM broker_fee_accounting AS fee
      WHERE account_id = ${broker.accountId} ORDER BY fee_date, activity_id
    `
    const report = {
      schemaVersion: 'bayn.backtest-report.v2' as const,
      evidenceMode: 'simulated-production-execution' as const,
      profitability: 'UNPROVEN' as const,
      completion: complete ? ('COMPLETE' as const) : ('INCOMPLETE' as const),
      executionEvidence: { orderCount: brokerState.orders.length, fillCount: brokerState.fills.length },
      reconciledExecutionPnlAfterCostsMicros: brokerState.ledger.netRealizedPnlAfterCostsMicros,
      reconciledNetPnlAfterCostsMicros:
        complete && executionPnl !== null
          ? (BigInt(executionPnl) - BigInt(modelCosts.knownCostMicros) - BigInt(dataCostMicros)).toString()
          : null,
      inference: { definition: prepared.input.inference, costs: modelCosts, calls: inferenceCalls },
      dataCostMicros,
      issues,
      runId: prepared.runId,
      source: source.source,
      sessionDates: prepared.input.sessionDates,
      sourceReceiptHash: prepared.sourceReceipt.contentHash,
      build: prepared.buildEvidence,
      assumptions: prepared.input.assumptions,
      initialization,
      sessions,
      schedule: {
        passCount: sessions.reduce((total, session) => total + session.schedule.passCount, 0),
        failedPassCount: sessions.reduce((total, session) => total + session.schedule.failedPassCount, 0),
      },
      netEquityChangeMicros: complete
        ? (previousClosingEquity - BigInt(prepared.input.openingCashMicros)).toString()
        : null,
      equityChangeAfterKnownCostsMicros: (previousClosingEquity - BigInt(prepared.input.openingCashMicros)).toString(),
      peakEquityMicros: peakEquity.toString(),
      maximumObservedDrawdownMicros: complete ? maximumObservedDrawdown.toString() : null,
      maximumObservedDrawdownAfterKnownCostsMicros: maximumObservedDrawdown.toString(),
      brokerState,
      durableCounts: rows[0],
      decisions,
      closingDecisions,
      accountingEvidence: {
        encoding: 'postgres-json-text-preserving-numeric-precision',
        transactions: accountingTransactions.map(({ json }) => json),
        receipts: accountingReceipts.map(({ json }) => json),
        fees: feeAccounting.map(({ json }) => json),
      },
      processedRecords: (yield* source.cursor).processedRecords,
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  })
