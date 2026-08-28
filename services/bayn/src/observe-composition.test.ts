import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import type { AutonomousCycleLoop } from './app'
import { fixtureRuntime } from './app-test-support'
import {
  AccountStatus as BrokerAccountStatus,
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  type Account as BrokerAccount,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type ReadEvidence,
  type ReadResult,
} from './broker/alpaca'
import { unusedAssetBySymbol } from './broker/alpaca-test-support'
import { MutationOperation, orderRequestBody } from './broker/alpaca-mutations'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from './broker/identity'
import {
  CycleState,
  CycleTerminalReason,
  decodeAutonomousCycle,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
} from './cycle'
import { makeStrategyProtocolHash } from './contracts.test-support'
import { CycleStore, CycleStoreError, type CycleStoreShape } from './cycle/store'
import { decideCompletion, validateCompletionDocument } from './cycle/store/decisions'
import { attachCycleDecisionStoreEvidence, cycleDecisionStoreEvidence } from './cycle/store/model'
import type { BrokerSnapshot, ReconciliationWriteResult } from './db/reconciliation'
import {
  BrokerEventStore,
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  ExecutionStoreError,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
  type BrokerEventStoreShape,
  type AuthorityGenerationStoreShape,
  type AuthorityRestrictionStoreShape,
  type FillAccountingStoreShape,
  type ReconciliationStoreShape,
  type ValuationStoreShape,
} from './db/execution-store'
import { operationalError, type OperationalError } from './errors'
import { BrokerAccess, makeExecutionAuthority, grantedCapitalAuthority } from './execution/authority'
import {
  IntentStore,
  planExecutionIntent,
  type BlockedCycleIntentStoreShape,
  type IntentStoreService,
  type StoredIntent,
} from './execution/intents'
import { MutationEventType, MutationStore, type MutationEvent, type MutationStoreShape } from './execution/mutations'
import type { ExecutionProgram } from './execution/runtime-program'
import { WriterFence, WriterFenceError, type WriterFenceService } from './execution/writer-fence'
import { canonicalHashV1 } from './hash'
import {
  IntradaySnapshotFailure,
  MarketData,
  type IntradayMarketDataService,
  type IntradayMarketSnapshot,
  type IntradaySnapshotRequest,
  type MarketDataService,
  type MarketDataSnapshot,
} from './market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from './market-data/intraday/model'
import {
  decodeDefaultOpeningDriveProtocol,
  makeOpeningDriveDefinition,
  openingDriveBehaviorHash,
  openingDriveExecutionModel,
  type OpeningDriveProtocol,
} from './strategy/opening-drive'
import { intradayMomentumBehaviorHash, makeIntradayMomentumDefinition } from './strategy/intraday-momentum/decision'
import { decodeDefaultIntradayMomentumProtocol } from './strategy/intraday-momentum/protocol'
import {
  buildMutationShadowCycleDecision,
  buildClosingExecutionCycleDecision,
  makeClosingDecisionPlan,
  buildObserveCycleDecision,
  appendPendingMutationOrder,
  countOpenPositions,
  decideExecutionCycleCloseDocument,
  decideReconciledExecutionCycleCompletion,
  decideReconciledExecutionCycleTerminalization,
  decidePendingMutationObservation,
  decideExecutionCycleCompletion,
  decideExecutionIntentTerminalDisposition,
  decidePreparedMutationIntent,
  decidePreparedCloseIntentAdmission,
  decidePreparedMutationIntentAdmission,
  decidePreparedMutationRecovery,
  decideMutationIntentSettlement,
  executeMutationIntent,
  expiredExecutionPlanTerminalReason,
  mutationRecoveryIsDue,
  mutationIntentReconciliationDelayMs,
  executionSubmitExpiresAt,
  executionMutationSubmissionAllowed,
  isExecutionCycleReconciledFlat,
  executionCycleHasFilledIntent,
  executionClosePlanNeedsResidualReplan,
  prepareNextMutationIntent,
  projectWorstCasePendingMutationPosition,
  loadObserveRiskPolicy,
  loadQuoteBoundExecutionRiskPolicy,
  loadStrategyExecutionRiskPolicy,
  makeMutationAutonomousCycleStartup as makeMutationAutonomousCycleStartupProduction,
  makeObserveAutonomousCycleStartup as makeObserveAutonomousCycleStartupProduction,
  prepareObserveStartup,
  prepareObservePlanner,
  recoveryFirstCycleNextDelayMs,
  terminalizeBlockedExecutionCycle,
  type MutationAutonomousCycleInput,
  type ObserveAutonomousCycleInput,
  type RecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverOwner,
} from './observe-composition'
import { ExecutionCloseAwaitingMarketData } from './observe-composition/decision-builder'
import {
  AccountStatus,
  Authority,
  IntentState,
  KillState,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  type AccountSnapshot,
  type Intent,
  type Order,
  type Position,
  type Reconciliation,
} from './execution/contracts'
import { ReconciliationError, type ReconciliationPassResult } from './reconciler'
import { reconciledStateHash } from './reconciliation'
import { Reason, type Policy } from './risk'
import { decodeExecutionDecisionDocument, makeExecutionDecisionDocument } from './shadow-decision-contract'
import { decodeTargetPlanResult, TargetPlanStatus } from './target-planner'
import { fixtureProtocol, makeSnapshot, makeTestDefinition } from './test-fixtures'
import { utcInstantFromEpochMillis } from './time'
import type { DecisionPlan, IsoDate } from './types'

const signalDate = '2020-04-30'
const executionDate = '2020-05-01'
const accountId = 'paper-account-1'
const snapshotId = '7'.repeat(64)
const generationHash = 'a'.repeat(64)
const accountingHash = 'b'.repeat(64)
const reconciledAt = '2020-05-01T12:45:01.000Z'
const evaluatedAt = '2020-05-01T12:45:02.000Z'

const ownRecoveryFirstCycleInTestProcess: RecoveryFirstCycleDriverOwner = (driver) => {
  const run = (): ReturnType<RecoveryFirstCycleDriverOwner> =>
    Effect.suspend(() =>
      driver.advance.pipe(
        Effect.flatMap((advance) => Effect.sleep(Duration.millis(advance.nextDelayMs ?? driver.nextDelayMs))),
        Effect.catch((restrictionError) => Effect.die(restrictionError)),
        Effect.andThen(run()),
      ),
    )
  return run()
}

const makeObserveAutonomousCycleStartup =
  (input: ObserveAutonomousCycleInput, owner: RecoveryFirstCycleDriverOwner = ownRecoveryFirstCycleInTestProcess) =>
  (startup: Parameters<ReturnType<typeof makeObserveAutonomousCycleStartupProduction>>[0]) =>
    makeObserveAutonomousCycleStartupProduction(input)(startup).pipe(
      Effect.map((driver) => driver.pipe(Effect.flatMap(owner))),
    )

const makeMutationAutonomousCycleStartup =
  (input: MutationAutonomousCycleInput, owner: RecoveryFirstCycleDriverOwner = ownRecoveryFirstCycleInTestProcess) =>
  (startup: Parameters<ReturnType<typeof makeMutationAutonomousCycleStartupProduction>>[0]) =>
    makeMutationAutonomousCycleStartupProduction(input)(startup).pipe(
      Effect.map((driver) => driver.pipe(Effect.flatMap(owner))),
    )

test('Restate scheduling never waits past the reconciliation cadence', () => {
  expect(recoveryFirstCycleNextDelayMs({ pollIntervalMs: 300_000, reconciliationIntervalMs: 30_000 })).toBe(30_000)
  expect(recoveryFirstCycleNextDelayMs({ pollIntervalMs: 15_000, reconciliationIntervalMs: 30_000 })).toBe(15_000)
})

test('PAPER submissions obey separate entry and final close-session cutoffs', () => {
  expect(
    executionMutationSubmissionAllowed({
      capability: 'Mutation',
      closeOnly: false,
      executionMandateCutoffAt: '2020-05-01T13:00:00.000Z',
      observedAt: '2020-05-01T12:59:59.000Z',
    }),
  ).toBe(true)
  expect(
    executionMutationSubmissionAllowed({
      capability: 'Mutation',
      closeOnly: false,
      executionMandateCutoffAt: '2020-05-01T13:00:00.000Z',
      observedAt: '2020-05-01T13:00:00.000Z',
    }),
  ).toBe(false)
  expect(
    executionMutationSubmissionAllowed({
      capability: 'Mutation',
      closeOnly: true,
      executionMandateCutoffAt: '2020-05-01T13:00:00.000Z',
      executionMandateCloseSubmitCutoffAt: '2020-05-03T20:00:00.000Z',
      observedAt: '2020-05-01T13:05:00.000Z',
    }),
  ).toBe(true)
  expect(
    executionMutationSubmissionAllowed({
      capability: 'Mutation',
      closeOnly: true,
      executionMandateCutoffAt: '2020-05-01T13:00:00.000Z',
      executionMandateCloseSubmitCutoffAt: '2020-05-03T20:00:00.000Z',
      observedAt: '2020-05-03T20:00:00.000Z',
    }),
  ).toBe(false)
})

test('requires a bounded residual close replan after a settled close leaves a position open', () => {
  expect(executionClosePlanNeedsResidualReplan([{ state: IntentState.Terminal }], 1)).toBe(true)
  expect(executionClosePlanNeedsResidualReplan([{ state: IntentState.Acknowledged }], 1)).toBe(false)
  expect(executionClosePlanNeedsResidualReplan([{ state: IntentState.Terminal }], 0)).toBe(false)
})

const calendarMaterial = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: signalDate, end: '2020-05-30' },
  timeZone: 'UTC' as const,
  sessions: [
    {
      date: signalDate,
      openAt: '2020-04-30T13:30:00.000Z',
      closeAt: '2020-04-30T20:00:00.000Z',
    },
    {
      date: executionDate,
      openAt: '2020-05-01T13:30:00.000Z',
      closeAt: '2020-05-01T20:00:00.000Z',
    },
  ],
} as const

const calendar: MarketCalendarObservation = {
  ...calendarMaterial,
  normalizedResponseHash: canonicalHashV1(calendarMaterial),
}

const executionPolicyResult = makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel)
expect(Result.isSuccess(executionPolicyResult)).toBe(true)
if (Result.isFailure(executionPolicyResult)) {
  expect.unreachable(executionPolicyResult.failure.message)
}
const executionPolicy = executionPolicyResult.success

const executionCalendarResult = makeExecutionCalendarObservation({
  schemaVersion: calendar.schemaVersion,
  source: calendar.source,
  ...calendar.sessions[1],
})
expect(Result.isSuccess(executionCalendarResult)).toBe(true)
if (Result.isFailure(executionCalendarResult)) {
  expect.unreachable(executionCalendarResult.failure.message)
}
const executionCalendar = executionCalendarResult.success

const identityResult = makeCycleIdentity({
  schemaVersion: 'bayn.autonomous-cycle-identity.v1',
  strategyName: 'risk-balanced-trend',
  qualificationRunId: 'c'.repeat(64),
  strategyProtocolHash: 'd'.repeat(64),
  accountId,
  signalSessionDate: signalDate,
  signalCalendarVersion: 'fixture-calendar-v2',
  executionSessionDate: executionDate,
  executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
  executionCalendarSource: executionCalendar.executionCalendarSource,
  executionCalendarHash: executionCalendar.executionCalendarHash,
  executionPolicy,
})
expect(Result.isSuccess(identityResult)).toBe(true)
if (Result.isFailure(identityResult)) {
  expect.unreachable(identityResult.failure.message)
}
const identity = identityResult.success

const windowResult = makeCycleWindow(
  {
    calendar_version: 'fixture-calendar-v2',
    session_date: signalDate,
    close_time: '16:00',
    timezone: 'America/New_York',
  },
  executionCalendar,
  executionPolicy,
)
expect(Result.isSuccess(windowResult)).toBe(true)
if (Result.isFailure(windowResult)) {
  expect.unreachable(windowResult.failure.message)
}
const window = windowResult.success

const draftResult = makeCycleDraft(identity, window)
expect(Result.isSuccess(draftResult)).toBe(true)
if (Result.isFailure(draftResult)) {
  expect.unreachable(draftResult.failure.message)
}
const draft = draftResult.success
const cycle = Effect.runSync(
  decodeAutonomousCycle({
    ...draft,
    state: CycleState.Active,
    bindings: { snapshotId },
    stateVersion: 3,
    createdAt: '2020-05-01T12:44:00.000Z',
    updatedAt: window.submissionOpenAt,
  }),
)

const sourceSnapshot = makeSnapshot(1_129)
const { hash: _sourceManifestHash, ...sourceManifestMaterial } = sourceSnapshot.manifest
const snapshotManifest = {
  ...sourceManifestMaterial,
  finalizedSnapshot: {
    ...sourceManifestMaterial.finalizedSnapshot,
    snapshotId,
    finalizedAt: '2020-04-30T22:00:00.000Z',
  },
} as const
const snapshot: MarketDataSnapshot = {
  bars: sourceSnapshot.bars,
  manifest: { ...snapshotManifest, hash: canonicalHashV1(snapshotManifest) },
}

const intradayArchiveTopics = {
  bars: 'torghut.bars.1m.v1',
  quotes: 'torghut.quotes.v1',
  trades: 'torghut.trades.v1',
} as const

const intradaySnapshot = (protocol: OpeningDriveProtocol, request: IntradaySnapshotRequest): IntradayMarketSnapshot => {
  const rangeStartEpoch = Date.parse(request.rangeStartAt)
  const rangeMinutes = (Date.parse(request.rangeEndAt) - rangeStartEpoch) / 60_000
  const identity = (
    symbol: string,
    sourceTopic: string,
    sourceOffset: number,
    eventAt: string,
    ingestedAt: string = request.observedAt,
  ) => ({
    provider: 'alpaca' as const,
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    feed: protocol.feed,
    marketSession: 'regular' as const,
    delayClass: protocol.delayClass,
    symbol,
    eventAt,
    ingestedAt,
    sourceTopic,
    sourcePartition: 0,
    sourceOffset: String(sourceOffset),
    schemaVersion: 1 as const,
  })
  const compareRecords = (left: { eventAt: string; symbol: string }, right: { eventAt: string; symbol: string }) =>
    left.eventAt.localeCompare(right.eventAt) || left.symbol.localeCompare(right.symbol)
  const bars = protocol.universe
    .flatMap((symbol, symbolIndex) =>
      Array.from({ length: rangeMinutes }, (_, minute) => ({
        ...identity(
          symbol,
          intradayArchiveTopics.bars,
          symbolIndex * rangeMinutes + minute + 1,
          utcInstantFromEpochMillis(rangeStartEpoch + minute * 60_000),
          utcInstantFromEpochMillis(rangeStartEpoch + (minute + 1) * 60_000),
        ),
        channel: 'bars' as const,
        final: true,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1_000,
        vwap: 100,
        tradeCount: '100',
      })),
    )
    .toSorted(compareRecords)
  const quoteAt = utcInstantFromEpochMillis(Date.parse(request.rangeEndAt) + 500)
  const quotes = protocol.universe
    .map((symbol, index) => ({
      ...identity(symbol, intradayArchiveTopics.quotes, index + 1, quoteAt),
      bidPrice: 99.99,
      bidSize: 100,
      askPrice: 100.01,
      askSize: 100,
    }))
    .toSorted(compareRecords)
  const tradeAt = utcInstantFromEpochMillis(Date.parse(request.rangeEndAt) + 400)
  const trades = protocol.universe
    .map((symbol, index) => ({
      ...identity(symbol, intradayArchiveTopics.trades, index + 1, tradeAt),
      price: 100,
      size: 10,
    }))
    .toSorted(compareRecords)
  const lineage = Object.values(intradayArchiveTopics)
    .sort()
    .map((sourceTopic) => ({
      sourceTopic,
      sourcePartition: 0,
      firstOffset: '1',
      lastOffset: String(sourceTopic === intradayArchiveTopics.bars ? bars.length : protocol.universe.length),
      recordCount: sourceTopic === intradayArchiveTopics.bars ? bars.length : protocol.universe.length,
    }))
  const material = {
    schemaVersion: 'bayn.intraday-market-snapshot.v1' as const,
    sessionDate: request.sessionDate,
    calendar: request.calendar,
    rangeStartAt: request.rangeStartAt,
    rangeEndAt: request.rangeEndAt,
    observedAt: request.observedAt,
    universeId: request.universeId,
    universeSymbolHash: request.universeSymbolHash,
    ...(request.purpose === undefined ? {} : { universe: request.universe }),
    symbols: [...(request.symbols ?? request.universe)].sort(),
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    feed: request.feed,
    delayClass: request.delayClass,
    sourceTopics: request.sourceTopics,
    archiveWatermarks: [...request.archiveWatermarks].sort((left, right) =>
      left.sourceTopic.localeCompare(right.sourceTopic),
    ),
    maximumQuoteAgeMs: request.maximumQuoteAgeMs,
    minimumWatermarkLagMs: request.minimumWatermarkLagMs,
    barCount: bars.length,
    quoteCount: quotes.length,
    tradeCount: trades.length,
    barsContentHash: canonicalHashV1(bars),
    quotesContentHash: canonicalHashV1(quotes),
    tradesContentHash: canonicalHashV1(trades),
    lineage,
  }
  const contentHash = canonicalHashV1(material)
  return {
    bars,
    quotes,
    trades,
    latestQuotes: Object.fromEntries(quotes.map((quote) => [quote.symbol, quote])),
    manifest: {
      ...material,
      contentHash,
      snapshotId: canonicalHashV1({ ...material, contentHash }),
    },
  }
}

const intradayMarketData = (protocol: OpeningDriveProtocol): IntradayMarketDataService => ({
  captureVersion: () =>
    Effect.succeed(
      Object.values(intradayArchiveTopics)
        .sort()
        .map((sourceTopic) => ({
          sourceTopic,
          sourcePartition: 0,
          inclusiveLastOffset: String(protocol.universe.length * protocol.openingRangeMinutes),
        })),
    ),
  loadSnapshot: (request) =>
    Effect.succeed(intradaySnapshot(protocol, request) as ArchiveVerifiedIntradayMarketSnapshot),
  verifyArchiveSnapshot: (snapshot) => Effect.succeed(snapshot as ArchiveVerifiedIntradayMarketSnapshot),
})

const account: AccountSnapshot = {
  schemaVersion: 'bayn.paper-account-snapshot.v1',
  accountId,
  status: AccountStatus.Active,
  currency: 'USD',
  cashMicros: '1000000000',
  equityMicros: '1000000000',
  buyingPowerMicros: '1000000000',
  observedAt: reconciledAt,
}

const reconciliation = (
  positions: readonly Position[] = [],
  orders: readonly Order[] = [],
  brokerAccount: AccountSnapshot = account,
): Reconciliation => {
  const stateHash = Result.getOrThrow(
    reconciledStateHash({
      account: brokerAccount,
      positions,
      positionsObservedAt: reconciledAt,
      orders,
      ordersObservedAt: reconciledAt,
      accountingHash,
    }),
  )
  const material = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt,
  }
  const reconciliationId = canonicalHashV1({
    schemaVersion: 'bayn.paper-reconciliation-id.v1',
    material,
  })
  return {
    ...material,
    reconciliationId,
    contentHash: canonicalHashV1({ ...material, reconciliationId }),
  }
}

const reconciliationResult = (
  authorityGenerationHash = generationHash,
  maximum: Authority = Authority.Observe,
  positions: readonly Position[] = [],
  orders: readonly Order[] = [],
  brokerAccount: AccountSnapshot = account,
): ReconciliationPassResult => {
  const exact = reconciliation(positions, orders, brokerAccount)
  return {
    report: {
      reconciliation: exact,
      metrics: {
        brokerPollAgeMs: 0,
        oldestUnknownMutationAgeMs: 0,
        cashDifferenceMicros: '0',
        positionDifferenceMicros: '0',
        equityDifferenceMicros: '0',
        accountingExact: true,
        discrepancyCount: 0,
      },
    },
    brokerState: {
      account: brokerAccount,
      positions,
      positionsObservedAt: reconciledAt,
      orders,
      ordersObservedAt: reconciledAt,
      accountingHash,
      reconciliation: exact,
      unknownOrderCount: 0,
    },
    riskContext: {
      tradingDate: executionDate,
      authority: {
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: authorityGenerationHash,
        maximum,
        effective: maximum,
        kill: KillState.Clear,
        version: 1,
        updatedAt: window.submissionOpenAt,
      },
      authorityObservedAt: reconciledAt,
      unknownMutationCount: 0,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: brokerAccount.equityMicros,
      peakEquityMicros: brokerAccount.equityMicros,
    },
  }
}

const targetWeights = Object.fromEntries(
  fixtureProtocol.universe.map((symbol, index) => [symbol, index === 0 ? 0.5 : 0]),
)
const decision: DecisionPlan = {
  schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
  signalDate,
  covarianceWindow: {
    returnCount: 1,
    firstSession: signalDate,
    lastSession: signalDate,
    sessionsHash: 'e'.repeat(64),
  },
  estimatedAnnualizedPortfolioVolatility: 0.1,
  exposureScale: 1,
  targetWeights,
  signals: fixtureProtocol.universe.map((symbol, index) => ({
    symbol,
    horizons: [{ horizonSessions: 1, return: index === 0 ? 0.1 : 0, normalizedTrend: index === 0 ? 1 : 0 }],
    dailyVolatility: 0.1,
    annualizedVolatility: 0.1,
    compositeScore: index === 0 ? 1 : 0,
    positiveScore: index === 0 ? 1 : 0,
    eligible: true,
    uncappedWeight: index === 0 ? 0.5 : 0,
    cappedWeight: index === 0 ? 0.5 : 0,
    targetWeight: index === 0 ? 0.5 : 0,
  })),
}

const partialFillDecision: DecisionPlan = {
  ...decision,
  targetWeights: Object.fromEntries(fixtureProtocol.universe.map((symbol, index) => [symbol, index < 2 ? 0.1 : 0])),
}
const runtimeWithDecision = (decide: typeof fixtureRuntime.definition.decide) => ({
  definition: makeTestDefinition(fixtureProtocol, decide),
  provenance: fixtureRuntime.provenance,
})

const marketData = (requests: unknown[]): MarketDataService => ({
  check: Effect.die(new Error('decision building must not run the static snapshot check')),
  inspect: Effect.die(new Error('decision building must not inspect the static snapshot')),
  inspectCyclePublications: Effect.die(new Error('decision building must not discover publications')),
  inspectPublication: () => Effect.die(new Error('decision building must not inspect another publication')),
  inspectSnapshotPublication: () => Effect.die(new Error('decision building must not re-inspect metadata')),
  loadSnapshotPublication: (request) =>
    Effect.sync(() => {
      requests.push(request)
      return snapshot
    }),
  load: Effect.die(new Error('decision building must not load the static qualification snapshot')),
})

const calendarRead =
  (
    queries: unknown[],
  ): ((query: {
    readonly start: string
    readonly end: string
  }) => Effect.Effect<ReadResult<MarketCalendarObservation>>) =>
  (query) =>
    Effect.sync(() => {
      queries.push(query)
      return {
        value: calendar,
        evidence: {
          requestId: 'calendar-request',
          status: 200,
          contentHash: 'f'.repeat(64),
          observedAt: reconciledAt,
        },
      }
    })

const decisionBrokerRead = (marketCalendar: BrokerReadShape['marketCalendar']): BrokerReadShape => {
  const unused = Effect.die(new Error('decision building must not use unrelated broker reads'))
  return {
    account: unused,
    accountConfiguration: unused,
    assetBySymbol: unusedAssetBySymbol,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    fillActivities: () => unused,
    marketCalendar,
  }
}

const provideDecisionServices = <A, E>(
  program: Effect.Effect<A, E, BrokerRead | MarketData>,
  marketDataService: MarketDataService,
  marketCalendar: BrokerReadShape['marketCalendar'],
): Effect.Effect<A, E> =>
  program.pipe(
    Effect.provideService(BrokerRead, decisionBrokerRead(marketCalendar)),
    Effect.provideService(MarketData, marketDataService),
  )

const makeExactReconciliationServices = () => {
  const exact = reconciliationResult()
  const authority = exact.riskContext.authority
  if (authority === null) throw new Error('exact reconciliation fixture requires durable authority')
  const evidence = (identity: string): ReadEvidence => ({
    requestId: `exact-reconciliation-${identity}`,
    status: 200,
    contentHash: canonicalHashV1({ identity }),
    observedAt: reconciledAt,
  })
  const brokerAccount: BrokerAccount = {
    id: accountId,
    status: BrokerAccountStatus.Active,
    currency: 'USD',
    cashMicros: account.cashMicros,
    equityMicros: account.equityMicros,
    lastEquityMicros: account.equityMicros,
    buyingPowerMicros: account.buyingPowerMicros,
    accountBlocked: false,
    tradingBlocked: false,
    tradeSuspendedByUser: false,
    observedAt: reconciledAt,
  }
  const unusedRead = Effect.die(new Error('exact reconciliation used an unrelated broker capability'))
  const brokerRead: BrokerReadShape = {
    account: Effect.succeed({ value: brokerAccount, evidence: evidence('account') }),
    accountConfiguration: unusedRead,
    assetBySymbol: unusedAssetBySymbol,
    positions: Effect.succeed({ value: [], evidence: evidence('positions') }),
    orders: () => Effect.succeed({ value: [], evidence: evidence('orders') }),
    orderById: () => unusedRead,
    orderByClientId: () => unusedRead,
    fillActivities: () => Effect.succeed({ value: { items: [] }, evidence: evidence('fills') }),
    marketCalendar: () => unusedRead,
  }
  const persisted: ReconciliationWriteResult = {
    reconciliation: exact.report.reconciliation,
    metrics: exact.report.metrics,
    accountingHash: exact.brokerState.accountingHash,
    riskContext: exact.riskContext,
  }
  const unusedAccounting = Effect.die(new Error('empty exact reconciliation must not account a fill'))
  const executionStore = {
    ingest: () => Effect.succeed({ eventId: '1'.repeat(64), sourceSequence: '1', deduplicated: false }),
    ingestPositions: () => Effect.succeed({ snapshotId: '2'.repeat(64), eventIds: [], deduplicated: false }),
    account: () => unusedAccounting,
    value: () =>
      Effect.succeed({
        schemaVersion: 'bayn.paper-valuation.v1' as const,
        valuationId: '3'.repeat(64),
        accountId,
        sourceHash: '4'.repeat(64),
        cashMicros: account.cashMicros,
        longMarketValueMicros: '0',
        shortMarketValueMicros: '0',
        equityMicros: account.equityMicros,
        asOf: reconciledAt,
      }),
    hasAccountBaseline: () => Effect.succeed(true),
    bindings: () => Effect.succeed([]),
    reconcile: () => Effect.succeed(persisted),
    ensureAuthorityGeneration: () => Effect.succeed(authority),
    restrictAuthority: () => Effect.die(new Error('exact reconciliation unexpectedly restricted authority')),
  } satisfies BrokerEventStoreShape &
    FillAccountingStoreShape &
    ValuationStoreShape &
    ReconciliationStoreShape &
    AuthorityGenerationStoreShape &
    AuthorityRestrictionStoreShape
  const writerFence: WriterFenceService = {
    backendPid: 1,
    check: Effect.void,
    transaction: (effect) => effect,
  }
  return { brokerRead, executionStore, writerFence }
}

const sandboxExecutionProgram = (
  authorityGenerationHash = generationHash,
  strategy = fixtureRuntime.provenance.strategy,
): ExecutionProgram => {
  const brokerIdentity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId,
    }),
  )
  const authority = Result.getOrThrow(
    makeExecutionAuthority({
      brokerIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: grantedCapitalAuthority(authorityGenerationHash),
      strategy,
      observedAt: evaluatedAt,
    }),
  ) as ExecutionProgram['authority']
  const unused = Effect.die(new Error('execution program operation must not run during startup validation'))
  return {
    _tag: 'ExecutionProgram',
    schemaVersion: 'bayn.execution-program.v1',
    authority,
    dryRunSubmit: () => unused,
    submit: () => unused,
    cancel: () => unused,
    recover: () => unused,
  }
}

const executionLifecycleFixture = async (
  transformPolicy: (policy: Policy) => Policy = (policy) => policy,
  strategyDecision: DecisionPlan = decision,
) => {
  const input = {
    accountId,
    authorityGenerationHash: generationHash,
    pollIntervalMs: 30_000,
    reconciliationIntervalMs: 30_000,
    reconciliationPassTimeoutMs: 30_000,
    strategy: fixtureRuntime,
    executionProgram: sandboxExecutionProgram(),
  } as const
  const preparation = Result.getOrThrow(prepareObserveStartup(input))
  const policy = transformPolicy(await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe)))
  const document = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      return yield* buildMutationShadowCycleDecision({
        authorityGenerationHash: generationHash,
        cycle,
        executionModel: fixtureProtocol.executionModel,
        policy,
        reconcile: Effect.succeed(reconciliationResult(generationHash, Authority.Execution)),
        strategy: runtimeWithDecision(() => Result.succeed(strategyDecision)),
      })
    }).pipe(
      (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
      Effect.provide(TestClock.layer()),
    ),
  )
  const boundCycle = Effect.runSync(
    decodeAutonomousCycle({
      ...cycle,
      bindings: { ...cycle.bindings, decisionHash: document.contentHash },
      stateVersion: cycle.stateVersion + 1,
      updatedAt: document.createdAt,
    }),
  )
  const intents = await Promise.all(
    document.targetPlan.intentTargets.map(async (target, index) => {
      const risk = document.deltaRisk[index]
      if (risk === undefined) throw new Error('PAPER lifecycle fixture risk binding is missing')
      return Effect.runPromise(
        planExecutionIntent(
          {
            schemaVersion: 'bayn.paper-intent-plan.v1',
            ...target,
            notionalLimitMicros: risk.notionalLimitMicros,
            createdAt: document.createdAt,
          },
          {
            authority: {
              schemaVersion: 'bayn.paper-authority.v1',
              generationHash,
              maximum: Authority.Execution,
              effective: Authority.Execution,
              kill: KillState.Clear,
              version: 1,
              updatedAt: document.createdAt,
            },
          },
        ),
      )
    }),
  )
  const intent = intents[0]
  const risk = document.deltaRisk[0]
  if (intent === undefined || risk === undefined) throw new Error('PAPER lifecycle fixture requires one planned intent')
  return { boundCycle, document, input, intent, intents, policy, preparation, risk }
}

const reconciliationResultAt = (
  observedAt: string,
  unknownMutationCount = 0,
  unknownOrderCount = 0,
  positions: readonly Position[] = [],
  orders: readonly Order[] = [],
  effectiveAuthority: Authority = Authority.Execution,
): ReconciliationPassResult => {
  const result = reconciliationResult(generationHash, Authority.Execution, positions, orders)
  const authority = result.riskContext.authority
  if (authority === null) throw new Error('post-cutoff reconciliation fixture requires PAPER authority')
  const account = { ...result.brokerState.account, observedAt }
  const stateHash = Result.getOrThrow(
    reconciledStateHash({
      account,
      positions,
      positionsObservedAt: observedAt,
      orders,
      ordersObservedAt: observedAt,
      accountingHash,
    }),
  )
  const material = {
    ...result.report.reconciliation,
    expectedHash: stateHash,
    observedHash: stateHash,
    reconciledAt: observedAt,
  }
  const reconciliationId = canonicalHashV1({
    schemaVersion: 'bayn.paper-reconciliation-id.v1',
    material,
  })
  const exact = {
    ...material,
    reconciliationId,
    contentHash: canonicalHashV1({ ...material, reconciliationId }),
  }
  return {
    report: {
      ...result.report,
      reconciliation: exact,
    },
    brokerState: {
      ...result.brokerState,
      account,
      positionsObservedAt: observedAt,
      ordersObservedAt: observedAt,
      reconciliation: exact,
      unknownOrderCount,
    },
    riskContext: {
      tradingDate: result.riskContext.tradingDate,
      dailyTradedNotionalMicros: result.riskContext.dailyTradedNotionalMicros,
      dayStartEquityMicros: result.riskContext.dayStartEquityMicros,
      peakEquityMicros: result.riskContext.peakEquityMicros,
      authority: {
        ...authority,
        effective: effectiveAuthority,
        kill: effectiveAuthority === Authority.Execution ? KillState.Clear : KillState.Active,
      },
      authorityObservedAt: observedAt,
      unknownMutationCount,
    },
  }
}

const storedIntent = (
  intent: Intent,
  state: IntentState,
  updatedAt: string,
  terminalOutcome?: TerminalOutcome,
): StoredIntent => ({
  intent: {
    ...intent,
    state,
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
  },
  stateVersion: 2,
  updatedAt,
})

const prepareStoredExecutionStep = async (
  fixture: Awaited<ReturnType<typeof executionLifecycleFixture>>,
  record: StoredIntent,
  latest: MutationEvent | undefined,
  observedAt: string,
  unknownMutationCount = 0,
  onRestriction: (reason: string, updatedAt: string) => void = () => undefined,
  input: typeof fixture.input & {
    readonly cycleCadence?: NonNullable<ObserveAutonomousCycleInput['cycleCadence']>
    readonly mutationPhase?: 'ENTRY' | 'CLOSE'
    readonly executionMandateCutoffAt?: string
    readonly executionMandateCloseSubmitCutoffAt?: string
    readonly executionMandateExpiresAt?: string
  } = fixture.input,
  latestCancel?: MutationEvent,
  allowSubmit = true,
  policy: Policy = fixture.policy,
  preparation = fixture.preparation,
  records: ReadonlyMap<string, StoredIntent> = new Map([[record.intent.intentId, record]]),
  latestSubmits: ReadonlyMap<string, MutationEvent | undefined> = new Map([[record.intent.intentId, latest]]),
  reconciledOrders: readonly Order[] = [],
  document: typeof fixture.document = fixture.document,
  reconciledPositions: readonly Position[] = [],
  effectiveAuthority: Authority = Authority.Execution,
  drainOpenOrders = false,
) => {
  const intentStore: IntentStoreService = {
    commit: () => Effect.succeed({ record, deduplicated: true }),
    commitClosing: () => Effect.succeed({ record, deduplicated: true }),
    read: (intentId) => {
      const stored = records.get(intentId)
      return Effect.succeed(stored === undefined ? Option.none() : Option.some(stored))
    },
  }
  const mutationStore = {
    latest: (intentId: string, operation: MutationOperation) =>
      Effect.succeed(operation === MutationOperation.Submit ? latestSubmits.get(intentId) : latestCancel),
  } as unknown as MutationStoreShape
  const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
    restrictAuthority: (reason, updatedAt) => Effect.sync(() => onRestriction(reason, updatedAt)),
  }
  const writerFence: WriterFenceService = {
    backendPid: 1,
    check: Effect.void,
    transaction: (effect) => effect,
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(observedAt))
      return yield* prepareNextMutationIntent({
        input,
        preparation,
        policy,
        cycle: fixture.boundCycle,
        document,
        reconcile: Effect.succeed(
          reconciliationResultAt(
            observedAt,
            unknownMutationCount,
            0,
            reconciledPositions,
            reconciledOrders,
            effectiveAuthority,
          ),
        ),
        allowSubmit,
        drainOpenOrders,
      })
    }).pipe(
      Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
      Effect.provideService(MarketData, marketData([])),
      Effect.provideService(IntentStore, intentStore),
      Effect.provideService(MutationStore, mutationStore),
      Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
      Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
      Effect.provideService(ValuationStore, {} as ValuationStoreShape),
      Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
      Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
      Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
      Effect.provideService(WriterFence, writerFence),
      Effect.provide(TestClock.layer()),
    ),
  )
}

describe('OBSERVE runtime composition', () => {
  test('projects accepted nonterminal intents as one unresolved order for the next risk pass', () => {
    const intent: Intent = {
      schemaVersion: 'bayn.paper-intent.v3',
      intentId: '1'.repeat(64),
      authorityGenerationHash: generationHash,
      riskDecisionId: '2'.repeat(64),
      strategyName: 'risk-balanced-trend',
      cycleId: '3'.repeat(64),
      decisionHash: '4'.repeat(64),
      policyHash: '5'.repeat(64),
      accountId,
      clientOrderId: 'accepted-prior-intent',
      symbol: 'NVDA',
      side: OrderSide.Buy,
      orderType: OrderType.Market,
      timeInForce: TimeInForce.Day,
      quantityMicros: '1000000',
      notionalLimitMicros: '100000001',
      state: IntentState.Acknowledged,
      createdAt: evaluatedAt,
    }
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '6'.repeat(64),
      mutationId: '7'.repeat(64),
      intentId: intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: canonicalHashV1(Result.getOrThrow(orderRequestBody(intent))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'accepted-broker-order',
      occurredAt: evaluatedAt,
    }
    const decision = Result.getOrThrow(decidePreparedMutationIntent(intent, accepted))
    expect(decision._tag).toBe('Pending')
    if (decision._tag !== 'Pending') return expect.unreachable(decision._tag)
    expect(decision.order).toMatchObject({
      brokerOrderId: accepted.brokerOrderId,
      clientOrderId: intent.clientOrderId,
      intentId: intent.intentId,
      orderType: OrderType.Market,
      notionalMicros: '100000000',
      status: OrderStatus.New,
      filledQuantityMicros: '0',
    })
    const projected = appendPendingMutationOrder([], decision.order)
    expect(projected).toEqual([decision.order])
    expect(appendPendingMutationOrder(projected, decision.order)).toBe(projected)

    const reconciledOrder: Order = {
      ...decision.order,
      observedAt: utcInstantFromEpochMillis(Date.parse(evaluatedAt) + 1_000),
    }
    expect(Result.getOrThrow(decidePendingMutationObservation(decision.order, [reconciledOrder]))).toEqual({
      _tag: 'StableOpen',
      order: reconciledOrder,
    })
    expect(
      Result.getOrThrow(
        decidePendingMutationObservation(decision.order, [
          { ...reconciledOrder, status: OrderStatus.Filled, filledQuantityMicros: intent.quantityMicros },
        ]),
      ),
    ).toMatchObject({ _tag: 'Recover', reason: 'terminal' })
    expect(Result.getOrThrow(decidePendingMutationObservation(decision.order, []))).toEqual({
      _tag: 'Recover',
      reason: 'missing',
    })
    expect(
      Result.isFailure(decidePendingMutationObservation(decision.order, [{ ...reconciledOrder, symbol: 'AMD' }])),
    ).toBe(true)
    expect(
      Result.isFailure(
        decidePendingMutationObservation(decision.order, [
          {
            ...reconciledOrder,
            notionalMicros: (BigInt(reconciledOrder.notionalMicros ?? '0') + 1n).toString(),
          },
        ]),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decidePendingMutationObservation(decision.order, [
          reconciledOrder,
          { ...reconciledOrder, brokerOrderId: 'conflicting-order' },
        ]),
      ),
    ).toBe(true)
  })

  test('continues to the next approved intent while an earlier acknowledged order is stably open', async () => {
    const fixture = await executionLifecycleFixture((policy) => policy, partialFillDecision)
    const first = fixture.intents[0]
    const second = fixture.intents[1]
    const secondRisk = fixture.document.deltaRisk[1]
    if (first === undefined || second === undefined || secondRisk === undefined) {
      return expect.unreachable('fixture requires two intents and risk bindings')
    }
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: first.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: canonicalHashV1(Result.getOrThrow(orderRequestBody(first))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'stable-open-order',
      occurredAt: fixture.document.createdAt,
    }
    const pending = Result.getOrThrow(decidePreparedMutationIntent(first, accepted))
    if (pending._tag !== 'Pending') return expect.unreachable('accepted intent must be pending')
    const observedAt = utcInstantFromEpochMillis(Date.parse(accepted.occurredAt) + accepted.consistencyDelayMs)
    const reconciledOrder: Order = {
      ...pending.order,
      observedAt,
    }
    const firstRecord = storedIntent(first, IntentState.Acknowledged, accepted.occurredAt)
    const secondRecord = storedIntent(second, IntentState.Approved, accepted.occurredAt)
    const records = new Map([
      [first.intentId, firstRecord],
      [second.intentId, secondRecord],
    ])
    const latestSubmits = new Map<string, MutationEvent | undefined>([
      [first.intentId, accepted],
      [second.intentId, undefined],
    ])

    const step = await prepareStoredExecutionStep(
      fixture,
      firstRecord,
      accepted,
      observedAt,
      0,
      () => undefined,
      fixture.input,
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      records,
      latestSubmits,
      [reconciledOrder],
    )

    expect(step).toEqual({
      _tag: 'Execute',
      action: 'SUBMIT',
      intentId: second.intentId,
      observedAt,
      submitExpiresAt: secondRisk.evaluation.decision.expiresAt,
    })
  })

  test('caps a fresh entry submission at the daily close start', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1_000)
    const dailyCloseStartAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 30_000)
    const step = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Planned, fixture.document.createdAt),
      undefined,
      observedAt,
      0,
      () => undefined,
      { ...fixture.input, executionMandateCutoffAt: dailyCloseStartAt },
    )

    expect(step).toMatchObject({
      _tag: 'Execute',
      action: 'SUBMIT',
      intentId: fixture.intent.intentId,
      submitExpiresAt: dailyCloseStartAt,
    })
  })

  test('drains a legacy open entry order when every-session execution rejects its multi-session strategy', async () => {
    const fixture = await executionLifecycleFixture()
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: canonicalHashV1(Result.getOrThrow(orderRequestBody(fixture.intent))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'entry-order-to-cancel',
      occurredAt: fixture.document.createdAt,
    }
    const pending = Result.getOrThrow(decidePreparedMutationIntent(fixture.intent, accepted))
    if (pending._tag !== 'Pending') return expect.unreachable('accepted entry intent must be pending')
    const observedAt = utcInstantFromEpochMillis(Date.parse(accepted.occurredAt) + accepted.consistencyDelayMs)
    const step = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Acknowledged, accepted.occurredAt),
      accepted,
      observedAt,
      0,
      () => undefined,
      { ...fixture.input, cycleCadence: 'EVERY_SESSION' },
      undefined,
      false,
      fixture.policy,
      fixture.preparation,
      undefined,
      undefined,
      [{ ...pending.order, observedAt }],
      fixture.document,
      [],
      Authority.Execution,
      true,
    )

    expect(step).toEqual({
      _tag: 'Execute',
      action: 'CANCEL',
      intentId: fixture.intent.intentId,
      observedAt,
    })
  })

  test('defers an expired untouched remainder while an earlier acknowledged order is stably open', async () => {
    const fixture = await executionLifecycleFixture((policy) => policy, partialFillDecision)
    const first = fixture.intents[0]
    const second = fixture.intents[1]
    if (first === undefined || second === undefined) {
      return expect.unreachable('fixture requires two intents')
    }
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '4'.repeat(64),
      mutationId: '5'.repeat(64),
      intentId: first.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: canonicalHashV1(Result.getOrThrow(orderRequestBody(first))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'stable-open-after-cutoff',
      occurredAt: fixture.document.createdAt,
    }
    const pending = Result.getOrThrow(decidePreparedMutationIntent(first, accepted))
    if (pending._tag !== 'Pending') return expect.unreachable('accepted intent must be pending')
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const firstRecord = storedIntent(first, IntentState.Acknowledged, accepted.occurredAt)
    const secondRecord = storedIntent(second, IntentState.Approved, accepted.occurredAt)

    const step = await prepareStoredExecutionStep(
      fixture,
      firstRecord,
      accepted,
      observedAt,
      0,
      () => undefined,
      fixture.input,
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      new Map([
        [first.intentId, firstRecord],
        [second.intentId, secondRecord],
      ]),
      new Map<string, MutationEvent | undefined>([
        [first.intentId, accepted],
        [second.intentId, undefined],
      ]),
      [{ ...pending.order, observedAt }],
    )

    expect(step).toEqual({ _tag: 'Wait', observedAt })
  })

  test('uses a settled unsuccessful predecessor instead of an expired untouched remainder as the terminal cause', async () => {
    const fixture = await executionLifecycleFixture((policy) => policy, partialFillDecision)
    const first = fixture.intents[0]
    const second = fixture.intents[1]
    if (first === undefined || second === undefined) {
      return expect.unreachable('fixture requires two intents')
    }
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const firstRecord = storedIntent(
      { ...first, state: IntentState.Terminal, terminalOutcome: TerminalOutcome.Rejected },
      IntentState.Terminal,
      observedAt,
    )
    const secondRecord = storedIntent(second, IntentState.Approved, fixture.document.createdAt)

    const step = await prepareStoredExecutionStep(
      fixture,
      firstRecord,
      undefined,
      observedAt,
      0,
      () => undefined,
      fixture.input,
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      new Map([
        [first.intentId, firstRecord],
        [second.intentId, secondRecord],
      ]),
      new Map<string, MutationEvent | undefined>([
        [first.intentId, undefined],
        [second.intentId, undefined],
      ]),
    )

    expect(step).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.Risk,
      observedAt,
    })
  })

  test('executes unsubmitted intents and skips terminal intents in fresh mutation passes', () => {
    const base: Intent = {
      schemaVersion: 'bayn.paper-intent.v3',
      intentId: '9'.repeat(64),
      authorityGenerationHash: generationHash,
      strategyName: 'risk-balanced-trend',
      cycleId: 'a'.repeat(64),
      decisionHash: 'b'.repeat(64),
      policyHash: 'c'.repeat(64),
      accountId,
      clientOrderId: 'fresh-pass-intent',
      symbol: 'AMD',
      side: OrderSide.Buy,
      orderType: OrderType.Market,
      timeInForce: TimeInForce.Day,
      quantityMicros: '1000000',
      notionalLimitMicros: '100000000',
      state: IntentState.Planned,
      createdAt: evaluatedAt,
    }

    expect(Result.getOrThrow(decidePreparedMutationIntent(base, undefined))).toEqual({ _tag: 'Submit' })
    expect(
      Result.getOrThrow(
        decidePreparedMutationIntent(
          { ...base, state: IntentState.Terminal, terminalOutcome: TerminalOutcome.Filled },
          undefined,
        ),
      ),
    ).toEqual({ _tag: 'SkipTerminal' })
  })

  test('allows lookup recovery after authority restriction and cutoff while forbidding every fresh submit', () => {
    const recover = {
      _tag: 'Recover' as const,
      eventType: MutationEventType.SubmitUnknown,
    }
    expect(
      Result.isSuccess(
        decidePreparedMutationIntentAdmission(
          recover,
          Authority.Observe,
          cycle.window.submissionCutoffAt,
          cycle.window.submissionCutoffAt,
          1,
        ),
      ),
    ).toBe(true)

    const submit = { _tag: 'Submit' as const }
    expect(
      Result.isSuccess(
        decidePreparedCloseIntentAdmission(
          submit,
          evaluatedAt,
          cycle.window.submissionCutoffAt,
          0,
          ReconciliationStatus.Exact,
          true,
          0,
        ),
      ),
    ).toBe(true)
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedCloseIntentAdmission(
            submit,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            0,
            ReconciliationStatus.Discrepancy,
          ),
        ),
      )?.reason,
    ).toBe('reconciliation-not-exact')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Observe,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            0,
          ),
        ),
      )?.reason,
    ).toBe('authority')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Execution,
            cycle.window.submissionCutoffAt,
            cycle.window.submissionCutoffAt,
            0,
          ),
        ),
      )?.reason,
    ).toBe('expiry')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Execution,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            1,
          ),
        ),
      )?.reason,
    ).toBe('unknown-mutation')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Execution,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            0,
            ReconciliationStatus.Discrepancy,
          ),
        ),
      )?.reason,
    ).toBe('reconciliation-not-exact')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Execution,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            0,
            ReconciliationStatus.Exact,
            false,
          ),
        ),
      )?.reason,
    ).toBe('accounting-inexact')
    expect(
      Option.getOrUndefined(
        Result.getFailure(
          decidePreparedMutationIntentAdmission(
            submit,
            Authority.Execution,
            evaluatedAt,
            cycle.window.submissionCutoffAt,
            0,
            ReconciliationStatus.Exact,
            true,
            1,
          ),
        ),
      )?.reason,
    ).toBe('unknown-order')
  })

  test('chooses cancellation recovery before submit recovery and fresh-policy gates', async () => {
    const fixture = await executionLifecycleFixture()
    const event = (operation: MutationOperation, eventType: MutationEventType): MutationEvent => ({
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: canonicalHashV1({ operation, eventType, intentId: fixture.intent.intentId }),
      mutationId: canonicalHashV1({ operation, intentId: fixture.intent.intentId }),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation,
      eventType,
      requestHash: '1'.repeat(64),
      consistencyDelayMs: 1_000,
      occurredAt: fixture.document.createdAt,
    })

    const submit = event(MutationOperation.Submit, MutationEventType.SubmitAccepted)
    const cancel = event(MutationOperation.Cancel, MutationEventType.CancelUnknown)

    expect(Result.getOrThrow(decidePreparedMutationRecovery(fixture.intent, submit, cancel))).toEqual({
      _tag: 'Recover',
      operation: MutationOperation.Cancel,
      event: cancel,
    })
  })

  test('keeps OBSERVE recovery-only execution lookup-capable while fresh submit remains structurally unavailable', async () => {
    const fixture = await executionLifecycleFixture()
    const occurredAt = fixture.document.createdAt
    const observedAt = utcInstantFromEpochMillis(Date.parse(occurredAt) + 1_000)
    const submitUnknown: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitUnknown,
      requestHash: canonicalHashV1(Result.getOrThrow(orderRequestBody(fixture.intent))),
      consistencyDelayMs: 1_000,
      occurredAt,
    }
    const cancelUnknown: MutationEvent = {
      ...submitUnknown,
      eventId: '4'.repeat(64),
      mutationId: '5'.repeat(64),
      operation: MutationOperation.Cancel,
      eventType: MutationEventType.CancelUnknown,
      requestHash: '6'.repeat(64),
      brokerOrderId: 'recovery-only-order',
    }

    const recovery = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Unknown, occurredAt),
      submitUnknown,
      observedAt,
      1,
      () => undefined,
      fixture.input,
      cancelUnknown,
      false,
    )
    expect(recovery).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_CANCEL',
      intentId: fixture.intent.intentId,
      observedAt,
    })

    let commits = 0
    const intentStore: IntentStoreService = {
      commit: () =>
        Effect.sync(() => {
          commits += 1
          throw new Error('OBSERVE recovery-only execution must not commit a fresh PAPER intent')
        }),
      read: () => Effect.succeed(Option.none()),
    }
    const mutationStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const waiting = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* prepareNextMutationIntent({
          input: fixture.input,
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          document: fixture.document,
          reconcile: Effect.die(
            new Error('OBSERVE recovery-only execution must not reconcile before refusing fresh submit'),
          ),
          allowSubmit: false,
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(MarketData, marketData([])),
        Effect.provideService(IntentStore, intentStore),
        Effect.provideService(MutationStore, mutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(waiting).toEqual({ _tag: 'Wait', observedAt })
    expect(commits).toBe(0)
  })

  test('completes PAPER only after every intent is filled and a later exact reconciliation closes unknowns', () => {
    const intentUpdatedAt = '2020-05-01T12:45:03.000Z'
    const laterReconciliation = {
      status: ReconciliationStatus.Exact,
      reconciledAt: '2020-05-01T12:45:04.000Z',
      accountingExact: true,
      unknownMutationCount: 0,
      unknownOrderCount: 0,
    } as const
    const filled = {
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
      updatedAt: intentUpdatedAt,
      latestMutationAt: intentUpdatedAt,
    } as const

    expect(
      decideExecutionCycleCompletion(
        evaluatedAt,
        [
          {
            state: IntentState.Acknowledged,
            updatedAt: filled.updatedAt,
            latestMutationAt: filled.latestMutationAt,
          },
        ],
        laterReconciliation,
      ),
    ).toEqual({ _tag: 'Wait', reason: 'intent-nonterminal' })
    expect(
      decideExecutionCycleCompletion(
        evaluatedAt,
        [{ ...filled, terminalOutcome: TerminalOutcome.Rejected }],
        laterReconciliation,
      ),
    ).toEqual({ _tag: 'Wait', reason: 'intent-unsuccessful' })
    expect(
      decideExecutionCycleCompletion(evaluatedAt, [filled], {
        ...laterReconciliation,
        reconciledAt: intentUpdatedAt,
      }),
    ).toEqual({ _tag: 'Wait', reason: 'reconciliation-not-later' })
    expect(
      decideExecutionCycleCompletion(evaluatedAt, [filled], {
        ...laterReconciliation,
        unknownMutationCount: 1,
      }),
    ).toEqual({ _tag: 'Wait', reason: 'unknown-mutation' })
    expect(decideExecutionCycleCompletion(evaluatedAt, [filled], laterReconciliation)).toEqual({ _tag: 'Complete' })
    expect(countOpenPositions([{ quantityMicros: '0' }, { quantityMicros: '-1' }, { quantityMicros: '2' }])).toBe(2)
  })

  test('completes an entry after an exact zero-fill LIMIT/IOC cancellation without containing authority', () => {
    const intent = {
      accountId,
      clientOrderId: `b1_${'Z'.repeat(43)}`,
      intentId: '9'.repeat(64),
      orderType: OrderType.Limit,
      quantityMicros: '3000000',
      side: OrderSide.Buy,
      state: IntentState.Terminal,
      symbol: 'AMD',
      terminalOutcome: TerminalOutcome.Canceled,
      timeInForce: TimeInForce.ImmediateOrCancel,
    } as const
    const order = {
      accountId,
      brokerOrderId: 'zero-fill-ioc-order',
      clientOrderId: intent.clientOrderId,
      filledQuantityMicros: '0',
      intentId: intent.intentId,
      orderType: intent.orderType,
      quantityMicros: intent.quantityMicros,
      side: intent.side,
      status: OrderStatus.Canceled,
      symbol: intent.symbol,
      timeInForce: intent.timeInForce,
    } as const
    const dispositionInput = {
      intent,
      acceptedBrokerOrderId: order.brokerOrderId,
      orders: [order],
    } as const

    expect(decideExecutionIntentTerminalDisposition({ ...dispositionInput, phase: 'ENTRY' })).toBe(
      'BENIGN_ZERO_FILL_IOC',
    )
    expect(
      decideExecutionIntentTerminalDisposition({
        ...dispositionInput,
        phase: 'ENTRY',
        orders: [{ ...order, filledQuantityMicros: '1' }],
      }),
    ).toBe('UNSUCCESSFUL')
    expect(decideExecutionIntentTerminalDisposition({ ...dispositionInput, phase: 'CLOSE' })).toBe('UNSUCCESSFUL')
    expect(
      decideExecutionCycleCompletion(
        evaluatedAt,
        [
          {
            state: IntentState.Terminal,
            terminalOutcome: TerminalOutcome.Canceled,
            benignZeroFillIoc: true,
            updatedAt: '2020-05-01T12:45:03.000Z',
            latestMutationAt: '2020-05-01T12:45:03.000Z',
          },
        ],
        {
          status: ReconciliationStatus.Exact,
          reconciledAt: '2020-05-01T12:45:04.000Z',
          accountingExact: true,
          unknownMutationCount: 0,
          unknownOrderCount: 0,
          openPositionCount: 0,
        },
      ),
    ).toEqual({ _tag: 'Complete' })
  })

  test('completes an already-flat cycle without constructing a close plan', () => {
    const flat = {
      report: {
        reconciliation: { status: ReconciliationStatus.Exact },
        metrics: { accountingExact: true },
      },
      brokerState: {
        positions: [],
        orders: [{ status: OrderStatus.Canceled }],
        unknownOrderCount: 0,
      },
      riskContext: { unknownMutationCount: 0 },
    } as const

    expect(isExecutionCycleReconciledFlat(flat)).toBe(true)
    expect(
      isExecutionCycleReconciledFlat({
        ...flat,
        brokerState: { ...flat.brokerState, orders: [{ status: OrderStatus.Pending }] },
      }),
    ).toBe(false)
    expect(
      isExecutionCycleReconciledFlat({
        ...flat,
        brokerState: { ...flat.brokerState, positions: [{ quantityMicros: '1' }] },
      }),
    ).toBe(false)
    expect(isExecutionCycleReconciledFlat({ ...flat, riskContext: { unknownMutationCount: 1 } })).toBe(false)
  })

  test('uses the persisted reconciliation time when completing an already-flat cycle', () => {
    const reconciliationCompletedAt = '2020-05-01T12:45:04.000Z'
    const flatReconciliation = reconciliationResultAt(reconciliationCompletedAt)

    expect(decideReconciledExecutionCycleCompletion(flatReconciliation)).toEqual({
      _tag: 'Complete',
      observedAt: reconciliationCompletedAt,
    })
    expect(decideReconciledExecutionCycleTerminalization(flatReconciliation, false)).toEqual({
      _tag: 'Complete',
      observedAt: reconciliationCompletedAt,
    })
    expect(decideReconciledExecutionCycleTerminalization(flatReconciliation, true)).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.Risk,
      observedAt: reconciliationCompletedAt,
    })
  })

  test('retains an unfilled sell while reserving a later buy in projected risk positions', () => {
    const observedAt = '2026-07-28T13:45:00.000Z'
    const existing: Position = {
      schemaVersion: 'bayn.paper-position.v1',
      accountId,
      symbol: 'AAPL',
      quantityMicros: '100000000',
      averageEntryPriceMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '10000000000',
      unrealizedPnlMicros: '0',
      observedAt,
    }
    const afterSell = projectWorstCasePendingMutationPosition(
      [existing],
      {
        symbol: 'AAPL',
        targetWeight: 0.2,
        referencePriceMicros: '100000000',
        currentQuantityMicros: '100000000',
        targetQuantityMicros: '20000000',
      },
      accountId,
      observedAt,
    )
    const afterLaterBuy = projectWorstCasePendingMutationPosition(
      afterSell,
      {
        symbol: 'AMD',
        targetWeight: 0.6,
        referencePriceMicros: '50000000',
        currentQuantityMicros: '0',
        targetQuantityMicros: '60000000',
      },
      accountId,
      observedAt,
    )

    expect(afterSell).toEqual([existing])
    expect(afterLaterBuy.map(({ symbol, quantityMicros }) => ({ symbol, quantityMicros }))).toEqual([
      { symbol: 'AAPL', quantityMicros: '100000000' },
      { symbol: 'AMD', quantityMicros: '60000000' },
    ])
  })

  test('settles terminal submit denials and broker rejections so later cycles can continue', () => {
    expect(decideMutationIntentSettlement(MutationEventType.SubmitRejected)).toEqual({
      _tag: 'Settled',
      outcome: 'rejected',
    })

    expect(decideMutationIntentSettlement(MutationEventType.SubmitDenied)).toEqual({
      _tag: 'Settled',
      outcome: 'denied',
    })
    expect(decideMutationIntentSettlement(MutationEventType.SubmitUnknown)).toEqual({
      _tag: 'Unresolved',
      eventType: MutationEventType.SubmitUnknown,
    })
    expect(decideMutationIntentSettlement(MutationEventType.CancelAccepted)).toEqual({
      _tag: 'Settled',
      outcome: 'accepted',
    })
    expect(decideMutationIntentSettlement(MutationEventType.CancelUnknown)).toEqual({
      _tag: 'Unresolved',
      eventType: MutationEventType.CancelUnknown,
    })
  })

  test('waits the durable consistency window only after accepted submit settlement', () => {
    expect(
      mutationIntentReconciliationDelayMs({
        settlement: { _tag: 'Settled', outcome: 'accepted' },
        consistencyDelayMs: 1_250,
        operation: MutationOperation.Submit,
        mutationAdvanced: true,
      }),
    ).toBe(1_250)
    expect(
      mutationIntentReconciliationDelayMs({
        settlement: { _tag: 'Settled', outcome: 'rejected' },
        consistencyDelayMs: 1_250,
        operation: MutationOperation.Submit,
        mutationAdvanced: true,
      }),
    ).toBe(0)
    expect(
      mutationIntentReconciliationDelayMs({
        settlement: { _tag: 'Settled', outcome: 'accepted' },
        consistencyDelayMs: 1_250,
        operation: MutationOperation.Submit,
        mutationAdvanced: false,
      }),
    ).toBe(0)
  })

  test('replays a terminal rejection without resubmission and executes the later-cycle intent', async () => {
    const rejectedIntentId = 'a'.repeat(64)
    const laterIntentId = 'b'.repeat(64)
    const event = (intentId: string, eventType: MutationEventType) => ({
      schemaVersion: 'bayn.paper-mutation-event.v1' as const,
      eventId: canonicalHashV1({ intentId, eventType }),
      mutationId: canonicalHashV1({ intentId, operation: 'SUBMIT' }),
      intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType,
      requestHash: '1'.repeat(64),
      consistencyDelayMs: 1_000,
      occurredAt: evaluatedAt,
    })
    const rejected = event(rejectedIntentId, MutationEventType.SubmitRejected)
    const accepted = event(laterIntentId, MutationEventType.SubmitAccepted)
    const submitted: string[] = []
    const submitDeadlines: string[] = []
    let recoveries = 0
    const program: ExecutionProgram = {
      ...sandboxExecutionProgram(),
      submit: (intentId, _consistencyDelayMs, submitExpiresAt) =>
        Effect.sync(() => {
          submitted.push(intentId)
          submitDeadlines.push(submitExpiresAt)
          return accepted
        }),
      recover: () =>
        Effect.sync(() => {
          recoveries += 1
          return accepted
        }),
    }
    const store = {
      latest: (intentId: string) => Effect.succeed(intentId === rejectedIntentId ? rejected : undefined),
    } as unknown as MutationStoreShape

    await Effect.runPromise(
      Effect.forEach(
        [rejectedIntentId, laterIntentId],
        (intentId) => executeMutationIntent(program, intentId, 'SUBMIT', '9999-12-31T23:59:59.999Z'),
        {
          concurrency: 1,
          discard: true,
        },
      ).pipe(Effect.provideService(MutationStore, store)),
    )

    expect(submitted).toEqual([laterIntentId])
    expect(submitDeadlines).toEqual(['9999-12-31T23:59:59.999Z'])
    expect(recoveries).toBe(0)
  })

  test('dispatches one fresh cancellation while recovery actions remain lookup-only', async () => {
    const intentId = 'd'.repeat(64)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: 'e'.repeat(64),
      mutationId: 'f'.repeat(64),
      intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '1'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'accepted-broker-order',
      occurredAt: evaluatedAt,
    }
    const { brokerOrderId: _acceptedBrokerOrderId, ...acceptedWithoutBrokerOrderId } = accepted
    const unknownEvent: MutationEvent = {
      ...acceptedWithoutBrokerOrderId,
      eventId: '2'.repeat(64),
      eventType: MutationEventType.SubmitUnknown,
    }
    const cancelAccepted: MutationEvent = {
      ...accepted,
      eventId: '3'.repeat(64),
      mutationId: '4'.repeat(64),
      operation: MutationOperation.Cancel,
      eventType: MutationEventType.CancelAccepted,
      requestHash: '5'.repeat(64),
    }
    const cancelUnknown: MutationEvent = {
      ...cancelAccepted,
      eventId: '6'.repeat(64),
      eventType: MutationEventType.CancelUnknown,
    }
    const dueAt = utcInstantFromEpochMillis(Date.parse(evaluatedAt) + accepted.consistencyDelayMs)
    expect(mutationRecoveryIsDue(accepted, utcInstantFromEpochMillis(Date.parse(dueAt) - 1))).toBe(false)
    expect(mutationRecoveryIsDue(accepted, dueAt)).toBe(true)
    expect(executionSubmitExpiresAt(cycle.window.submissionCutoffAt, evaluatedAt)).toBe(evaluatedAt)
    expect(executionSubmitExpiresAt(evaluatedAt, cycle.window.submissionCutoffAt)).toBe(evaluatedAt)

    let submits = 0
    let cancels = 0
    const recoveries: MutationOperation[] = []
    const program: ExecutionProgram = {
      ...sandboxExecutionProgram(),
      submit: () =>
        Effect.sync(() => {
          submits += 1
          return accepted
        }),
      cancel: () =>
        Effect.sync(() => {
          cancels += 1
          return cancelAccepted
        }),
      recover: (_intentId, operation) =>
        Effect.sync(() => {
          recoveries.push(operation)
          return {
            ...(operation === MutationOperation.Submit ? accepted : cancelAccepted),
            eventId: canonicalHashV1({ intentId, operation, eventType: MutationEventType.RecoveryFound }),
            eventType: MutationEventType.RecoveryFound,
          }
        }),
    }
    let latestSubmit: MutationEvent | undefined = accepted
    let latestCancel: MutationEvent | undefined
    const store = {
      latest: (_intentId: string, operation: MutationOperation) =>
        Effect.succeed(operation === MutationOperation.Submit ? latestSubmit : latestCancel),
    } as unknown as MutationStoreShape

    await Effect.runPromise(
      executeMutationIntent(program, intentId, 'RECOVER_SUBMIT').pipe(Effect.provideService(MutationStore, store)),
    )
    latestSubmit = unknownEvent
    await Effect.runPromise(
      executeMutationIntent(program, intentId, 'RECOVER_SUBMIT').pipe(Effect.provideService(MutationStore, store)),
    )
    latestSubmit = accepted
    await Effect.runPromise(
      executeMutationIntent(program, intentId, 'CANCEL').pipe(Effect.provideService(MutationStore, store)),
    )
    latestCancel = cancelAccepted
    await Effect.runPromise(
      executeMutationIntent(program, intentId, 'RECOVER_CANCEL').pipe(Effect.provideService(MutationStore, store)),
    )
    latestCancel = cancelUnknown
    await Effect.runPromise(
      executeMutationIntent(program, intentId, 'RECOVER_CANCEL').pipe(Effect.provideService(MutationStore, store)),
    )

    expect(submits).toBe(0)
    expect(cancels).toBe(1)
    expect(recoveries).toEqual([
      MutationOperation.Submit,
      MutationOperation.Submit,
      MutationOperation.Cancel,
      MutationOperation.Cancel,
    ])

    const missingStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const failure = await Effect.runPromise(
      Effect.flip(
        executeMutationIntent(program, intentId, 'RECOVER_SUBMIT').pipe(
          Effect.provideService(MutationStore, missingStore),
        ),
      ),
    )
    expect(failure).toMatchObject({
      failure: 'contract',
      message: 'lookup-only execution recovery lost its durable submit evidence',
    })
    const cancelFailure = await Effect.runPromise(
      Effect.flip(
        executeMutationIntent(program, intentId, 'RECOVER_CANCEL').pipe(
          Effect.provideService(MutationStore, missingStore),
        ),
      ),
    )
    expect(cancelFailure).toMatchObject({
      failure: 'contract',
      message: 'lookup-only execution recovery lost its durable cancel evidence',
    })
    expect(submits).toBe(0)
    expect(cancels).toBe(1)
  })

  test('classifies an identical stable recovery observation as read-only', async () => {
    const intentId = '7'.repeat(64)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '8'.repeat(64),
      mutationId: '9'.repeat(64),
      intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.RecoveryFound,
      requestHash: 'a'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'stable-open-order',
      occurredAt: evaluatedAt,
    }
    const result = await Effect.runPromise(
      executeMutationIntent(
        {
          ...sandboxExecutionProgram(),
          recover: () => Effect.succeed(accepted),
        },
        intentId,
        'RECOVER_SUBMIT',
      ).pipe(
        Effect.provideService(MutationStore, {
          latest: () => Effect.succeed(accepted),
        } as unknown as MutationStoreShape),
      ),
    )

    expect(result).toEqual({
      settlement: { _tag: 'Settled', outcome: 'accepted' },
      consistencyDelayMs: 1_000,
      operation: MutationOperation.Submit,
      mutationAdvanced: false,
    })
    expect(mutationIntentReconciliationDelayMs(result)).toBe(0)
  })

  test('keeps an accepted pending intent lookup-recoverable after its immutable submission cutoff', async () => {
    const fixture = await executionLifecycleFixture()
    const afterCutoff = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const record = storedIntent(fixture.intent, IntentState.Acknowledged, fixture.document.createdAt)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: canonicalHashV1(Result.getOrThrow(orderRequestBody(fixture.intent))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'accepted-past-cutoff',
      occurredAt: fixture.document.createdAt,
    }

    const step = await prepareStoredExecutionStep(fixture, record, accepted, afterCutoff)

    expect(step).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt: afterCutoff,
    })
  })

  test('keeps an unknown submit lookup-recoverable after its immutable submission cutoff', async () => {
    const fixture = await executionLifecycleFixture()
    const afterCutoff = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const record = storedIntent(fixture.intent, IntentState.Unknown, fixture.document.createdAt)
    const unknown: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '4'.repeat(64),
      mutationId: '5'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitUnknown,
      requestHash: '6'.repeat(64),
      consistencyDelayMs: 1_000,
      occurredAt: fixture.document.createdAt,
    }

    const step = await prepareStoredExecutionStep(fixture, record, unknown, afterCutoff, 1)

    expect(step).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt: afterCutoff,
    })
  })

  test('never creates a fresh submit POST once the immutable cutoff is reached', async () => {
    const fixture = await executionLifecycleFixture()
    let submits = 0
    const program: ExecutionProgram = {
      ...sandboxExecutionProgram(),
      submit: () =>
        Effect.sync(() => {
          submits += 1
          throw new Error('fresh submit must not reach broker I/O after cutoff')
        }),
    }
    const store = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(fixture.document.submissionCutoffAt))
          return yield* executeMutationIntent(
            program,
            fixture.intent.intentId,
            'SUBMIT',
            fixture.document.submissionCutoffAt,
          )
        }).pipe(Effect.provideService(MutationStore, store), Effect.provide(TestClock.layer())),
      ),
    )

    expect(failure).toMatchObject({
      failure: 'contract',
      message: 'fresh broker submit crossed its immutable submission cutoff before broker I/O',
    })
    expect(submits).toBe(0)
  })

  test('binds a real PAPER risk rejection and terminalizes it without intent or broker work', async () => {
    const fixture = await executionLifecycleFixture((policy) => ({
      ...policy,
      maxOrderNotionalMicros: '1',
    }))
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1)

    expect(fixture.document).toMatchObject({
      mode: 'PAPER',
      dispatchable: false,
      targetPlan: { status: TargetPlanStatus.Planned },
      riskBlock: {
        intentId: fixture.intent.intentId,
        decisionId: fixture.risk.evaluation.decision.decisionId,
      },
    })
    expect(fixture.document.riskBlock?.reasonCodes).toContain(Reason.OrderNotionalExceeded)
    expect(fixture.document.riskBlock?.reasonCodes).not.toContain(Reason.AuthorityNotGranted)
    expect(fixture.document.deltaRisk).toHaveLength(1)
    expect(fixture.document.deltaRisk[0]?.evaluation.decision.outcome).toBe(RiskOutcome.Blocked)
    const attached = attachCycleDecisionStoreEvidence(fixture.document, {
      executionCompletionEvidenceMatches: false,
      executionGenerationIsSuperseded: true,
    })
    expect(Reflect.ownKeys(attached)).toEqual(Reflect.ownKeys(fixture.document))
    expect(Result.isSuccess(decodeExecutionDecisionDocument(attached))).toBe(true)
    expect(cycleDecisionStoreEvidence(attached)).toEqual({
      executionCompletionEvidenceMatches: false,
      executionGenerationIsSuperseded: true,
    })

    const step = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Planned, fixture.document.createdAt),
      undefined,
      observedAt,
    )

    expect(step).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.Risk,
      observedAt,
    })

    const completion = Result.getOrThrow(decideCompletion(fixture.boundCycle, CycleState.Completed, observedAt))
    if (completion._tag !== 'VerifyDecision') return expect.unreachable('risk-blocked PAPER completion must verify')
    expect(Result.isFailure(validateCompletionDocument(completion, [fixture.document]))).toBe(true)
  })

  test('atomically persists a risk-blocked cycle before restricting PAPER authority', async () => {
    const fixture = await executionLifecycleFixture((policy) => ({
      ...policy,
      maxOrderNotionalMicros: '1',
    }))
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1)
    const blockedCycle = Effect.runSync(
      decodeAutonomousCycle({
        ...fixture.boundCycle,
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.Risk,
        stateVersion: fixture.boundCycle.stateVersion + 1,
        updatedAt: observedAt,
        terminalAt: observedAt,
      }),
    )
    const events: string[] = []
    const unused = Effect.die(new Error('blocked PAPER terminalization used an unrelated cycle-store operation'))
    const cycleStore: CycleStoreShape = {
      acquire: () => unused,
      read: () => unused,
      readAuthoritySlot: () => unused,
      readDecisionDocument: () => unused,
      readOldestUnfinished: () => unused,
      bindSnapshot: () => unused,
      activate: () => unused,
      bindDecision: () => unused,
      finish: () => unused,
      block: (cycleId, reason, terminalAt) =>
        Effect.sync(() => {
          events.push('block')
          expect(cycleId).toBe(fixture.boundCycle.identity.cycleId)
          expect(reason).toBe(CycleTerminalReason.Risk)
          expect(terminalAt).toBe(observedAt)
          return { cycle: blockedCycle, changed: true }
        }),
    }
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: (reason, updatedAt) =>
        Effect.sync(() => {
          events.push('restrict')
          expect(reason).toBe(
            `execution cycle loop restricted effective authority: bound cycle ${fixture.boundCycle.identity.cycleId} blocked: BLOCKED_RISK`,
          )
          expect(updatedAt).toBe(observedAt)
        }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: unused,
      transaction: (effect) =>
        Effect.sync(() => {
          events.push('fence')
        }).pipe(Effect.andThen(effect)),
    }
    const blockedCycleIntentStore: BlockedCycleIntentStoreShape = {
      settleCurrentTerminalGeneration: () => Effect.die(new Error('startup recovery is outside this unit boundary')),
      terminalizeUntouchedApproved: () =>
        Effect.sync(() => {
          events.push('terminalize-intents')
          return { blockedIntentCount: 0, expiredIntentCount: 1, terminalIntentCount: 1 }
        }),
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* terminalizeBlockedExecutionCycle(
          fixture.boundCycle,
          {
            _tag: 'Block',
            reason: CycleTerminalReason.Risk,
            observedAt,
          },
          generationHash,
          blockedCycleIntentStore,
        )
      }).pipe(
        Effect.provideService(CycleStore, cycleStore),
        Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
        Effect.provideService(WriterFence, writerFence),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(events).toEqual(['fence', 'block', 'restrict', 'terminalize-intents'])
    expect(result).toMatchObject({ action: 'BLOCKED', cycle: { state: CycleState.Blocked } })
  })

  test('does not restrict PAPER authority when the causal cycle block is rejected', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = fixture.document.submissionCutoffAt
    const unused = Effect.die(new Error('failed PAPER terminalization used an unrelated store operation'))
    let restrictions = 0
    const cycleStore: CycleStoreShape = {
      acquire: () => unused,
      read: () => unused,
      readAuthoritySlot: () => unused,
      readDecisionDocument: () => unused,
      readOldestUnfinished: () => unused,
      bindSnapshot: () => unused,
      activate: () => unused,
      bindDecision: () => unused,
      finish: () => unused,
      block: () =>
        Effect.fail(
          new CycleStoreError({
            operation: 'block',
            failure: 'query',
            persistenceFailure: 'constraint',
            message: 'open mutation prevents cycle block',
          }),
        ),
    }
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: () =>
        Effect.sync(() => {
          restrictions += 1
        }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: unused,
      transaction: (effect) => effect,
    }
    const blockedCycleIntentStore: BlockedCycleIntentStoreShape = {
      settleCurrentTerminalGeneration: () => Effect.die(new Error('startup recovery is outside this unit boundary')),
      terminalizeUntouchedApproved: () => Effect.die(new Error('rejected cycle block must not terminalize intents')),
    }

    const failure = await Effect.runPromise(
      Effect.flip(
        terminalizeBlockedExecutionCycle(
          fixture.boundCycle,
          {
            _tag: 'Block',
            reason: CycleTerminalReason.MissedSubmission,
            observedAt,
          },
          generationHash,
          blockedCycleIntentStore,
        ).pipe(
          Effect.provideService(CycleStore, cycleStore),
          Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
          Effect.provideService(WriterFence, writerFence),
        ),
      ),
    )

    expect(failure).toMatchObject({
      failure: 'store',
      message: 'blocked execution cycle finalization failed',
    })
    expect(restrictions).toBe(0)
  })

  test('terminalizes an untouched PAPER remainder when its durable approval expires', async () => {
    const fixture = await executionLifecycleFixture()
    const riskExpiresAt = fixture.risk.evaluation.decision.expiresAt
    expect(riskExpiresAt < fixture.document.submissionCutoffAt).toBe(true)
    expect(expiredExecutionPlanTerminalReason(riskExpiresAt, riskExpiresAt, fixture.document.submissionCutoffAt)).toBe(
      CycleTerminalReason.Risk,
    )
    expect(
      expiredExecutionPlanTerminalReason(
        fixture.document.submissionCutoffAt,
        fixture.document.submissionCutoffAt,
        fixture.document.submissionCutoffAt,
      ),
    ).toBe(CycleTerminalReason.MissedSubmission)

    const record = storedIntent(fixture.intent, IntentState.Approved, fixture.document.createdAt)
    const step = await prepareStoredExecutionStep(fixture, record, undefined, riskExpiresAt)

    expect(step).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.Risk,
      observedAt: riskExpiresAt,
    })
  })

  test('terminalizes an uncommitted execution intent at approval expiry before any durable commit', async () => {
    const fixture = await executionLifecycleFixture()
    const riskExpiresAt = fixture.risk.evaluation.decision.expiresAt
    let reads = 0
    let commits = 0
    const intentStore: IntentStoreService = {
      commit: () =>
        Effect.sync(() => {
          commits += 1
          throw new Error('expired uncommitted execution intent must not reach durable commit')
        }),
      read: () =>
        Effect.sync(() => {
          reads += 1
          return Option.none()
        }),
    }
    const mutationStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: () =>
        Effect.die(new Error('pre-commit expiry must not restrict authority before cycle block')),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.die(new Error('pre-commit expiry must not enter the writer fence')),
      transaction: () => Effect.die(new Error('pre-commit expiry must not open a writer-fenced transaction')),
    }

    const step = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(riskExpiresAt))
        return yield* prepareNextMutationIntent({
          input: fixture.input,
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          document: fixture.document,
          reconcile: Effect.die(new Error('pre-commit expiry must not reconcile or read the broker')),
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(MarketData, marketData([])),
        Effect.provideService(IntentStore, intentStore),
        Effect.provideService(MutationStore, mutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
        Effect.provideService(AuthorityRestrictionStore, authorityRestrictionStore),
        Effect.provideService(WriterFence, writerFence),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(step).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.Risk,
      observedAt: riskExpiresAt,
    })
    expect(reads).toBe(1)
    expect(commits).toBe(0)
  })

  test('terminalizes a superseded execution generation after proving no mutation exists', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1)
    let intentReads = 0
    let mutationReads = 0
    let commits = 0
    const intentStore: IntentStoreService = {
      commit: () =>
        Effect.sync(() => {
          commits += 1
          throw new Error('superseded execution generation must not commit an intent')
        }),
      read: () =>
        Effect.sync(() => {
          intentReads += 1
          return Option.none()
        }),
    }
    const mutationStore = {
      latest: () =>
        Effect.sync(() => {
          mutationReads += 1
          return undefined
        }),
    } as unknown as MutationStoreShape

    const step = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* prepareNextMutationIntent({
          input: { ...fixture.input, authorityGenerationHash: 'f'.repeat(64) },
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          document: fixture.document,
          reconcile: Effect.die(new Error('superseded execution generation must not reconcile or read the broker')),
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(MarketData, marketData([])),
        Effect.provideService(IntentStore, intentStore),
        Effect.provideService(MutationStore, mutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(step).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.ProvenanceMismatch,
      observedAt,
    })
    expect(intentReads).toBe(1)
    expect(mutationReads).toBe(2)
    expect(commits).toBe(0)
  })

  test('recovers superseded accepted and unknown submits and cancellations before provenance blocking', async () => {
    const fixture = await executionLifecycleFixture()
    const occurredAt = fixture.document.createdAt
    const observedAt = utcInstantFromEpochMillis(Date.parse(occurredAt) + 1_000)
    const supersededInput = { ...fixture.input, authorityGenerationHash: 'f'.repeat(64) }
    const driftedPolicy: Policy = {
      ...fixture.policy,
      maxOrderNotionalMicros: (BigInt(fixture.policy.maxOrderNotionalMicros) - 1n).toString(),
    }
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '3'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'superseded-accepted-order',
      occurredAt,
    }
    const { brokerOrderId: _supersededBrokerOrderId, ...acceptedWithoutBrokerOrderId } = accepted
    const unknown: MutationEvent = {
      ...acceptedWithoutBrokerOrderId,
      eventId: '4'.repeat(64),
      mutationId: '5'.repeat(64),
      eventType: MutationEventType.SubmitUnknown,
    }
    const cancelAccepted: MutationEvent = {
      ...accepted,
      eventId: '6'.repeat(64),
      mutationId: '7'.repeat(64),
      operation: MutationOperation.Cancel,
      eventType: MutationEventType.CancelAccepted,
      requestHash: '8'.repeat(64),
    }
    const cancelUnknown: MutationEvent = {
      ...cancelAccepted,
      eventId: '9'.repeat(64),
      mutationId: 'a'.repeat(64),
      eventType: MutationEventType.CancelUnknown,
    }
    const cancelRecovered: MutationEvent = {
      ...cancelAccepted,
      eventId: 'b'.repeat(64),
      mutationId: 'c'.repeat(64),
      sequence: 3,
      eventType: MutationEventType.RecoveryFound,
    }

    const acceptedStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Acknowledged, occurredAt),
      accepted,
      observedAt,
      0,
      () => undefined,
      supersededInput,
      undefined,
      true,
      driftedPolicy,
    )
    const unknownStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Unknown, occurredAt),
      unknown,
      observedAt,
      1,
      () => undefined,
      supersededInput,
      undefined,
      true,
      driftedPolicy,
    )
    const cancelAcceptedStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Acknowledged, occurredAt),
      accepted,
      observedAt,
      0,
      () => undefined,
      supersededInput,
      cancelAccepted,
      true,
      driftedPolicy,
    )
    const cancelUnknownStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Unknown, occurredAt),
      unknown,
      observedAt,
      1,
      () => undefined,
      supersededInput,
      cancelUnknown,
      true,
      driftedPolicy,
    )
    const settledSubmitStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Filled),
      accepted,
      observedAt,
      0,
      () => undefined,
      supersededInput,
      undefined,
      true,
      driftedPolicy,
    )
    const settledCancelStep = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Canceled),
      accepted,
      observedAt,
      0,
      () => undefined,
      supersededInput,
      cancelRecovered,
      true,
      driftedPolicy,
    )

    expect(acceptedStep).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(unknownStep).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(cancelAcceptedStep).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_CANCEL',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(cancelUnknownStep).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_CANCEL',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(settledSubmitStep).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.ProvenanceMismatch,
      observedAt,
    })
    expect(settledCancelStep).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.ProvenanceMismatch,
      observedAt,
    })
    expect(
      Result.getOrThrow(
        decidePreparedMutationRecovery(
          storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Canceled).intent,
          accepted,
          cancelRecovered,
        ),
      ),
    ).toEqual({ _tag: 'NoRecovery' })
  })

  test('recovers old-policy mutation work before rejecting fresh work under the current policy', async () => {
    const fixture = await executionLifecycleFixture()
    const occurredAt = fixture.document.createdAt
    const observedAt = utcInstantFromEpochMillis(Date.parse(occurredAt) + 1_000)
    const driftedPolicy: Policy = {
      ...fixture.policy,
      maxOrderNotionalMicros: (BigInt(fixture.policy.maxOrderNotionalMicros) - 1n).toString(),
    }
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: 'd'.repeat(64),
      mutationId: 'e'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: 'f'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'old-policy-accepted-order',
      occurredAt,
    }

    const recovery = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Acknowledged, occurredAt),
      accepted,
      observedAt,
      0,
      () => undefined,
      fixture.input,
      undefined,
      true,
      driftedPolicy,
    )

    const plannedRecord = storedIntent(fixture.intent, IntentState.Planned, occurredAt)
    let commits = 0
    const intentStore: IntentStoreService = {
      commit: () =>
        Effect.sync(() => {
          commits += 1
          throw new Error('policy drift must fail before a fresh intent re-commit')
        }),
      read: () => Effect.succeed(Option.some(plannedRecord)),
    }
    const mutationStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const freshFailure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* Effect.flip(
          prepareNextMutationIntent({
            input: fixture.input,
            preparation: fixture.preparation,
            policy: driftedPolicy,
            cycle: fixture.boundCycle,
            document: fixture.document,
            reconcile: Effect.die(
              new Error('policy drift must fail before reconciliation, broker reads, or fresh submission'),
            ),
          }),
        )
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(MarketData, marketData([])),
        Effect.provideService(IntentStore, intentStore),
        Effect.provideService(MutationStore, mutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(recovery).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(freshFailure).toMatchObject({
      _tag: 'CycleRunnerError',
      failure: 'contract',
      message: 'current source-controlled execution risk policy changed from the durable decision binding',
    })
    expect(commits).toBe(0)
  })

  test('recovers old execution-model mutations before gating fresh submission on the current model', async () => {
    const fixture = await executionLifecycleFixture()
    const occurredAt = fixture.document.createdAt
    const observedAt = utcInstantFromEpochMillis(Date.parse(occurredAt) + 1_000)
    const supersededInput = { ...fixture.input, authorityGenerationHash: 'f'.repeat(64) }
    const driftedPreparation = {
      ...fixture.preparation,
      executionModel: {
        ...fixture.preparation.executionModel,
        priceImpact: {
          halfSpreadBps: fixture.preparation.executionModel.priceImpact.halfSpreadBps + 100,
          slippageBps: fixture.preparation.executionModel.priceImpact.slippageBps + 100,
        },
      },
    }
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '3'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'old-model-accepted-order',
      occurredAt,
    }

    const recovery = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Acknowledged, occurredAt),
      accepted,
      observedAt,
      0,
      () => undefined,
      supersededInput,
      undefined,
      true,
      fixture.policy,
      driftedPreparation,
    )
    const terminalization = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Filled),
      accepted,
      observedAt,
      0,
      () => undefined,
      supersededInput,
      undefined,
      true,
      fixture.policy,
      driftedPreparation,
    )

    const plannedRecord = storedIntent(fixture.intent, IntentState.Planned, occurredAt)
    let commits = 0
    let reconciliations = 0
    const intentStore: IntentStoreService = {
      commit: () =>
        Effect.sync(() => {
          commits += 1
          throw new Error('execution-model drift must fail before a fresh intent re-commit')
        }),
      read: () => Effect.succeed(Option.some(plannedRecord)),
    }
    const mutationStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const freshFailure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* Effect.flip(
          prepareNextMutationIntent({
            input: fixture.input,
            preparation: driftedPreparation,
            policy: fixture.policy,
            cycle: fixture.boundCycle,
            document: fixture.document,
            reconcile: Effect.sync(() => {
              reconciliations += 1
              return reconciliationResultAt(observedAt)
            }),
          }),
        )
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(MarketData, marketData([])),
        Effect.provideService(IntentStore, intentStore),
        Effect.provideService(MutationStore, mutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(recovery).toEqual({
      _tag: 'Execute',
      action: 'RECOVER_SUBMIT',
      intentId: fixture.intent.intentId,
      observedAt,
    })
    expect(terminalization).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.ProvenanceMismatch,
      observedAt,
    })
    expect(freshFailure).toMatchObject({
      _tag: 'CycleRunnerError',
      failure: 'contract',
      message: 'durable mutation notional changed from the current execution model',
    })
    expect(commits).toBe(0)
    expect(reconciliations).toBe(0)
  })

  test('terminalizes a known rejected PAPER intent without waiting for cutoff', async () => {
    const fixture = await executionLifecycleFixture()
    const rejectedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1_000)
    expect(rejectedAt < fixture.risk.evaluation.decision.expiresAt).toBe(true)
    const record = storedIntent(fixture.intent, IntentState.Terminal, rejectedAt, TerminalOutcome.Rejected)
    const rejected: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: 'a'.repeat(64),
      mutationId: 'b'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitRejected,
      requestHash: 'c'.repeat(64),
      consistencyDelayMs: 1_000,
      requestId: 'paper-rejected-request',
      responseStatus: 422,
      responseContentHash: 'd'.repeat(64),
      occurredAt: rejectedAt,
    }
    const restrictions: { readonly reason: string; readonly updatedAt: string }[] = []

    const step = await prepareStoredExecutionStep(fixture, record, rejected, rejectedAt, 0, (reason, updatedAt) =>
      restrictions.push({ reason, updatedAt }),
    )

    expect(step).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.Risk,
      observedAt: rejectedAt,
    })
    expect(restrictions).toHaveLength(1)
    expect(restrictions[0]).toMatchObject({
      updatedAt: rejectedAt,
    })
    expect(restrictions[0]?.reason).toContain(`intent ${fixture.intent.intentId} ended REJECTED`)
  })

  test('builds a deterministic close and terminalizes an uncommitted close at its submit cutoff', async () => {
    const fixture = await executionLifecycleFixture((policy) => ({
      ...policy,
      maxBrokerStateAgeMs: 3_600_000,
      maxMarketDataAgeMs: 3_600_000,
    }))
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const closeExpiresAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000)
    const position: Position = {
      schemaVersion: 'bayn.paper-position.v1',
      accountId,
      symbol: fixture.intent.symbol,
      quantityMicros: '1000000',
      averageEntryPriceMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '100000000',
      unrealizedPnlMicros: '0',
      observedAt,
    }
    const baseReconciliation = reconciliationResultAt(observedAt, 0, 0, [position])
    const closeAccount = { ...baseReconciliation.brokerState.account, observedAt }
    const closeStateHash = Result.getOrThrow(
      reconciledStateHash({
        account: closeAccount,
        positions: [position],
        positionsObservedAt: observedAt,
        orders: [],
        ordersObservedAt: observedAt,
        accountingHash,
      }),
    )
    const closeReconciliationMaterial = {
      ...baseReconciliation.brokerState.reconciliation,
      expectedHash: closeStateHash,
      observedHash: closeStateHash,
      reconciledAt: observedAt,
    }
    const closeReconciliationId = canonicalHashV1({
      schemaVersion: 'bayn.paper-reconciliation-id.v1',
      material: closeReconciliationMaterial,
    })
    const closeReconciliation = {
      ...closeReconciliationMaterial,
      reconciliationId: closeReconciliationId,
      contentHash: canonicalHashV1({ ...closeReconciliationMaterial, reconciliationId: closeReconciliationId }),
    }
    const currentReconciliation: ReconciliationPassResult = {
      ...baseReconciliation,
      report: { ...baseReconciliation.report, reconciliation: closeReconciliation },
      brokerState: {
        ...baseReconciliation.brokerState,
        account: closeAccount,
        reconciliation: closeReconciliation,
      },
    }
    const buildClose = (
      entryDocument: typeof fixture.document,
      closeReconciliationResult: ReconciliationPassResult = currentReconciliation,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(observedAt))
          return yield* buildClosingExecutionCycleDecision({
            input: fixture.input,
            preparation: fixture.preparation,
            policy: fixture.policy,
            cycle: fixture.boundCycle,
            entryDocument,
            reconcile: Effect.succeed(closeReconciliationResult),
            closeExpiresAt,
          })
        }).pipe(
          Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
          Effect.provideService(MarketData, marketData([])),
          Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
          Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
          Effect.provideService(ValuationStore, {} as ValuationStoreShape),
          Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
          Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
          Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
          Effect.provideService(WriterFence, {} as WriterFenceService),
          Effect.provide(TestClock.layer()),
        ),
      )

    const close = await buildClose(fixture.document)
    const noTradeClose = await buildClose(fixture.document, reconciliationResultAt(observedAt))
    const { executionSession: _legacyExecutionSession, ...legacyDocument } = fixture.document
    const legacyClose = await buildClose(legacyDocument as typeof fixture.document)

    expect(close.executionSession).toEqual(fixture.document.executionSession)
    expect(close.targetPlan.intentTargets).toMatchObject([
      {
        symbol: fixture.intent.symbol,
        side: OrderSide.Sell,
        quantityMicros: '1000000',
      },
    ])
    expect(close.targetPlan.intentTargets).toHaveLength(1)
    expect(close.dispatchable).toBe(true)
    expect(noTradeClose.targetPlan.status).toBe(TargetPlanStatus.NoTrade)
    expect(decideExecutionCycleCloseDocument(noTradeClose)).toEqual({ _tag: 'Complete' })
    expect(decideExecutionCycleCloseDocument({ ...close, dispatchable: false })).toEqual({ _tag: 'Block' })
    expect(legacyClose.targetPlan.intentTargets).toEqual(close.targetPlan.intentTargets)

    const committedIntents = new Map<string, StoredIntent>()
    const closeIntentStore: IntentStoreService = {
      commit: () => Effect.die(new Error('close admission must use commitClosing')),
      commitClosing: (intent) =>
        Effect.sync(() => {
          const record = storedIntent(intent, IntentState.Planned, close.createdAt)
          committedIntents.set(intent.intentId, record)
          return { record, deduplicated: false }
        }),
      read: (intentId) => {
        const record = committedIntents.get(intentId)
        return Effect.succeed(record === undefined ? Option.none() : Option.some(record))
      },
    }
    const closeMutationStore = {
      latest: () => Effect.void,
    } as unknown as MutationStoreShape
    const admission = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* prepareNextMutationIntent({
          input: {
            ...fixture.input,
            mutationPhase: 'CLOSE',
            executionMandateCutoffAt: fixture.document.submissionCutoffAt,
            executionMandateCloseSubmitCutoffAt: closeExpiresAt,
            executionMandateExpiresAt: closeExpiresAt,
          },
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          document: close,
          reconcile: Effect.succeed(currentReconciliation),
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(MarketData, marketData([])),
        Effect.provideService(IntentStore, closeIntentStore),
        Effect.provideService(MutationStore, closeMutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(admission).toMatchObject({
      _tag: 'Execute',
      action: 'SUBMIT',
      intentId: close.orderedIntentIds[0],
    })

    const missedCloseSubmitCutoffAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 30_000)
    let missedCloseCommits = 0
    const missedCloseIntentStore: IntentStoreService = {
      commit: () => Effect.die(new Error('missed close admission must use commitClosing')),
      commitClosing: () =>
        Effect.sync(() => {
          missedCloseCommits += 1
          throw new Error('missed close cutoff must terminalize before durable intent commit')
        }),
      read: () => Effect.succeed(Option.none()),
    }
    const missedClose = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(missedCloseSubmitCutoffAt))
        return yield* prepareNextMutationIntent({
          input: {
            ...fixture.input,
            mutationPhase: 'CLOSE',
            executionMandateCutoffAt: fixture.document.submissionCutoffAt,
            executionMandateCloseSubmitCutoffAt: missedCloseSubmitCutoffAt,
            executionMandateExpiresAt: closeExpiresAt,
          },
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          document: close,
          reconcile: Effect.die(new Error('missed close cutoff must terminalize before broker reconciliation')),
          allowSubmit: false,
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(MarketData, marketData([])),
        Effect.provideService(IntentStore, missedCloseIntentStore),
        Effect.provideService(MutationStore, closeMutationStore),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(missedClose).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.MissedSubmission,
      observedAt: missedCloseSubmitCutoffAt,
    })
    expect(missedCloseCommits).toBe(0)
  })

  test('builds an intraday close as a same-session flat execution target', () => {
    const close = Result.getOrThrow(
      makeClosingDecisionPlan(
        {
          strategyName: 'opening-drive-momentum',
          executionSessionDate: executionDate,
        },
        ['NVDA', 'AMD', 'NVDA'],
      ),
    )

    expect(close).toEqual({
      schemaVersion: 'bayn.execution-flat-target.v1',
      strategyName: 'opening-drive-momentum',
      sessionDate: executionDate,
      targetWeights: { AMD: 0, NVDA: 0 },
      symbols: ['AMD', 'NVDA'],
      reason: 'mandate-close',
    })
  })

  test('recovers a persisted v2 opening-drive cycle into an exact fractional forced close', async () => {
    const protocol = Result.getOrThrow(decodeDefaultOpeningDriveProtocol())
    const definition = makeOpeningDriveDefinition(protocol)
    const strategy = {
      definition,
      provenance: {
        ...fixtureRuntime.provenance,
        strategy: {
          name: definition.name,
          behaviorHash: openingDriveBehaviorHash,
          parameterHash: canonicalHashV1(definition.parameters),
          parameterSchemaVersion: definition.parameters.schemaVersion,
        },
      },
    }
    const openingPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(openingDriveExecutionModel))
    if (openingPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v2') {
      return expect.unreachable('opening-drive fixture requires the intraday execution policy')
    }
    const historicalIdentity = Result.getOrThrow(
      makeCycleIdentity({
        schemaVersion: 'bayn.autonomous-cycle-identity.v2',
        strategyName: definition.name,
        qualificationRunId: 'c'.repeat(64),
        strategyProtocolHash: makeStrategyProtocolHash(strategy.provenance.strategy),
        accountId,
        signalSessionDate: signalDate,
        signalCalendarVersion: 'fixture-calendar-v2',
        executionSessionDate: executionDate,
        executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
        executionCalendarSource: executionCalendar.executionCalendarSource,
        executionCalendarHash: executionCalendar.executionCalendarHash,
        executionPolicy: openingPolicy,
      }),
    )
    const historicalWindow = Result.getOrThrow(
      makeCycleWindow(
        {
          calendar_version: 'fixture-calendar-v2',
          session_date: signalDate,
          close_time: '16:00',
          timezone: 'America/New_York',
        },
        executionCalendar,
        openingPolicy,
      ),
    )
    const historicalCycle = Effect.runSync(
      decodeAutonomousCycle({
        ...Result.getOrThrow(makeCycleDraft(historicalIdentity, historicalWindow)),
        state: CycleState.Active,
        bindings: { snapshotId },
        stateVersion: 3,
        createdAt: '2020-04-30T22:00:00.000Z',
        updatedAt: historicalWindow.submissionOpenAt,
      }),
    )
    const archive = intradayMarketData(protocol)
    const input = {
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy,
      intradayMarketData: archive,
      executionProgram: sandboxExecutionProgram(generationHash, strategy.provenance.strategy),
    } as const
    const preparation = Result.getOrThrow(prepareObserveStartup(input))
    const policy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, strategy))
    const failedEntry = (snapshotFailure: IntradaySnapshotFailure) => {
      const laggingArchive: IntradayMarketDataService = {
        captureVersion: archive.captureVersion,
        loadSnapshot: () =>
          Effect.fail(
            operationalError({
              component: 'market-data',
              operation: 'load-intraday',
              message: snapshotFailure.message,
              cause: snapshotFailure,
            }),
          ),
      }
      return Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(historicalWindow.submissionOpenAt))
          return yield* buildMutationShadowCycleDecision({
            authorityGenerationHash: generationHash,
            cycle: historicalCycle,
            executionModel: openingDriveExecutionModel,
            policy,
            reconcile: Effect.succeed(reconciliationResult(generationHash, Authority.Execution)),
            strategy,
            intradayMarketData: laggingArchive,
          })
        }).pipe(
          (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
          Effect.provide(TestClock.layer()),
          Effect.flip,
        ),
      )
    }
    const replicaLag = new IntradaySnapshotFailure({
      reason: 'watermark',
      message: 'intraday archive has not materialized the captured source offset',
    })
    const entryNotReady = new IntradaySnapshotFailure({
      reason: 'not-ready',
      message: 'intraday entry snapshot lacks a post-range trade',
    })
    const topologyMismatch = new IntradaySnapshotFailure({
      reason: 'watermark',
      message: 'intraday archive partition topology changed after version capture',
    })
    expect(await failedEntry(replicaLag)).toMatchObject({
      _tag: 'ObserveDecisionAwaitingSignal',
      message: replicaLag.message,
      observedAt: historicalWindow.submissionOpenAt,
      submissionCutoffAt: historicalWindow.submissionCutoffAt,
    })
    expect(await failedEntry(entryNotReady)).toMatchObject({
      _tag: 'ObserveDecisionAwaitingSignal',
      message: entryNotReady.message,
      observedAt: historicalWindow.submissionOpenAt,
      submissionCutoffAt: historicalWindow.submissionCutoffAt,
    })
    expect(await failedEntry(topologyMismatch)).toMatchObject({
      _tag: 'OperationalError',
      cause: topologyMismatch,
    })
    const entryDocument = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(historicalWindow.submissionOpenAt))
        return yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle: historicalCycle,
          executionModel: openingDriveExecutionModel,
          policy,
          reconcile: Effect.succeed(reconciliationResult(generationHash, Authority.Execution)),
          strategy,
          intradayMarketData: archive,
        })
      }).pipe(
        (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
        Effect.provide(TestClock.layer()),
      ),
    )
    const boundCycle = Effect.runSync(
      decodeAutonomousCycle({
        ...historicalCycle,
        bindings: { ...historicalCycle.bindings, decisionHash: entryDocument.contentHash },
        stateVersion: historicalCycle.stateVersion + 1,
        updatedAt: entryDocument.createdAt,
      }),
    )
    const closeObservedAt = '2020-05-01T19:30:01.000Z'
    const closeExpiresAt = '2020-05-01T19:45:00.000Z'
    const heldSymbol = protocol.universe[0]
    if (heldSymbol === undefined) return expect.unreachable('opening-drive fixture requires a non-empty universe')
    const openPosition: Position = {
      schemaVersion: 'bayn.paper-position.v1',
      accountId,
      symbol: heldSymbol,
      quantityMicros: '500000',
      averageEntryPriceMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '50000000',
      unrealizedPnlMicros: '0',
      observedAt: closeObservedAt,
    }
    const buildClosePositionsProgram = (
      positions: readonly Position[],
      closeInput: typeof input = input,
      observedAt: string = closeObservedAt,
    ) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* buildClosingExecutionCycleDecision({
          input: closeInput,
          preparation,
          policy,
          cycle: boundCycle,
          entryDocument,
          reconcile: Effect.succeed(
            reconciliationResultAt(
              observedAt,
              0,
              0,
              positions.map((position) => ({ ...position, observedAt })),
            ),
          ),
          closeExpiresAt,
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(MarketData, marketData([])),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provide(TestClock.layer()),
      )
    const buildCloseProgram = (
      position: Position,
      closeInput: typeof input = input,
      observedAt: string = closeObservedAt,
    ) => buildClosePositionsProgram([position], closeInput, observedAt)
    const buildClose = (position: Position) => Effect.runPromise(buildCloseProgram(position))
    const close = await buildClose(openPosition)
    const shortPosition: Position = {
      ...openPosition,
      quantityMicros: '-500000',
      marketValueMicros: '-50000000',
    }
    const cover = await buildClose(shortPosition)
    const outOfUniversePosition: Position = {
      ...openPosition,
      symbol: 'TSLA',
      marketPriceMicros: '100005000',
      marketValueMicros: '50002500',
    }
    const unusedArchive: IntradayMarketDataService = {
      captureVersion: () => Effect.die('out-of-universe liquidation must not query the strategy archive'),
      loadSnapshot: () => Effect.die('out-of-universe liquidation must not load a strategy snapshot'),
    }
    const outOfUniverseClose = await Effect.runPromise(
      buildCloseProgram(outOfUniversePosition, { ...input, intradayMarketData: unusedArchive }),
    )
    const wholeSymbol = protocol.universe.find((symbol) => symbol !== heldSymbol)
    if (wholeSymbol === undefined) return expect.unreachable('mixed close fixture requires two strategy symbols')
    const wholePosition: Position = {
      ...openPosition,
      symbol: wholeSymbol,
      quantityMicros: '1000000',
      marketValueMicros: '100000000',
    }
    const fractionalPass = await Effect.runPromise(buildClosePositionsProgram([openPosition, wholePosition]))
    const wholePass = await Effect.runPromise(buildClosePositionsProgram([wholePosition]))
    const unavailable = new IntradaySnapshotFailure({
      reason: 'not-ready',
      message: 'liquidation snapshot lacks a post-range quote',
      facts: { symbol: heldSymbol },
    })
    const waitingArchive: IntradayMarketDataService = {
      captureVersion: () =>
        Effect.fail(
          operationalError({
            component: 'market-data',
            operation: 'load-intraday',
            message: unavailable.message,
            cause: unavailable,
          }),
        ),
      loadSnapshot: () => Effect.die('not-ready capture must not load snapshot rows'),
    }
    const waiting = await Effect.runPromise(
      buildCloseProgram(openPosition, { ...input, intradayMarketData: waitingArchive }).pipe(Effect.flip),
    )
    const closeReplicaLag = new IntradaySnapshotFailure({
      reason: 'watermark',
      message: 'intraday archive has not materialized the captured source offset',
    })
    const laggingCloseArchive: IntradayMarketDataService = {
      captureVersion: archive.captureVersion,
      loadSnapshot: () =>
        Effect.fail(
          operationalError({
            component: 'market-data',
            operation: 'load-intraday',
            message: closeReplicaLag.message,
            cause: closeReplicaLag,
          }),
        ),
    }
    const waitingForReplica = await Effect.runPromise(
      buildCloseProgram(openPosition, { ...input, intradayMarketData: laggingCloseArchive }).pipe(Effect.flip),
    )
    const closeTopologyMismatch = new IntradaySnapshotFailure({
      reason: 'watermark',
      message: 'intraday archive partition topology changed after version capture',
    })
    const mismatchedCloseArchive: IntradayMarketDataService = {
      captureVersion: archive.captureVersion,
      loadSnapshot: () =>
        Effect.fail(
          operationalError({
            component: 'market-data',
            operation: 'load-intraday',
            message: closeTopologyMismatch.message,
            cause: closeTopologyMismatch,
          }),
        ),
    }
    const fatalCloseMismatch = await Effect.runPromise(
      buildCloseProgram(openPosition, { ...input, intradayMarketData: mismatchedCloseArchive }).pipe(Effect.flip),
    )
    const staleObservedAt = '2020-05-01T19:30:10.000Z'
    const stale = await Effect.runPromise(buildCloseProgram(openPosition, input, staleObservedAt).pipe(Effect.flip))
    const refreshed = await Effect.runPromise(buildCloseProgram(openPosition, input, '2020-05-01T19:31:01.000Z'))

    expect(entryDocument.executionSession?.schemaVersion).toBe('bayn.execution-session-binding.v2')
    expect(close).toMatchObject({
      mode: 'PAPER',
      dispatchable: true,
      executionSession: { schemaVersion: 'bayn.execution-session-binding.v2' },
      bindings: {
        snapshotId,
        executionMarketData: { sessionDate: executionDate },
      },
      targetPlan: {
        status: TargetPlanStatus.Planned,
        intentTargets: [
          {
            symbol: openPosition.symbol,
            side: OrderSide.Sell,
            orderType: OrderType.Market,
            timeInForce: TimeInForce.Day,
            quantityMicros: '500000',
          },
        ],
      },
    })
    expect(cover).toMatchObject({
      dispatchable: true,
      targetPlan: {
        status: TargetPlanStatus.Planned,
        intentTargets: [
          {
            symbol: shortPosition.symbol,
            side: OrderSide.Buy,
            orderType: OrderType.Market,
            timeInForce: TimeInForce.Day,
            quantityMicros: '500000',
          },
        ],
      },
    })
    expect(outOfUniverseClose).toMatchObject({
      dispatchable: true,
      bindings: {
        executionMarketData: {
          schemaVersion: 'bayn.reconciled-position-liquidation-binding.v1',
          source: 'alpaca-v2-positions',
          symbols: ['TSLA'],
          positions: [
            {
              symbol: 'TSLA',
              quantityMicros: '500000',
              marketPriceMicros: '100005000',
              observedAt: closeObservedAt,
            },
          ],
        },
      },
      targetPlan: {
        status: TargetPlanStatus.Planned,
        targets: [{ symbol: 'TSLA', referencePriceMicros: '100000000' }],
        intentTargets: [
          {
            symbol: 'TSLA',
            side: OrderSide.Sell,
            orderType: OrderType.Market,
            timeInForce: TimeInForce.Day,
            quantityMicros: '500000',
          },
        ],
      },
    })
    expect(fractionalPass.targetPlan).toMatchObject({
      executionTerms: {
        executionPurpose: 'fractional-close',
        orderType: OrderType.Market,
        timeInForce: TimeInForce.Day,
      },
      intentTargets: [
        {
          symbol: heldSymbol,
          orderType: OrderType.Market,
          timeInForce: TimeInForce.Day,
          quantityMicros: '500000',
        },
      ],
    })
    expect(wholePass.targetPlan).toMatchObject({
      executionTerms: {
        executionPurpose: 'forced-close',
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
      },
      intentTargets: [
        {
          symbol: wholeSymbol,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityMicros: '1000000',
        },
      ],
    })
    const withExecutionTerms = (
      targetPlan: typeof close.targetPlan,
      executionTerms: Readonly<Record<string, string>>,
    ) => {
      const { outputHash: _outputHash, ...material } = targetPlan
      const changed = { ...material, executionTerms }
      return { ...changed, outputHash: canonicalHashV1(changed) }
    }
    const forgedBrokerMarkPlan = withExecutionTerms(close.targetPlan, {
      ...close.targetPlan.executionTerms,
      executionPurpose: 'forced-close',
      orderType: OrderType.Market,
      timeInForce: TimeInForce.Day,
      priceReference: 'reconciled-broker-position-mark',
    })
    const forgedArchivePlan = withExecutionTerms(outOfUniverseClose.targetPlan, {
      ...outOfUniverseClose.targetPlan.executionTerms,
      executionPurpose: 'fractional-close',
      orderType: OrderType.Market,
      timeInForce: TimeInForce.Day,
      priceReference: 'verified-adverse-quote-boundary',
    })
    const { contentHash: _closeHash, ...closeMaterial } = close
    const { contentHash: _outOfUniverseHash, ...outOfUniverseMaterial } = outOfUniverseClose
    expect(Result.isSuccess(decodeTargetPlanResult(forgedBrokerMarkPlan))).toBe(true)
    expect(Result.isSuccess(decodeTargetPlanResult(forgedArchivePlan))).toBe(true)
    expect(
      Result.isFailure(makeExecutionDecisionDocument({ ...closeMaterial, targetPlan: forgedBrokerMarkPlan })),
    ).toBe(true)
    expect(
      Result.isFailure(makeExecutionDecisionDocument({ ...outOfUniverseMaterial, targetPlan: forgedArchivePlan })),
    ).toBe(true)
    const brokerPositionBinding = outOfUniverseClose.bindings.executionMarketData
    if (brokerPositionBinding?.schemaVersion !== 'bayn.reconciled-position-liquidation-binding.v1') {
      return expect.unreachable('out-of-universe close must bind the exact reconciled broker position')
    }
    const rehashBrokerPositionBinding = (
      overrides: Partial<
        Omit<typeof brokerPositionBinding, 'schemaVersion' | 'purpose' | 'source' | 'contentHash' | 'snapshotId'>
      >,
    ) => {
      const { contentHash: _contentHash, snapshotId: _snapshotId, ...bindingMaterial } = brokerPositionBinding
      const changedMaterial = { ...bindingMaterial, ...overrides }
      const contentHash = canonicalHashV1(changedMaterial)
      return { ...changedMaterial, contentHash, snapshotId: canonicalHashV1({ ...changedMaterial, contentHash }) }
    }
    const forgedReconciliationBinding = rehashBrokerPositionBinding({ reconciliationId: 'f'.repeat(64) })
    const forgedPositionBinding = rehashBrokerPositionBinding({
      positions: brokerPositionBinding.positions.map((position) => ({ ...position, quantityMicros: '250000' })),
    })
    for (const forgedBinding of [forgedReconciliationBinding, forgedPositionBinding]) {
      const forgedDocument = makeExecutionDecisionDocument({
        ...outOfUniverseMaterial,
        bindings: { ...outOfUniverseMaterial.bindings, executionMarketData: forgedBinding },
      })
      expect(Result.isFailure(forgedDocument)).toBe(true)
      if (Result.isFailure(forgedDocument))
        expect(String(forgedDocument.failure.cause)).toContain('executionMarketData')
    }
    expect(waiting).toEqual(
      new ExecutionCloseAwaitingMarketData({
        message: `${unavailable.message}: ${unavailable.message}`,
        observedAt: closeObservedAt,
      }),
    )
    expect(waitingForReplica).toEqual(
      new ExecutionCloseAwaitingMarketData({
        message: `${closeReplicaLag.message}: ${closeReplicaLag.message}`,
        observedAt: closeObservedAt,
      }),
    )
    expect(fatalCloseMismatch).toMatchObject({
      _tag: 'CycleRunnerError',
      failure: 'operational',
      cause: {
        _tag: 'OperationalError',
        cause: closeTopologyMismatch,
      },
    })
    expect(stale).toEqual(
      new ExecutionCloseAwaitingMarketData({
        message: `closing quote for ${heldSymbol} is outside the freshness window`,
        observedAt: staleObservedAt,
      }),
    )
    expect(refreshed).toMatchObject({
      dispatchable: true,
      targetPlan: {
        status: TargetPlanStatus.Planned,
        intentTargets: [{ symbol: heldSymbol, side: OrderSide.Sell, quantityMicros: '500000' }],
      },
    })
  })

  test('keeps a rejected execution close intent recoverable while reconciliation still shows an open position', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1_000)
    const closeExpiresAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000)
    const rejected: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '5'.repeat(64),
      mutationId: '6'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitRejected,
      requestHash: '7'.repeat(64),
      consistencyDelayMs: 1_000,
      requestId: 'paper-close-rejected-request',
      responseStatus: 422,
      responseContentHash: '8'.repeat(64),
      occurredAt: observedAt,
    }
    const restrictions: string[] = []
    const step = await prepareStoredExecutionStep(
      fixture,
      storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Rejected),
      rejected,
      observedAt,
      0,
      (reason) => restrictions.push(reason),
      {
        ...fixture.input,
        mutationPhase: 'CLOSE',
        executionMandateCutoffAt: fixture.document.submissionCutoffAt,
        executionMandateCloseSubmitCutoffAt: closeExpiresAt,
        executionMandateExpiresAt: closeExpiresAt,
      },
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      undefined,
      undefined,
      [],
      { ...fixture.document, submissionCutoffAt: closeExpiresAt, expiresAt: closeExpiresAt },
      [
        {
          schemaVersion: 'bayn.paper-position.v1',
          accountId,
          symbol: fixture.intent.symbol,
          quantityMicros: '1000000',
          averageEntryPriceMicros: '100000000',
          marketPriceMicros: '100000000',
          marketValueMicros: '100000000',
          unrealizedPnlMicros: '0',
          observedAt,
        },
      ],
    )

    expect(step).toEqual({ _tag: 'Wait', observedAt })
    expect(restrictions).toHaveLength(1)
  })

  test('continues to a later close intent while capping fresh submission before close expiry', async () => {
    const fixture = await executionLifecycleFixture(
      (policy) => ({
        ...policy,
        maxBrokerStateAgeMs: 3_600_000,
        maxMarketDataAgeMs: 3_600_000,
      }),
      partialFillDecision,
    )
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const closeSubmitCutoffAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 30_000)
    const closeExpiresAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000)
    const positions = fixture.intents.map((intent) => ({
      schemaVersion: 'bayn.paper-position.v1' as const,
      accountId,
      symbol: intent.symbol,
      quantityMicros: '1000000',
      averageEntryPriceMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '100000000',
      unrealizedPnlMicros: '0',
      observedAt,
    }))
    const currentReconciliation = reconciliationResultAt(observedAt, 0, 0, positions)
    const close = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* buildClosingExecutionCycleDecision({
          input: fixture.input,
          preparation: fixture.preparation,
          policy: fixture.policy,
          cycle: fixture.boundCycle,
          entryDocument: fixture.document,
          reconcile: Effect.succeed(currentReconciliation),
          closeExpiresAt,
        })
      }).pipe(
        Effect.provideService(BrokerRead, decisionBrokerRead(calendarRead([]))),
        Effect.provideService(MarketData, marketData([])),
        Effect.provideService(BrokerEventStore, {} as BrokerEventStoreShape),
        Effect.provideService(FillAccountingStore, {} as FillAccountingStoreShape),
        Effect.provideService(ValuationStore, {} as ValuationStoreShape),
        Effect.provideService(ReconciliationStore, {} as ReconciliationStoreShape),
        Effect.provideService(AuthorityGenerationStore, {} as AuthorityGenerationStoreShape),
        Effect.provideService(AuthorityRestrictionStore, {} as AuthorityRestrictionStoreShape),
        Effect.provideService(WriterFence, {} as WriterFenceService),
        Effect.provide(TestClock.layer()),
      ),
    )
    const closeIntents = await Promise.all(
      close.targetPlan.intentTargets.map(async (target, index) => {
        const risk = close.deltaRisk[index]
        if (risk === undefined) throw new Error('PAPER close fixture risk binding is missing')
        return Effect.runPromise(
          planExecutionIntent(
            {
              schemaVersion: 'bayn.paper-intent-plan.v1',
              ...target,
              notionalLimitMicros: risk.notionalLimitMicros,
              createdAt: close.createdAt,
            },
            {
              authority: {
                schemaVersion: 'bayn.paper-authority.v1',
                generationHash,
                maximum: Authority.Execution,
                effective: Authority.Execution,
                kill: KillState.Clear,
                version: 1,
                updatedAt: close.createdAt,
              },
            },
          ),
        )
      }),
    )
    const firstIntent = closeIntents[0]
    const secondIntent = closeIntents[1]
    if (firstIntent === undefined || secondIntent === undefined) {
      return expect.unreachable('multi-symbol close fixture requires two intents')
    }
    expect(close.orderedIntentIds).toHaveLength(2)

    const rejected: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '9'.repeat(64),
      mutationId: 'a'.repeat(64),
      intentId: firstIntent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitRejected,
      requestHash: 'b'.repeat(64),
      consistencyDelayMs: 1_000,
      requestId: 'multi-symbol-close-rejected-request',
      responseStatus: 422,
      responseContentHash: 'c'.repeat(64),
      occurredAt: observedAt,
    }
    const records = new Map<string, StoredIntent>([
      [firstIntent.intentId, storedIntent(firstIntent, IntentState.Terminal, observedAt, TerminalOutcome.Rejected)],
      [secondIntent.intentId, storedIntent(secondIntent, IntentState.Planned, close.createdAt)],
    ])
    const latestSubmits = new Map<string, MutationEvent | undefined>([
      [firstIntent.intentId, rejected],
      [secondIntent.intentId, undefined],
    ])
    const restrictions: string[] = []
    const step = await prepareStoredExecutionStep(
      fixture,
      records.get(firstIntent.intentId) as StoredIntent,
      rejected,
      observedAt,
      0,
      (reason) => restrictions.push(reason),
      {
        ...fixture.input,
        mutationPhase: 'CLOSE',
        executionMandateCutoffAt: fixture.document.submissionCutoffAt,
        executionMandateCloseSubmitCutoffAt: closeSubmitCutoffAt,
        executionMandateExpiresAt: closeExpiresAt,
      },
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      records,
      latestSubmits,
      [],
      close,
      positions,
    )

    expect(step).toMatchObject({
      _tag: 'Execute',
      action: 'SUBMIT',
      intentId: secondIntent.intentId,
      observedAt,
      submitExpiresAt: closeSubmitCutoffAt,
    })
    expect(restrictions).toHaveLength(1)
  })

  test('blocks untouched ENTRY intents after a later terminal rejection before any fresh submit', async () => {
    const fixture = await executionLifecycleFixture((policy) => policy, partialFillDecision)
    const untouchedIntent = fixture.intents[0]
    const rejectedIntent = fixture.intents[1]
    if (untouchedIntent === undefined || rejectedIntent === undefined) {
      return expect.unreachable('entry rejection fixture requires two planned intents')
    }
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1_000)
    const rejected: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '5'.repeat(64),
      mutationId: '6'.repeat(64),
      intentId: rejectedIntent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitRejected,
      requestHash: '7'.repeat(64),
      consistencyDelayMs: 1_000,
      requestId: 'entry-rejected-request',
      responseStatus: 422,
      responseContentHash: '8'.repeat(64),
      occurredAt: observedAt,
    }
    const records = new Map<string, StoredIntent>([
      [untouchedIntent.intentId, storedIntent(untouchedIntent, IntentState.Planned, fixture.document.createdAt)],
      [
        rejectedIntent.intentId,
        storedIntent(rejectedIntent, IntentState.Terminal, observedAt, TerminalOutcome.Rejected),
      ],
    ])
    const latestSubmits = new Map<string, MutationEvent | undefined>([
      [untouchedIntent.intentId, undefined],
      [rejectedIntent.intentId, rejected],
    ])

    for (const effectiveAuthority of [Authority.Execution, Authority.Observe]) {
      const restrictions: string[] = []
      const step = await prepareStoredExecutionStep(
        fixture,
        records.get(untouchedIntent.intentId) as StoredIntent,
        undefined,
        observedAt,
        0,
        (reason) => restrictions.push(reason),
        fixture.input,
        undefined,
        true,
        fixture.policy,
        fixture.preparation,
        records,
        latestSubmits,
        [],
        fixture.document,
        [],
        effectiveAuthority,
      )

      expect(step, `effective authority ${effectiveAuthority}`).toEqual({
        _tag: 'Block',
        reason: CycleTerminalReason.Risk,
        observedAt,
      })
      expect(restrictions, `effective authority ${effectiveAuthority}`).toHaveLength(1)
    }
  })

  test('keeps a partially filled PAPER cycle recoverable until its close phase', async () => {
    const fixture = await executionLifecycleFixture((policy) => policy, partialFillDecision)
    const filledIntent = fixture.intents[0]
    const rejectedIntent = fixture.intents[1]
    if (filledIntent === undefined || rejectedIntent === undefined) {
      return expect.unreachable('partial-fill fixture requires two planned intents')
    }
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1_000)
    const cutoffAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000)
    const filledRecord = storedIntent(filledIntent, IntentState.Terminal, observedAt, TerminalOutcome.Filled)
    const rejectedRecord = storedIntent(rejectedIntent, IntentState.Terminal, observedAt, TerminalOutcome.Rejected)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: 'd'.repeat(64),
      mutationId: 'e'.repeat(64),
      intentId: filledIntent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: 'f'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'partial-filled-order',
      occurredAt: observedAt,
    }
    const rejected: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: rejectedIntent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitRejected,
      requestHash: '3'.repeat(64),
      consistencyDelayMs: 1_000,
      requestId: 'partial-rejected-request',
      responseStatus: 422,
      responseContentHash: '4'.repeat(64),
      occurredAt: observedAt,
    }
    const restrictions: string[] = []
    const step = await prepareStoredExecutionStep(
      fixture,
      filledRecord,
      accepted,
      observedAt,
      0,
      (reason) => restrictions.push(reason),
      { ...fixture.input, executionMandateCutoffAt: cutoffAt },
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      new Map([
        [filledIntent.intentId, filledRecord],
        [rejectedIntent.intentId, rejectedRecord],
      ]),
      new Map([
        [filledIntent.intentId, accepted],
        [rejectedIntent.intentId, rejected],
      ]),
    )

    expect(step).toEqual({ _tag: 'Wait', observedAt })
    expect(restrictions).toHaveLength(1)
    expect(restrictions[0]).toContain(`intent ${rejectedIntent.intentId} ended REJECTED`)
  })

  test('keeps a single canceled partial-fill PAPER intent recoverable before cutoff', async () => {
    const fixture = await executionLifecycleFixture()
    const observedAt = utcInstantFromEpochMillis(Date.parse(fixture.document.createdAt) + 1_000)
    const cutoffAt = utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000)
    const record = storedIntent(fixture.intent, IntentState.Terminal, observedAt, TerminalOutcome.Canceled)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '5'.repeat(64),
      mutationId: '6'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '7'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'single-partial-canceled-order',
      occurredAt: observedAt,
    }
    const partialOrder: Order = {
      schemaVersion: 'bayn.paper-order.v1',
      accountId,
      brokerOrderId: accepted.brokerOrderId ?? 'single-partial-canceled-order',
      clientOrderId: fixture.intent.clientOrderId,
      intentId: fixture.intent.intentId,
      symbol: fixture.intent.symbol,
      side: fixture.intent.side,
      orderType: fixture.intent.orderType,
      timeInForce: fixture.intent.timeInForce,
      quantityMicros: fixture.intent.quantityMicros,
      filledQuantityMicros: '1',
      status: OrderStatus.Canceled,
      observedAt,
    }
    const restrictions: string[] = []

    const step = await prepareStoredExecutionStep(
      fixture,
      record,
      accepted,
      observedAt,
      0,
      (reason) => restrictions.push(reason),
      { ...fixture.input, executionMandateCutoffAt: cutoffAt },
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      undefined,
      undefined,
      [partialOrder],
    )

    expect(step).toEqual({ _tag: 'Wait', observedAt })
    expect(restrictions).toHaveLength(1)
    expect(restrictions[0]).toContain(`intent ${fixture.intent.intentId} ended CANCELED`)
    expect(executionCycleHasFilledIntent({ intents: [record.intent], orders: [partialOrder] })).toBe(true)

    const closeExpiresAt = utcInstantFromEpochMillis(Date.parse(cutoffAt) + 60_000)
    const closeRestrictions: string[] = []
    const closeStep = await prepareStoredExecutionStep(
      fixture,
      record,
      accepted,
      observedAt,
      0,
      (reason) => closeRestrictions.push(reason),
      {
        ...fixture.input,
        mutationPhase: 'CLOSE',
        executionMandateCutoffAt: cutoffAt,
        executionMandateCloseSubmitCutoffAt: closeExpiresAt,
        executionMandateExpiresAt: closeExpiresAt,
      },
      undefined,
      true,
      fixture.policy,
      fixture.preparation,
      undefined,
      undefined,
      [partialOrder],
      { ...fixture.document, submissionCutoffAt: closeExpiresAt, expiresAt: closeExpiresAt },
    )

    expect(closeStep).toEqual({ _tag: 'Wait', observedAt })
    expect(closeRestrictions).toHaveLength(1)
  })

  test('completes a filled PAPER cycle after a later exact post-cutoff reconciliation', async () => {
    const fixture = await executionLifecycleFixture()
    const terminalAt = utcInstantFromEpochMillis(Date.parse(fixture.document.submissionCutoffAt) + 1_000)
    const reconciledLaterAt = utcInstantFromEpochMillis(Date.parse(terminalAt) + 1_000)
    const record = storedIntent(fixture.intent, IntentState.Terminal, terminalAt, TerminalOutcome.Filled)
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '7'.repeat(64),
      mutationId: '8'.repeat(64),
      intentId: fixture.intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '9'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'filled-past-cutoff',
      occurredAt: terminalAt,
    }

    const step = await prepareStoredExecutionStep(fixture, record, accepted, reconciledLaterAt)

    expect(step).toEqual({ _tag: 'Complete', observedAt: reconciledLaterAt })
    const completion = Result.getOrThrow(decideCompletion(fixture.boundCycle, CycleState.Completed, reconciledLaterAt))
    if (completion._tag !== 'VerifyDecision') return expect.unreachable('PAPER completion must verify')
    expect(Result.isFailure(validateCompletionDocument(completion, [fixture.document]))).toBe(true)
    expect(Result.isSuccess(validateCompletionDocument(completion, [fixture.document], true))).toBe(true)
  })

  test('derives the autonomous cycle protocol identity from the current strategy provenance', () => {
    const prepared = prepareObserveStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: fixtureRuntime,
    })

    expect(Result.isSuccess(prepared)).toBe(true)
    if (Result.isSuccess(prepared)) {
      expect(prepared.success.strategyProtocolHash).toBe(makeStrategyProtocolHash(fixtureRuntime.provenance.strategy))
    }
  })

  test('admits only a provenance-bound account-neutral intraday execution model at autonomous startup', () => {
    const protocol = Result.getOrThrow(decodeDefaultOpeningDriveProtocol())
    const definition = makeOpeningDriveDefinition(protocol)
    const strategy = {
      definition,
      provenance: {
        ...fixtureRuntime.provenance,
        strategy: {
          name: definition.name,
          behaviorHash: openingDriveBehaviorHash,
          parameterHash: canonicalHashV1(definition.parameters),
          parameterSchemaVersion: definition.parameters.schemaVersion,
        },
      },
    }
    const input = {
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy,
    } as const

    const prepared = prepareObserveStartup(input)
    expect(Result.isSuccess(prepared)).toBe(true)
    if (Result.isSuccess(prepared)) {
      expect(prepared.success.executionModel.schemaVersion).toBe('bayn.execution-model.v4')
      expect(prepared.success.executionPolicy.schemaVersion).toBe('bayn.autonomous-cycle-execution-policy.v2')
    }
    expect(
      Result.isFailure(
        prepareObserveStartup({
          ...input,
          strategy: { definition, provenance: fixtureRuntime.provenance },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        prepareObserveStartup({
          ...input,
          strategy: {
            ...strategy,
            definition: {
              ...definition,
              parameters: {
                ...definition.parameters,
                executionModel: {
                  ...openingDriveExecutionModel,
                  order: {
                    ...openingDriveExecutionModel.order,
                    submissionCutoffAfterOpenMs: openingDriveExecutionModel.order.decisionAfterOpenMs,
                  },
                },
              },
            },
          },
        }),
      ),
    ).toBe(true)
  })

  test('admits the provenance-bound full-session intraday execution model at autonomous startup', () => {
    const protocol = Result.getOrThrow(decodeDefaultIntradayMomentumProtocol())
    const definition = makeIntradayMomentumDefinition(protocol)
    const strategy = {
      definition,
      provenance: {
        ...fixtureRuntime.provenance,
        strategy: {
          name: definition.name,
          behaviorHash: intradayMomentumBehaviorHash,
          parameterHash: canonicalHashV1(definition.parameters),
          parameterSchemaVersion: definition.parameters.schemaVersion,
        },
      },
    }

    const prepared = prepareObserveStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy,
    })

    expect(Result.isSuccess(prepared)).toBe(true)
    if (Result.isSuccess(prepared)) {
      expect(prepared.success.executionModel.schemaVersion).toBe('bayn.execution-model.v5')
      expect(prepared.success.executionPolicy).toMatchObject({
        schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3',
        warmupAfterOpenMs: 1_800_000,
        submissionCutoffBeforeCloseMs: 3_600_000,
      })
    }
  })

  test('decodes the bounded source policy with the configured account and canonical universe', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, [...fixtureProtocol.universe].reverse()))

    expect(policy).toMatchObject({
      accountId,
      allowedSymbols: fixtureProtocol.universe,
      maxOrderNotionalMicros: '40000000000',
      maxSymbolExposureMicros: '40000000000',
      maxGrossExposureMicros: '100000000000',
      maxNetExposureMicros: '100000000000',
      maxDailyTradedNotionalMicros: '200000000000',
      maxDailyLossMicros: '5000000000',
      maxDrawdownMicros: '5000000000',
      maxOpenOrders: fixtureProtocol.universe.length,
    })
  })

  test('decodes a versioned quote-bound LIMIT/IOC policy for intraday execution', async () => {
    const policy = await Effect.runPromise(
      loadQuoteBoundExecutionRiskPolicy(accountId, [...fixtureProtocol.universe].reverse()),
    )

    expect(policy).toMatchObject({
      schemaVersion: 'bayn.execution-risk-policy.v3',
      accountId,
      allowedSymbols: fixtureProtocol.universe,
      allowedOrderTypes: [OrderType.Limit],
      allowedTimeInForce: [TimeInForce.ImmediateOrCancel],
    })
  })

  test('wires the strategy-bound quote policy and verified snapshot into the production planner', async () => {
    const protocol = Result.getOrThrow(decodeDefaultOpeningDriveProtocol())
    const strategy = {
      definition: makeOpeningDriveDefinition(protocol),
      provenance: fixtureRuntime.provenance,
    }
    const policy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, strategy))
    const sourceTopics = {
      bars: 'torghut.bars.1m.v1',
      quotes: 'torghut.quotes.v1',
      trades: 'torghut.trades.v1',
    }
    const archiveWatermarks = Object.values(sourceTopics).map((sourceTopic, index) => ({
      sourceTopic,
      sourcePartition: 0,
      inclusiveLastOffset: String(index + 1),
    }))
    const lineage = Object.values(sourceTopics).map((sourceTopic, index) => ({
      sourceTopic,
      sourcePartition: 0,
      firstOffset: String(index + 1),
      lastOffset: String(index + 1),
      recordCount: 1,
    }))
    const snapshotMaterial = {
      schemaVersion: 'bayn.intraday-market-snapshot.v1' as const,
      sessionDate: executionDate,
      calendar: { ...calendarMaterial, normalizedResponseHash: calendar.normalizedResponseHash },
      rangeStartAt: '2020-05-01T13:30:00.000Z',
      rangeEndAt: '2020-05-01T13:35:00.000Z',
      observedAt: '2020-05-01T13:35:30.000Z',
      universeId: protocol.universeId,
      universeSymbolHash: protocol.universeSymbolHash,
      symbols: protocol.universe,
      feed: protocol.feed,
      delayClass: protocol.delayClass,
      sourceTopics,
      archiveWatermarks,
      maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
      minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1_000,
      barCount: protocol.universe.length * protocol.openingRangeMinutes,
      quoteCount: protocol.universe.length,
      tradeCount: protocol.universe.length,
      barsContentHash: '1'.repeat(64),
      quotesContentHash: '2'.repeat(64),
      tradesContentHash: '3'.repeat(64),
      lineage,
    } as const
    const snapshotContentHash = canonicalHashV1(snapshotMaterial)
    const { schemaVersion: snapshotSchemaVersion, ...executionMarketDataMaterial } = snapshotMaterial
    const executionMarketData = {
      schemaVersion: 'bayn.execution-market-data-binding.v1' as const,
      snapshotSchemaVersion,
      ...executionMarketDataMaterial,
      contentHash: snapshotContentHash,
      snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash: snapshotContentHash }),
    }
    const prepared = Result.getOrThrow(
      prepareObservePlanner(
        {
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: openingDriveExecutionModel,
          policy,
          reconcile: Effect.succeed(reconciliationResult(generationHash, Authority.Execution)),
          strategy,
        },
        {
          reconciliation: reconciliationResult(generationHash, Authority.Execution),
          evaluatedAt: executionMarketData.observedAt,
        },
        {
          decision,
          signalDate,
          priceMicros: Object.fromEntries(protocol.universe.map((symbol) => [symbol, '100000000'])),
          bidPriceMicros: Object.fromEntries(protocol.universe.map((symbol) => [symbol, '99900000'])),
          askPriceMicros: Object.fromEntries(protocol.universe.map((symbol) => [symbol, '100000000'])),
          maximumBuyQuantityMicros: Object.fromEntries(protocol.universe.map((symbol) => [symbol, '1000000000'])),
          executionMarketData,
        },
        { allocationCapitalMicros: '80000000000' },
      ),
    )

    expect(policy).toMatchObject({
      schemaVersion: 'bayn.execution-risk-policy.v3',
      allowedOrderTypes: [OrderType.Limit],
      allowedTimeInForce: [TimeInForce.ImmediateOrCancel],
    })
    expect(prepared.plannerInput).toMatchObject({
      schemaVersion: 'bayn.target-planner-input.quote-bound.v1',
      allocationCapitalMicros: '80000000000',
      referencePrices: {
        schemaVersion: 'bayn.intraday-snapshot-reference-prices.v1',
        observedAt: executionMarketData.observedAt,
        snapshotId: executionMarketData.snapshotId,
        snapshotContentHash: executionMarketData.contentHash,
        priceReference: 'verified-adverse-quote-boundary',
      },
      executionTerms: {
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
        snapshotId: executionMarketData.snapshotId,
        snapshotContentHash: executionMarketData.contentHash,
        maximumBuyQuantityMicros: Object.fromEntries(protocol.universe.map((symbol) => [symbol, '1000000000'])),
      },
    })
    const { contentHash, ...referencePriceMaterial } = prepared.plannerInput.referencePrices
    expect(contentHash).toBe(canonicalHashV1(referencePriceMaterial))
    expect(prepared.plannerInput.policyHash).toBe(canonicalHashV1(policy))
  })

  test('builds one exact cycle-bound non-dispatchable decision from same-pass inputs', async () => {
    const snapshotRequests: unknown[] = []
    const calendarQueries: unknown[] = []
    let strategyCalls = 0
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      return yield* buildObserveCycleDecision({
        authorityGenerationHash: generationHash,
        cycle,
        executionModel: fixtureProtocol.executionModel,
        policy,
        reconcile: Effect.succeed(reconciliationResult()),
        strategy: runtimeWithDecision(() => {
          strategyCalls += 1
          return Result.succeed(decision)
        }),
      })
    }).pipe(
      (program) => provideDecisionServices(program, marketData(snapshotRequests), calendarRead(calendarQueries)),
      Effect.provide(TestClock.layer()),
    )

    const document = await Effect.runPromise(program)

    expect(snapshotRequests).toEqual([
      {
        snapshotId,
        signalSessionDate: signalDate,
        signalCalendarVersion: 'fixture-calendar-v2',
      },
    ])
    expect(calendarQueries).toEqual([{ start: signalDate, end: '2020-05-30' }])
    expect(strategyCalls).toBe(1)
    expect(document).toMatchObject({
      mode: 'OBSERVE',
      dispatchable: false,
      bindings: {
        cycleId: cycle.identity.cycleId,
        snapshotId,
        accountId,
      },
      targetPlan: {
        status: 'PLANNED',
        intentTargets: [
          {
            symbol: fixtureProtocol.universe[0],
            side: 'BUY',
            quantityMicros: expect.stringMatching(/^[1-9][0-9]*$/),
          },
        ],
      },
      deltaRisk: [
        {
          evaluation: {
            decision: {
              outcome: RiskOutcome.Blocked,
              reasonCodes: [Reason.AuthorityNotGranted],
            },
          },
        },
      ],
      createdAt: evaluatedAt,
      expiresAt: cycle.window.submissionCutoffAt,
    })
  })

  test('builds a truthful immutable PAPER decision from the exact authority generation', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      return yield* buildMutationShadowCycleDecision({
        authorityGenerationHash: generationHash,
        cycle,
        executionModel: fixtureProtocol.executionModel,
        policy,
        reconcile: Effect.succeed(reconciliationResult(generationHash, Authority.Execution)),
        strategy: runtimeWithDecision(() => Result.succeed(decision)),
      })
    }).pipe(
      (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
      Effect.provide(TestClock.layer()),
    )

    const document = await Effect.runPromise(program)

    expect(document).toMatchObject({
      schemaVersion: 'bayn.paper-cycle-decision.v1',
      mode: 'PAPER',
      dispatchable: true,
      bindings: {
        accountId,
        cycleId: cycle.identity.cycleId,
        qualificationRunId: cycle.identity.qualificationRunId,
        authorityGenerationHash: generationHash,
      },
      deltaRisk: [
        {
          evaluation: {
            decision: {
              outcome: RiskOutcome.Approved,
              reasonCodes: [],
            },
          },
        },
      ],
    })
    expect(document.orderedIntentIds).toEqual([document.deltaRisk[0]?.evaluation.input.intentId])

    const { contentHash: _contentHash, ...material } = document
    const target = material.targetPlan.intentTargets[0]
    const risk = material.deltaRisk[0]
    expect(target).toBeDefined()
    expect(risk).toBeDefined()
    if (target === undefined || risk === undefined) return expect.unreachable('PAPER decision target evidence missing')

    const alteredGeneration = makeExecutionDecisionDocument({
      ...material,
      bindings: { ...material.bindings, authorityGenerationHash: '9'.repeat(64) },
    })
    const alteredTarget = makeExecutionDecisionDocument({
      ...material,
      targetPlan: {
        ...material.targetPlan,
        intentTargets: [{ ...target, accountId: 'different-paper-account' }],
      },
    })
    const alteredOrder = makeExecutionDecisionDocument({
      ...material,
      orderedIntentIds: ['8'.repeat(64)],
    })
    const alteredCumulativeRisk = makeExecutionDecisionDocument({
      ...material,
      deltaRisk: [
        {
          ...risk,
          evaluation: {
            ...risk.evaluation,
            metrics: {
              ...risk.evaluation.metrics,
              aggregateBuyingPowerMicros: (BigInt(risk.evaluation.metrics.aggregateBuyingPowerMicros) + 1n).toString(),
            },
          },
        },
      ],
    })
    const alteredExpiry = makeExecutionDecisionDocument({
      ...material,
      expiresAt: utcInstantFromEpochMillis(Date.parse(material.expiresAt) - 1),
    })

    for (const altered of [alteredGeneration, alteredTarget, alteredOrder, alteredCumulativeRisk, alteredExpiry]) {
      expect(Result.isFailure(altered)).toBe(true)
    }
  })

  test('binds a high-balance PAPER account to the episode capital budget before risk evaluation', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const highBalanceAccount: AccountSnapshot = {
      ...account,
      cashMicros: '100000000000',
      equityMicros: '100000000000',
      buyingPowerMicros: '400000000000',
    }
    const fullyAllocatedDecision: DecisionPlan = {
      ...decision,
      targetWeights: {
        DBC: 0.1946,
        EFA: 0.2151,
        IEF: 0,
        SPY: 0.35,
        VNQ: 0.2403,
      },
    }
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      return yield* buildMutationShadowCycleDecision({
        authorityGenerationHash: generationHash,
        cycle,
        executionModel: fixtureProtocol.executionModel,
        policy,
        reconcile: Effect.succeed(
          reconciliationResult(generationHash, Authority.Execution, [], [], highBalanceAccount),
        ),
        strategy: runtimeWithDecision(() => Result.succeed(fullyAllocatedDecision)),
      })
    }).pipe(
      (effect) => provideDecisionServices(effect, marketData([]), calendarRead([])),
      Effect.provide(TestClock.layer()),
    )

    const document = await Effect.runPromise(program)
    const plannedNotional = BigInt(document.targetPlan.requiredReferenceBuyNotionalMicros)

    expect(plannedNotional).toBeGreaterThan(99_000_000_000n)
    expect(plannedNotional).toBeLessThanOrEqual(BigInt(policy.maxGrossExposureMicros))
    expect(plannedNotional).toBeLessThan(BigInt(policy.maxDailyTradedNotionalMicros))
    expect(document.riskBlock).toBeUndefined()
    expect(document).toMatchObject({ mode: 'PAPER', dispatchable: true })
    expect(document.deltaRisk).toHaveLength(4)
    expect(
      document.deltaRisk.every(
        ({ evaluation }) =>
          evaluation.decision.outcome === RiskOutcome.Approved && evaluation.decision.reasonCodes.length === 0,
      ),
    ).toBe(true)
  })

  test('rejects a PAPER entry before planning when existing exposure cannot fit remaining turnover', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const highBalanceAccount: AccountSnapshot = {
      ...account,
      cashMicros: '100000000000',
      equityMicros: '100000000000',
      buyingPowerMicros: '400000000000',
    }
    const existingPosition: Position = {
      schemaVersion: 'bayn.paper-position.v1',
      accountId,
      symbol: 'SPY',
      quantityMicros: '10000000000',
      averageEntryPriceMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '1000000000000',
      unrealizedPnlMicros: '0',
      observedAt: reconciledAt,
    }
    const reconciled = reconciliationResult(
      generationHash,
      Authority.Execution,
      [existingPosition],
      [],
      highBalanceAccount,
    )
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(evaluatedAt))
          return yield* buildMutationShadowCycleDecision({
            authorityGenerationHash: generationHash,
            cycle,
            executionModel: fixtureProtocol.executionModel,
            policy,
            reconcile: Effect.succeed({
              ...reconciled,
              riskContext: {
                ...reconciled.riskContext,
                dailyTradedNotionalMicros: '750000000',
              },
            }),
            strategy: runtimeWithDecision(() => Result.succeed(decision)),
          })
        }).pipe(
          (effect) => provideDecisionServices(effect, marketData([]), calendarRead([])),
          Effect.provide(TestClock.layer()),
        ),
      ),
    )

    expect(failure).toMatchObject({
      _tag: 'ObserveDecisionCompositionFailure',
      operation: 'execution-mandate-allocation',
      cause: { _tag: 'CurrentExposureExceedsRemainingTurnover' },
    })
  })

  test('fails closed when same-pass reconciliation observes another authority generation', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    let strategyCalls = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(evaluatedAt))
          return yield* buildObserveCycleDecision({
            authorityGenerationHash: generationHash,
            cycle,
            executionModel: fixtureProtocol.executionModel,
            policy,
            reconcile: Effect.succeed(reconciliationResult('9'.repeat(64))),
            strategy: runtimeWithDecision(() => {
              strategyCalls += 1
              return Result.succeed(decision)
            }),
          })
        }).pipe(
          (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
          Effect.provide(TestClock.layer()),
        ),
      ),
    )

    expect(failure).toEqual({
      _tag: 'ObserveDecisionCompositionFailure',
      operation: 'observe-authority',
      message: 'same-pass reconciliation did not return the configured OBSERVE authority',
      cause: undefined,
    })
    expect(strategyCalls).toBe(0)
  })

  test('fails closed when same-pass reconciliation risk context is from another trading date', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const reconciled = reconciliationResult()
    let strategyCalls = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(evaluatedAt))
          return yield* buildObserveCycleDecision({
            authorityGenerationHash: generationHash,
            cycle,
            executionModel: fixtureProtocol.executionModel,
            policy,
            reconcile: Effect.succeed({
              ...reconciled,
              riskContext: { ...reconciled.riskContext, tradingDate: signalDate as IsoDate },
            }),
            strategy: runtimeWithDecision(() => {
              strategyCalls += 1
              return Result.succeed(decision)
            }),
          })
        }).pipe(
          (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
          Effect.provide(TestClock.layer()),
        ),
      ),
    )

    expect(failure).toEqual({
      _tag: 'ObserveDecisionCompositionFailure',
      operation: 'cycle-binding',
      message: 'same-pass reconciliation risk context is not from the execution session date',
      cause: undefined,
    })
    expect(strategyCalls).toBe(0)
  })

  test('maps an expected strategy decision failure into the typed operational channel', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const strategyFailure = {
      _tag: 'CurrentDecisionCoverageMismatch' as const,
      signalDate: signalDate as IsoDate,
      expectedSymbols: fixtureProtocol.universe,
      observedSymbols: [],
    }
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(evaluatedAt))
          return yield* buildObserveCycleDecision({
            authorityGenerationHash: generationHash,
            cycle,
            executionModel: fixtureProtocol.executionModel,
            policy,
            reconcile: Effect.succeed(reconciliationResult()),
            strategy: runtimeWithDecision(() => Result.fail(strategyFailure)),
          })
        }).pipe(
          (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
          Effect.provide(TestClock.layer()),
        ),
      ),
    )

    expect(failure._tag).toBe('OperationalError')
    if (failure._tag === 'OperationalError') {
      expect(failure.component).toBe('strategy')
      expect(failure.operation).toBe('current-decision')
      expect(failure.message).toStartWith('current strategy decision compilation failed')
      expect(failure.cause).toBe(strategyFailure)
    }
  })

  test('preserves a thrown strategy decision bug as the identical Effect defect', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const defect = new Error('unexpected current-decision defect')
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        return yield* buildObserveCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixtureProtocol.executionModel,
          policy,
          reconcile: Effect.succeed(reconciliationResult()),
          strategy: runtimeWithDecision(() => {
            throw defect
          }),
        })
      }).pipe(
        (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const defects = exit.cause.reasons.flatMap((reason) => (Cause.isDieReason(reason) ? [reason.defect] : []))
      expect(defects).toContain(defect)
    }
  })

  test('closes read and reconciliation failures with their operational classifications and exact causes', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const snapshotCause = operationalError({
      component: 'market-data',
      operation: 'load',
      message: 'snapshot fixture failed',
    })
    const calendarRootCause = { _tag: 'CalendarTransportFixtureFailure' }
    const calendarCause = new BrokerReadError({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.Transport,
      message: 'calendar fixture failed',
      retryable: true,
      cause: calendarRootCause,
    })
    const reconciliationReadCause = new BrokerReadError({
      operation: 'orders',
      kind: BrokerReadErrorKind.Transport,
      message: 'reconciliation broker read fixture failed',
      retryable: true,
    })
    const reconciliationStoreCause = new ExecutionStoreError({
      operation: 'reconciliation',
      failure: 'query',
      message: 'reconciliation store fixture failed',
    })
    const reconciliationFenceCause = new WriterFenceError({
      operation: 'transaction',
      failure: 'unavailable',
      message: 'reconciliation fence fixture failed',
    })
    const reconciliationDomainCause = new ReconciliationError({
      operation: 'snapshot',
      message: 'reconciliation snapshot fixture failed',
    })
    const cases = [
      {
        expectedComponent: 'market-data',
        expectedOperation: 'load-snapshot-publication',
        cause: snapshotCause,
        marketData: {
          ...marketData([]),
          loadSnapshotPublication: () => Effect.fail(snapshotCause),
        },
        marketCalendar: calendarRead([]),
        reconcile: Effect.succeed(reconciliationResult()),
      },
      {
        expectedComponent: 'market-data',
        expectedOperation: 'market-calendar',
        cause: calendarCause,
        marketData: marketData([]),
        marketCalendar: () => Effect.fail(calendarCause),
        reconcile: Effect.succeed(reconciliationResult()),
      },
      {
        expectedComponent: 'market-data',
        expectedOperation: 'reconciliation',
        cause: reconciliationReadCause,
        marketData: marketData([]),
        marketCalendar: calendarRead([]),
        reconcile: Effect.fail(reconciliationReadCause),
      },
      {
        expectedComponent: 'database',
        expectedOperation: 'reconciliation',
        cause: reconciliationStoreCause,
        marketData: marketData([]),
        marketCalendar: calendarRead([]),
        reconcile: Effect.fail(reconciliationStoreCause),
      },
      {
        expectedComponent: 'database',
        expectedOperation: 'reconciliation',
        cause: reconciliationFenceCause,
        marketData: marketData([]),
        marketCalendar: calendarRead([]),
        reconcile: Effect.fail(reconciliationFenceCause),
      },
      {
        expectedComponent: 'strategy',
        expectedOperation: 'reconciliation',
        cause: reconciliationDomainCause,
        marketData: marketData([]),
        marketCalendar: calendarRead([]),
        reconcile: Effect.fail(reconciliationDomainCause),
      },
    ] as const

    for (const testCase of cases) {
      const failure = await Effect.runPromise(
        Effect.flip(
          buildObserveCycleDecision({
            authorityGenerationHash: generationHash,
            cycle,
            executionModel: fixtureProtocol.executionModel,
            policy,
            reconcile: testCase.reconcile,
            strategy: runtimeWithDecision(() => Result.succeed(decision)),
          }).pipe((program) => provideDecisionServices(program, testCase.marketData, testCase.marketCalendar)),
        ),
      )

      expect(failure._tag).toBe('OperationalError')
      if (failure._tag !== 'OperationalError') return expect.unreachable(failure._tag)
      expect(failure.component).toBe(testCase.expectedComponent)
      expect(failure.operation).toBe(testCase.expectedOperation)
      expect(failure.cause).toBe(testCase.cause)
    }
  })

  test('keeps startup and one externally driven pass explicit at separate composition boundaries', async () => {
    const unused = Effect.die(new Error('missing-publication loop must not use this capability'))
    const authority = reconciliationResult().riskContext.authority
    if (authority === null) return expect.unreachable('fixture authority is required')
    type TestStore = BrokerEventStoreShape &
      FillAccountingStoreShape &
      ValuationStoreShape &
      ReconciliationStoreShape &
      AuthorityGenerationStoreShape &
      AuthorityRestrictionStoreShape
    const executionStore: TestStore = {
      ingest: () => unused,
      ingestPositions: () => unused,
      account: () => unused,
      value: () => unused,
      hasAccountBaseline: () => unused,
      bindings: () => unused,
      reconcile: () => unused,
      ensureAuthorityGeneration: () => Effect.succeed(authority),
      restrictAuthority: () => unused,
    }
    const cycleStore: CycleStoreShape = {
      acquire: () => unused,
      read: () => unused,
      readAuthoritySlot: () => unused,
      readDecisionDocument: () => unused,
      readOldestUnfinished: () => Effect.succeed(Option.none()),
      bindSnapshot: () => unused,
      activate: () => unused,
      bindDecision: () => unused,
      finish: () => unused,
      block: () => unused,
    }
    const brokerRead: BrokerReadShape = {
      account: unused,
      accountConfiguration: unused,
      assetBySymbol: unusedAssetBySymbol,
      positions: unused,
      orders: () => unused,
      orderById: () => unused,
      orderByClientId: () => unused,
      fillActivities: () => unused,
      marketCalendar: () => unused,
    }
    const marketDataService: MarketDataService = {
      ...marketData([]),
      inspectCyclePublications: Effect.succeed({
        outcome: 'MISSING',
        observedAt: '2026-01-30T21:20:00.000Z',
      }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: unused,
      transaction: (effect) => effect,
    }
    const capturedDriver = Effect.runSync(Deferred.make<RecoveryFirstCycleDriver>())
    const startup = makeObserveAutonomousCycleStartup(
      {
        accountId,
        authorityGenerationHash: generationHash,
        pollIntervalMs: 30_000,
        reconciliationIntervalMs: 30_000,
        reconciliationPassTimeoutMs: 30_000,
        strategy: fixtureRuntime,
      },
      (driver) => Deferred.succeed(capturedDriver, driver).pipe(Effect.andThen(Effect.never)),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const acquireLoop: Effect.Effect<
            AutonomousCycleLoop<
              | BrokerRead
              | CycleStore
              | MarketData
              | BrokerEventStore
              | FillAccountingStore
              | ValuationStore
              | ReconciliationStore
              | AuthorityGenerationStore
              | AuthorityRestrictionStore
              | IntentStore
              | MutationStore
              | WriterFence
            >,
            OperationalError,
            AuthorityGenerationStore
          > = startup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: () => Effect.die('driver publication must not execute a cycle pass'),
          })
          const loop = yield* acquireLoop.pipe(Effect.provideService(AuthorityGenerationStore, executionStore))
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(MarketData, marketDataService),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(IntentStore, {} as IntentStoreService),
            Effect.provideService(MutationStore, {} as MutationStoreShape),
            Effect.provideService(WriterFence, writerFence),
            Effect.forkScoped,
          )
          const driver = yield* Deferred.await(capturedDriver).pipe(Effect.timeout('1 second'))
          expect(driver.nextDelayMs).toBe(30_000)
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )
  })

  test('one Restate advance runs reconciliation and lifecycle work without a background scheduler or broker mutation', async () => {
    const signalSessionDate: IsoDate = '2020-04-29'
    const calendarMaterial = {
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
      source: 'alpaca-v2-calendar' as const,
      requestedRange: { start: signalSessionDate, end: '2020-05-29' },
      timeZone: 'UTC' as const,
      sessions: [
        {
          date: signalSessionDate,
          openAt: '2020-04-29T13:30:00.000Z',
          closeAt: '2020-04-29T20:00:00.000Z',
        },
        {
          date: signalDate,
          openAt: '2020-04-30T13:30:00.000Z',
          closeAt: '2020-04-30T20:00:00.000Z',
        },
      ],
    }
    const ordinaryCalendar: MarketCalendarObservation = {
      ...calendarMaterial,
      normalizedResponseHash: canonicalHashV1(calendarMaterial),
    }
    const readEvidence = (identity: string): ReadEvidence => ({
      requestId: `not-due-${identity}`,
      status: 200,
      contentHash: canonicalHashV1({ identity }),
      observedAt: reconciledAt,
    })
    const brokerAccount: BrokerAccount = {
      id: accountId,
      status: BrokerAccountStatus.Active,
      currency: 'USD',
      cashMicros: account.cashMicros,
      equityMicros: account.equityMicros,
      lastEquityMicros: account.equityMicros,
      buyingPowerMicros: account.buyingPowerMicros,
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
      observedAt: reconciledAt,
    }
    let accountReads = 0
    let positionReads = 0
    let orderReads = 0
    let fillReads = 0
    let calendarReads = 0
    let mutationPhase = false
    let mutationCalendarReads = 0
    let mutationReconciliations = 0
    let nextReconciliationFailure: ExecutionStoreError | undefined
    let secondMutationCalendarRead: Deferred.Deferred<void> | undefined
    const mutationEvents: string[] = []
    const unusedRead = Effect.die(new Error('NOT_DUE reconciliation used an unrelated broker read'))
    const brokerRead: BrokerReadShape = {
      account: Effect.sync(() => {
        accountReads += 1
        return { value: brokerAccount, evidence: readEvidence('account') }
      }),
      accountConfiguration: unusedRead,
      assetBySymbol: unusedAssetBySymbol,
      positions: Effect.sync(() => {
        positionReads += 1
        return { value: [], evidence: readEvidence('positions') }
      }),
      orders: () =>
        Effect.sync(() => {
          orderReads += 1
          return { value: [], evidence: readEvidence(`orders-${orderReads}`) }
        }),
      orderById: () => unusedRead,
      orderByClientId: () => unusedRead,
      fillActivities: () =>
        Effect.sync(() => {
          fillReads += 1
          return { value: { items: [] }, evidence: readEvidence(`fills-${fillReads}`) }
        }),
      marketCalendar: (query) => {
        expect(query).toEqual(calendarMaterial.requestedRange)
        calendarReads += 1
        if (!mutationPhase) {
          return Effect.succeed({ value: ordinaryCalendar, evidence: readEvidence('calendar') })
        }
        mutationCalendarReads += 1
        mutationEvents.push(`calendar:${mutationCalendarReads.toString()}`)
        const result = { value: ordinaryCalendar, evidence: readEvidence('calendar') }
        return mutationCalendarReads === 2 && secondMutationCalendarRead !== undefined
          ? Deferred.succeed(secondMutationCalendarRead, undefined).pipe(Effect.as(result))
          : Effect.succeed(result)
      },
    }
    const inspection = {
      manifest: snapshot.manifest,
      sessionDates: [signalSessionDate],
      signalSession: {
        calendar_version: 'fixture-calendar-v2',
        session_date: signalSessionDate,
        close_time: '16:00',
        timezone: 'America/New_York' as const,
      },
    }
    const marketDataService: MarketDataService = {
      ...marketData([]),
      inspectCyclePublications: Effect.succeed({
        outcome: 'FINALIZED',
        observedAt: '2020-04-29T22:00:00.000Z',
        publications: [inspection],
      }),
    }
    let acquisitions = 0
    const unusedCycleStore = Effect.die(new Error('NOT_DUE pass attempted to mutate cycle state'))
    const cycleStore: CycleStoreShape = {
      acquire: () => {
        acquisitions += 1
        return unusedCycleStore
      },
      read: () => unusedCycleStore,
      readAuthoritySlot: () => Effect.succeed(Option.none()),
      readDecisionDocument: () => unusedCycleStore,
      readOldestUnfinished: () => Effect.succeed(Option.none()),
      bindSnapshot: () => unusedCycleStore,
      activate: () => unusedCycleStore,
      bindDecision: () => unusedCycleStore,
      finish: () => unusedCycleStore,
      block: () => unusedCycleStore,
    }
    const exact = reconciliationResult()
    const persisted: ReconciliationWriteResult = {
      reconciliation: exact.report.reconciliation,
      metrics: exact.report.metrics,
      accountingHash: exact.brokerState.accountingHash,
      riskContext: exact.riskContext,
    }
    const reconciledSnapshots: BrokerSnapshot[] = []
    let brokerEventWrites = 0
    let positionWrites = 0
    let valuationWrites = 0
    let authorityRestrictions = 0
    const unusedAccounting = Effect.die(new Error('empty NOT_DUE reconciliation must not account a fill'))
    const executionStore = {
      ingest: () =>
        Effect.sync(() => {
          brokerEventWrites += 1
          return { eventId: '1'.repeat(64), sourceSequence: '1', deduplicated: false }
        }),
      ingestPositions: () =>
        Effect.sync(() => {
          positionWrites += 1
          return { snapshotId: '2'.repeat(64), eventIds: [], deduplicated: false }
        }),
      account: () => unusedAccounting,
      value: () =>
        Effect.sync(() => {
          valuationWrites += 1
          return {
            schemaVersion: 'bayn.paper-valuation.v1' as const,
            valuationId: '3'.repeat(64),
            accountId,
            sourceHash: '4'.repeat(64),
            cashMicros: account.cashMicros,
            longMarketValueMicros: '0',
            shortMarketValueMicros: '0',
            equityMicros: account.equityMicros,
            asOf: reconciledAt,
          }
        }),
      hasAccountBaseline: () => Effect.succeed(true),
      bindings: () => Effect.succeed([]),
      reconcile: (brokerSnapshot: BrokerSnapshot) =>
        Effect.suspend(() => {
          if (nextReconciliationFailure !== undefined) {
            const failure = nextReconciliationFailure
            nextReconciliationFailure = undefined
            mutationEvents.push('reconcile-failed')
            return Effect.fail(failure)
          }
          return Effect.sync(() => {
            reconciledSnapshots.push(brokerSnapshot)
            if (mutationPhase) {
              mutationReconciliations += 1
              mutationEvents.push(`reconcile:${mutationReconciliations.toString()}`)
            }
            return persisted
          })
        }),
      ensureAuthorityGeneration: () => {
        const authority = exact.riskContext.authority
        return authority === null
          ? Effect.die(new Error('NOT_DUE fixture requires OBSERVE authority'))
          : Effect.succeed(authority)
      },
      restrictAuthority: () =>
        Effect.sync(() => {
          authorityRestrictions += 1
        }),
    } satisfies BrokerEventStoreShape &
      FillAccountingStoreShape &
      ValuationStoreShape &
      ReconciliationStoreShape &
      AuthorityGenerationStoreShape &
      AuthorityRestrictionStoreShape
    let fencedTransactions = 0
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: (effect) =>
        Effect.sync(() => {
          fencedTransactions += 1
        }).pipe(Effect.andThen(effect)),
    }
    const startup = makeObserveAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: fixtureRuntime,
    })

    const observation = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(reconciledAt))
          const pass = yield* Deferred.make<Parameters<Parameters<typeof startup>[0]['recordPass']>[0]>()
          const loop = yield* startup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: (result) => Deferred.succeed(pass, result).pipe(Effect.asVoid),
          }).pipe(Effect.provideService(AuthorityGenerationStore, executionStore))
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(MarketData, marketDataService),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(IntentStore, {} as IntentStoreService),
            Effect.provideService(MutationStore, {} as MutationStoreShape),
            Effect.provideService(WriterFence, writerFence),
            Effect.forkScoped({ startImmediately: true }),
          )
          const result = yield* Deferred.await(pass).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
          return result
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observation).toMatchObject({ result: 'SUCCESS', outcome: 'NOT_DUE' })
    expect(acquisitions).toBe(0)
    expect(accountReads).toBe(1)
    expect(positionReads).toBe(1)
    expect(orderReads).toBe(2)
    expect(fillReads).toBe(2)
    expect(brokerEventWrites).toBe(1)
    expect(positionWrites).toBe(1)
    expect(valuationWrites).toBe(1)
    expect(reconciledSnapshots).toHaveLength(1)
    expect(reconciledSnapshots[0]).toMatchObject({
      account,
      positions: [],
      orders: [],
      fills: [],
      reconciledAt,
    })
    expect(fencedTransactions).toBe(1)
    expect(authorityRestrictions).toBe(0)

    const mutationStartup = makeMutationAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 100,
      reconciliationIntervalMs: 100,
      reconciliationPassTimeoutMs: 30_000,
      strategy: fixtureRuntime,
      executionProgram: sandboxExecutionProgram(),
    })
    const intentStore = {} as IntentStoreService
    const mutationStore = {} as MutationStoreShape
    const mutationObservations: Parameters<Parameters<typeof mutationStartup>[0]['recordPass']>[0][] = []
    mutationPhase = true
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(reconciledAt))
          const first = yield* Deferred.make<void>()
          const second = yield* Deferred.make<void>()
          secondMutationCalendarRead = yield* Deferred.make<void>()
          const loop = yield* mutationStartup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: (result) =>
              Effect.sync(() => {
                mutationObservations.push(result)
                mutationEvents.push(`observe:${mutationObservations.length.toString()}`)
                return mutationObservations.length === 1
                  ? first
                  : mutationObservations.length === 2
                    ? second
                    : undefined
              }).pipe(
                Effect.flatMap((completion) =>
                  completion === undefined ? Effect.void : Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
                ),
              ),
          })
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(MarketData, marketDataService),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(WriterFence, writerFence),
            Effect.provideService(IntentStore, intentStore),
            Effect.provideService(MutationStore, mutationStore),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(first).pipe(Effect.timeout('1 second'))
          yield* TestClock.adjust(100)
          yield* Deferred.await(secondMutationCalendarRead).pipe(Effect.timeout('1 second'))
          yield* Deferred.await(second).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
    mutationPhase = false

    expect(mutationObservations.length).toBeGreaterThanOrEqual(2)
    expect(mutationObservations[0]).toMatchObject({ result: 'SUCCESS', outcome: 'NOT_DUE' })
    expect(mutationObservations[1]).toMatchObject({ result: 'SUCCESS', outcome: 'NOT_DUE' })
    expect(mutationEvents.indexOf('reconcile:2')).toBeLessThan(mutationEvents.indexOf('calendar:2'))
    expect(mutationEvents.indexOf('calendar:2')).toBeLessThan(mutationEvents.indexOf('observe:2'))
    expect(mutationCalendarReads).toBe(2)
    expect(mutationReconciliations).toBe(2)
    expect(acquisitions).toBe(0)
    expect(calendarReads).toBe(3)
    expect(accountReads).toBe(3)
    expect(positionReads).toBe(3)
    expect(orderReads).toBe(6)
    expect(fillReads).toBe(6)
    expect(brokerEventWrites).toBe(3)
    expect(positionWrites).toBe(3)
    expect(valuationWrites).toBe(3)
    expect(reconciledSnapshots).toHaveLength(3)
    expect(reconciledSnapshots[2]).toMatchObject({
      account,
      positions: [],
      orders: [],
      fills: [],
    })
    expect(fencedTransactions).toBe(3)
    expect(authorityRestrictions).toBe(0)

    mutationEvents.length = 0
    mutationReconciliations = 0
    const nonIdleObservations: Parameters<Parameters<typeof mutationStartup>[0]['recordPass']>[0][] = []
    const calendarReadsBeforeNonIdle = calendarReads
    let publicationReads = 0
    let secondPublicationRead: Deferred.Deferred<void> | undefined
    const missingPublicationMarketData: MarketDataService = {
      ...marketData([]),
      inspectCyclePublications: Effect.suspend(() => {
        publicationReads += 1
        mutationEvents.push(`publication:${publicationReads.toString()}`)
        const result = {
          outcome: 'MISSING' as const,
          observedAt: '2020-04-29T22:00:00.000Z',
        }
        return publicationReads === 2 && secondPublicationRead !== undefined
          ? Deferred.succeed(secondPublicationRead, undefined).pipe(Effect.as(result))
          : Effect.succeed(result)
      }),
    }
    mutationPhase = true
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(reconciledAt))
          const first = yield* Deferred.make<void>()
          const second = yield* Deferred.make<void>()
          secondPublicationRead = yield* Deferred.make<void>()
          const loop = yield* mutationStartup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: (observation) =>
              Effect.sync(() => {
                nonIdleObservations.push(observation)
                mutationEvents.push(`observe:${nonIdleObservations.length.toString()}`)
                return nonIdleObservations.length === 1 ? first : nonIdleObservations.length === 2 ? second : undefined
              }).pipe(
                Effect.flatMap((completion) =>
                  completion === undefined ? Effect.void : Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
                ),
              ),
          })
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(MarketData, missingPublicationMarketData),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(WriterFence, writerFence),
            Effect.provideService(IntentStore, intentStore),
            Effect.provideService(MutationStore, mutationStore),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(first).pipe(Effect.timeout('1 second'))
          yield* TestClock.adjust(100)
          yield* Deferred.await(secondPublicationRead).pipe(Effect.timeout('1 second'))
          yield* Deferred.await(second).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
    mutationPhase = false

    expect(nonIdleObservations).toHaveLength(2)
    expect(nonIdleObservations[0]).toMatchObject({ result: 'SUCCESS', outcome: 'NO_PUBLICATION' })
    expect(nonIdleObservations[1]).toMatchObject({ result: 'SUCCESS', outcome: 'NO_PUBLICATION' })
    expect(mutationEvents.indexOf('reconcile:1')).toBeLessThan(mutationEvents.indexOf('publication:1'))
    expect(mutationEvents.indexOf('publication:1')).toBeLessThan(mutationEvents.indexOf('observe:1'))
    expect(mutationEvents.indexOf('reconcile:2')).toBeLessThan(mutationEvents.indexOf('publication:2'))
    expect(mutationEvents.indexOf('publication:2')).toBeLessThan(mutationEvents.indexOf('observe:2'))
    expect(publicationReads).toBe(2)
    expect(mutationReconciliations).toBe(2)
    expect(calendarReads).toBe(calendarReadsBeforeNonIdle)
    expect(authorityRestrictions).toBe(0)

    mutationEvents.length = 0
    mutationReconciliations = 0
    publicationReads = 0
    const externalObservations: Parameters<Parameters<typeof mutationStartup>[0]['recordPass']>[0][] = []
    let lifecycleMaintenanceRuns = 0
    let lifecycleFinalizationRuns = 0
    let externalNextDelayMs: number | undefined
    const externalStartup = makeMutationAutonomousCycleStartup(
      {
        accountId,
        authorityGenerationHash: generationHash,
        pollIntervalMs: 100,
        reconciliationIntervalMs: 100,
        reconciliationPassTimeoutMs: 30_000,
        strategy: fixtureRuntime,
        executionProgram: sandboxExecutionProgram(),
        lifecycleMaintenance: {
          beforeReconciliation: Effect.sync(() => {
            lifecycleMaintenanceRuns += 1
            mutationEvents.push(`maintenance:${lifecycleMaintenanceRuns.toString()}`)
          }),
          afterReconciliation: Effect.sync(() => {
            lifecycleFinalizationRuns += 1
            mutationEvents.push(`finalize:${lifecycleFinalizationRuns.toString()}`)
            return lifecycleFinalizationRuns === 3 ? ('COMPLETED' as const) : ('CONTINUE' as const)
          }),
        },
      },
      (driver) =>
        Effect.gen(function* () {
          externalNextDelayMs = driver.nextDelayMs
          yield* driver.advance.pipe(Effect.orDie)
          yield* TestClock.adjust(100)
          yield* driver.advance.pipe(Effect.orDie)
          const beforeIdle = {
            lifecycleMaintenanceRuns,
            lifecycleFinalizationRuns,
            mutationReconciliations,
            publicationReads,
          }
          yield* TestClock.adjust(driver.nextDelayMs * 5)
          yield* Effect.yieldNow
          expect({
            lifecycleMaintenanceRuns,
            lifecycleFinalizationRuns,
            mutationReconciliations,
            publicationReads,
          }).toEqual(beforeIdle)
          yield* driver.advance.pipe(Effect.orDie)
        }),
    )
    mutationPhase = true
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(reconciledAt))
        const loop = yield* externalStartup({
          qualificationRunId: 'c'.repeat(64),
          recordPass: (observation) =>
            Effect.sync(() => {
              externalObservations.push(observation)
              mutationEvents.push(`external-observe:${externalObservations.length.toString()}`)
            }),
        })
        yield* loop.pipe(
          Effect.provideService(BrokerRead, brokerRead),
          Effect.provideService(CycleStore, cycleStore),
          Effect.provideService(MarketData, missingPublicationMarketData),
          Effect.provideService(BrokerEventStore, executionStore),
          Effect.provideService(FillAccountingStore, executionStore),
          Effect.provideService(ValuationStore, executionStore),
          Effect.provideService(ReconciliationStore, executionStore),
          Effect.provideService(AuthorityGenerationStore, executionStore),
          Effect.provideService(AuthorityRestrictionStore, executionStore),
          Effect.provideService(WriterFence, writerFence),
          Effect.provideService(IntentStore, intentStore),
          Effect.provideService(MutationStore, mutationStore),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    mutationPhase = false

    expect(externalNextDelayMs).toBe(100)
    expect(externalObservations).toHaveLength(3)
    expect(externalObservations[0]).toMatchObject({ result: 'SUCCESS', outcome: 'NO_PUBLICATION' })
    expect(externalObservations[1]).toMatchObject({ result: 'SUCCESS', outcome: 'NO_PUBLICATION' })
    expect(externalObservations[2]).toMatchObject({ result: 'SUCCESS', outcome: 'RECOVERED' })
    expect(lifecycleMaintenanceRuns).toBe(3)
    expect(lifecycleFinalizationRuns).toBe(3)
    expect(mutationReconciliations).toBe(3)
    expect(mutationEvents.indexOf('maintenance:1')).toBeLessThan(mutationEvents.indexOf('reconcile:1'))
    expect(mutationEvents.indexOf('reconcile:1')).toBeLessThan(mutationEvents.indexOf('finalize:1'))
    expect(mutationEvents.indexOf('maintenance:2')).toBeLessThan(mutationEvents.indexOf('reconcile:2'))
    expect(mutationEvents.indexOf('reconcile:2')).toBeLessThan(mutationEvents.indexOf('finalize:2'))
    expect(mutationEvents.indexOf('maintenance:3')).toBeLessThan(mutationEvents.indexOf('reconcile:3'))
    expect(mutationEvents.indexOf('reconcile:3')).toBeLessThan(mutationEvents.indexOf('finalize:3'))
    expect(mutationEvents.indexOf('reconcile:1')).toBeLessThan(mutationEvents.indexOf('publication:1'))
    expect(mutationEvents.indexOf('reconcile:2')).toBeLessThan(mutationEvents.indexOf('publication:2'))
    expect(mutationEvents).not.toContain('publication:3')
    expect(mutationEvents.filter((event) => event.startsWith('publication:'))).toHaveLength(2)

    mutationEvents.length = 0
    mutationReconciliations = 0
    publicationReads = 0
    const externalTimeoutObservations: Parameters<Parameters<typeof mutationStartup>[0]['recordPass']>[0][] = []
    let timeoutMaintenanceRuns = 0
    let timeoutFinalizationRuns = 0
    mutationPhase = true
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(reconciledAt))
        const maintenanceEntered = yield* Deferred.make<void>()
        const externalTimeoutStartup = makeMutationAutonomousCycleStartup(
          {
            accountId,
            authorityGenerationHash: generationHash,
            pollIntervalMs: 100,
            reconciliationIntervalMs: 100,
            reconciliationPassTimeoutMs: 50,
            strategy: fixtureRuntime,
            executionProgram: sandboxExecutionProgram(),
            lifecycleMaintenance: {
              beforeReconciliation: Effect.suspend(() => {
                timeoutMaintenanceRuns += 1
                return timeoutMaintenanceRuns === 1
                  ? Deferred.succeed(maintenanceEntered, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.void
              }),
              afterReconciliation: Effect.sync(() => {
                timeoutFinalizationRuns += 1
                return 'CONTINUE' as const
              }),
            },
          },
          (driver) =>
            Effect.gen(function* () {
              const advance = yield* driver.advance.pipe(Effect.forkChild({ startImmediately: true }))
              yield* Deferred.await(maintenanceEntered)
              yield* TestClock.adjust(50)
              yield* Fiber.join(advance).pipe(Effect.orDie)
              yield* TestClock.adjust(driver.nextDelayMs)
              yield* driver.advance.pipe(Effect.orDie)
            }),
        )
        const loop = yield* externalTimeoutStartup({
          qualificationRunId: 'c'.repeat(64),
          recordPass: (observation) =>
            Effect.sync(() => {
              externalTimeoutObservations.push(observation)
            }),
        })
        yield* loop.pipe(
          Effect.provideService(BrokerRead, brokerRead),
          Effect.provideService(CycleStore, cycleStore),
          Effect.provideService(MarketData, missingPublicationMarketData),
          Effect.provideService(BrokerEventStore, executionStore),
          Effect.provideService(FillAccountingStore, executionStore),
          Effect.provideService(ValuationStore, executionStore),
          Effect.provideService(ReconciliationStore, executionStore),
          Effect.provideService(AuthorityGenerationStore, executionStore),
          Effect.provideService(AuthorityRestrictionStore, executionStore),
          Effect.provideService(WriterFence, writerFence),
          Effect.provideService(IntentStore, intentStore),
          Effect.provideService(MutationStore, mutationStore),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    mutationPhase = false

    expect(externalTimeoutObservations).toEqual([
      expect.objectContaining({
        result: 'FAILURE',
        operation: 'run-cycle-pass',
        failure: 'operational',
        message: 'mutation autonomous cycle pass did not complete or reconcile within 50ms',
      }),
      expect.objectContaining({ result: 'SUCCESS', outcome: 'NO_PUBLICATION' }),
    ])
    expect(timeoutMaintenanceRuns).toBe(2)
    expect(timeoutFinalizationRuns).toBe(1)
    expect(mutationReconciliations).toBe(1)
    expect(publicationReads).toBe(1)
    expect(authorityRestrictions).toBe(1)
    authorityRestrictions = 0

    mutationEvents.length = 0
    mutationReconciliations = 0
    publicationReads = 0
    nextReconciliationFailure = new ExecutionStoreError({
      operation: 'reconciliation',
      failure: 'query',
      message: 'Restate advance reconciliation persistence failed',
    })
    const externalFailureObservations: Parameters<Parameters<typeof mutationStartup>[0]['recordPass']>[0][] = []
    const externalFailureStartup = makeMutationAutonomousCycleStartup(
      {
        accountId,
        authorityGenerationHash: generationHash,
        pollIntervalMs: 100,
        reconciliationIntervalMs: 100,
        reconciliationPassTimeoutMs: 30_000,
        strategy: fixtureRuntime,
        executionProgram: sandboxExecutionProgram(),
      },
      (driver) =>
        Effect.gen(function* () {
          yield* driver.advance.pipe(Effect.orDie)
          yield* TestClock.adjust(100)
          yield* driver.advance.pipe(Effect.orDie)
        }),
    )
    mutationPhase = true
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(reconciledAt))
        const loop = yield* externalFailureStartup({
          qualificationRunId: 'c'.repeat(64),
          recordPass: (observation) =>
            Effect.sync(() => {
              externalFailureObservations.push(observation)
              mutationEvents.push(`external-failure-observe:${externalFailureObservations.length.toString()}`)
            }),
        })
        yield* loop.pipe(
          Effect.provideService(BrokerRead, brokerRead),
          Effect.provideService(CycleStore, cycleStore),
          Effect.provideService(MarketData, missingPublicationMarketData),
          Effect.provideService(BrokerEventStore, executionStore),
          Effect.provideService(FillAccountingStore, executionStore),
          Effect.provideService(ValuationStore, executionStore),
          Effect.provideService(ReconciliationStore, executionStore),
          Effect.provideService(AuthorityGenerationStore, executionStore),
          Effect.provideService(AuthorityRestrictionStore, executionStore),
          Effect.provideService(WriterFence, writerFence),
          Effect.provideService(IntentStore, intentStore),
          Effect.provideService(MutationStore, mutationStore),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    mutationPhase = false

    expect(externalFailureObservations).toHaveLength(2)
    expect(externalFailureObservations[0]).toMatchObject({
      result: 'FAILURE',
      operation: 'reconcile-not-due',
      message: 'same-pass reconciliation store operation failed: Restate advance reconciliation persistence failed',
    })
    expect(externalFailureObservations[1]).toMatchObject({ result: 'SUCCESS', outcome: 'NO_PUBLICATION' })
    expect(publicationReads).toBe(1)
    expect(mutationReconciliations).toBe(1)
    expect(mutationEvents.indexOf('reconcile-failed')).toBeLessThan(
      mutationEvents.indexOf('external-failure-observe:1'),
    )
    expect(mutationEvents.indexOf('reconcile:1')).toBeLessThan(mutationEvents.indexOf('publication:1'))
    expect(authorityRestrictions).toBe(1)
    authorityRestrictions = 0

    const paperResult = reconciliationResult(generationHash, Authority.Execution)
    const paperAuthority = paperResult.riskContext.authority
    if (paperAuthority === null) return expect.unreachable('post-reconcile fixture requires PAPER authority')
    const paperPersisted: ReconciliationWriteResult = {
      reconciliation: paperResult.report.reconciliation,
      metrics: paperResult.report.metrics,
      accountingHash: paperResult.brokerState.accountingHash,
      riskContext: paperResult.riskContext,
    }
    const postReconcilePolicy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const postReconcileDocument = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        return yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixtureProtocol.executionModel,
          policy: postReconcilePolicy,
          reconcile: Effect.succeed(paperResult),
          strategy: runtimeWithDecision(() => Result.succeed(decision)),
        })
      }).pipe(
        (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
        Effect.provide(TestClock.layer()),
      ),
    )
    const postReconcileCycle = Effect.runSync(
      decodeAutonomousCycle({
        ...cycle,
        bindings: { ...cycle.bindings, decisionHash: postReconcileDocument.contentHash },
        stateVersion: cycle.stateVersion + 1,
        updatedAt: evaluatedAt,
      }),
    )
    const boundaryTarget = postReconcileDocument.targetPlan.intentTargets[0]
    const boundaryRisk = postReconcileDocument.deltaRisk[0]
    if (boundaryTarget === undefined || boundaryRisk === undefined) {
      return expect.unreachable('post-mutation timeout fixture requires one approved intent')
    }
    const boundaryIntent = await Effect.runPromise(
      planExecutionIntent(
        {
          schemaVersion: 'bayn.paper-intent-plan.v1',
          ...boundaryTarget,
          notionalLimitMicros: boundaryRisk.notionalLimitMicros,
          createdAt: postReconcileDocument.createdAt,
        },
        { authority: paperAuthority },
      ),
    )
    const boundaryRecord = storedIntent(boundaryIntent, IntentState.Approved, postReconcileDocument.createdAt)
    const boundaryAccepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '5'.repeat(64),
      mutationId: '6'.repeat(64),
      intentId: boundaryIntent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '7'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'post-mutation-timeout-boundary',
      occurredAt: postReconcileDocument.createdAt,
    }
    let boundaryReconciliations = 0
    let boundaryIntentReadDelayed = false
    let boundaryMutationPersisted = false

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(postReconcileDocument.createdAt))
          const intentReadStarted = yield* Deferred.make<void>()
          const mutationSettled = yield* Deferred.make<void>()
          const preMutationReconciled = yield* Deferred.make<void>()
          const postMutationReconciled = yield* Deferred.make<void>()
          const pass =
            yield* Deferred.make<
              Parameters<Parameters<ReturnType<typeof makeMutationAutonomousCycleStartup>>[0]['recordPass']>[0]
            >()
          const boundaryExecutionStore = {
            ...executionStore,
            reconcile: () =>
              Effect.sync(() => {
                boundaryReconciliations += 1
                return boundaryReconciliations
              }).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Deferred.succeed(preMutationReconciled, undefined).pipe(Effect.as(paperPersisted))
                    : count === 3
                      ? Deferred.succeed(postMutationReconciled, undefined).pipe(Effect.andThen(Effect.never))
                      : Effect.succeed(paperPersisted),
                ),
              ),
            ensureAuthorityGeneration: () => Effect.succeed(paperAuthority),
          } satisfies BrokerEventStoreShape &
            FillAccountingStoreShape &
            ValuationStoreShape &
            ReconciliationStoreShape &
            AuthorityGenerationStoreShape &
            AuthorityRestrictionStoreShape
          const unusedBoundaryCycle = Effect.die(
            new Error('post-mutation timeout fixture used an unrelated cycle-store operation'),
          )
          const boundaryCycleStore: CycleStoreShape = {
            acquire: () => unusedBoundaryCycle,
            read: () => unusedBoundaryCycle,
            readAuthoritySlot: () => unusedBoundaryCycle,
            readDecisionDocument: () => Effect.succeed(Option.some(postReconcileDocument)),
            readOldestUnfinished: () => Effect.succeed(Option.some(postReconcileCycle)),
            bindSnapshot: () => unusedBoundaryCycle,
            activate: () => unusedBoundaryCycle,
            bindDecision: () => unusedBoundaryCycle,
            finish: () => unusedBoundaryCycle,
            block: () => unusedBoundaryCycle,
          }
          const boundaryIntentStore: IntentStoreService = {
            commit: () => Effect.succeed({ record: boundaryRecord, deduplicated: true }),
            commitClosing: () => Effect.succeed({ record: boundaryRecord, deduplicated: true }),
            read: (intentId) => {
              expect(intentId).toBe(boundaryIntent.intentId)
              if (boundaryIntentReadDelayed) return Effect.succeed(Option.some(boundaryRecord))
              boundaryIntentReadDelayed = true
              return Deferred.succeed(intentReadStarted, undefined).pipe(
                Effect.andThen(Effect.sleep(49)),
                Effect.as(Option.some(boundaryRecord)),
              )
            },
          }
          const boundaryMutationStore = {
            latest: (_intentId: string, operation: MutationOperation) =>
              Effect.succeed(
                boundaryMutationPersisted && operation === MutationOperation.Submit ? boundaryAccepted : undefined,
              ),
          } as unknown as MutationStoreShape
          const boundaryExecutionProgram: ExecutionProgram = {
            ...sandboxExecutionProgram(),
            submit: (intentId, consistencyDelayMs) => {
              expect(intentId).toBe(boundaryIntent.intentId)
              expect(consistencyDelayMs).toBe(boundaryAccepted.consistencyDelayMs)
              return Deferred.succeed(mutationSettled, undefined).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    boundaryMutationPersisted = true
                  }),
                ),
                Effect.as(boundaryAccepted),
              )
            },
            recover: (intentId) => {
              expect(intentId).toBe(boundaryIntent.intentId)
              return Effect.succeed(boundaryAccepted)
            },
          }
          const boundaryStartup = makeMutationAutonomousCycleStartup({
            accountId,
            authorityGenerationHash: generationHash,
            pollIntervalMs: 10_000,
            reconciliationIntervalMs: 100,
            reconciliationPassTimeoutMs: 50,
            strategy: fixtureRuntime,
            executionProgram: boundaryExecutionProgram,
          })
          const loop = yield* boundaryStartup({
            qualificationRunId: postReconcileCycle.identity.qualificationRunId,
            recordPass: (observation) => Deferred.succeed(pass, observation).pipe(Effect.asVoid),
          })
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, { ...brokerRead, marketCalendar: calendarRead([]) }),
            Effect.provideService(CycleStore, boundaryCycleStore),
            Effect.provideService(MarketData, marketData([])),
            Effect.provideService(BrokerEventStore, boundaryExecutionStore),
            Effect.provideService(FillAccountingStore, boundaryExecutionStore),
            Effect.provideService(ValuationStore, boundaryExecutionStore),
            Effect.provideService(ReconciliationStore, boundaryExecutionStore),
            Effect.provideService(AuthorityGenerationStore, boundaryExecutionStore),
            Effect.provideService(AuthorityRestrictionStore, boundaryExecutionStore),
            Effect.provideService(WriterFence, writerFence),
            Effect.provideService(IntentStore, boundaryIntentStore),
            Effect.provideService(MutationStore, boundaryMutationStore),
            Effect.forkScoped({ startImmediately: true }),
          )
          const initial = yield* TestClock.withLive(
            Effect.race(
              Deferred.await(intentReadStarted).pipe(Effect.as('INTENT_READ' as const)),
              Fiber.await(fiber).pipe(Effect.map((exit) => ({ _tag: 'FIBER_EXIT' as const, exit }))),
            ).pipe(
              Effect.timeout('1 second'),
              Effect.mapError(() => new Error('timed out waiting for delayed intent read')),
            ),
          )
          if (initial !== 'INTENT_READ')
            throw new Error(`mutation loop exited before intent read: ${String(initial.exit)}`)
          yield* TestClock.adjust(49)
          yield* TestClock.withLive(
            Deferred.await(preMutationReconciled).pipe(
              Effect.timeout('1 second'),
              Effect.mapError(() => new Error('timed out waiting for pre-mutation reconciliation')),
            ),
          )
          yield* TestClock.withLive(
            Deferred.await(mutationSettled).pipe(
              Effect.timeout('1 second'),
              Effect.mapError(() => new Error('timed out waiting for durable mutation settlement')),
            ),
          )
          const observation = yield* TestClock.withLive(
            Deferred.await(pass).pipe(
              Effect.timeout('1 second'),
              Effect.mapError(() => new Error('timed out waiting for post-mutation Restate continuation')),
            ),
          )
          expect(observation).toMatchObject({
            result: 'SUCCESS',
            outcome: 'RECOVERED',
          })
          expect(boundaryReconciliations).toBe(2)
          expect(authorityRestrictions).toBe(0)
          yield* TestClock.adjust(99)
          expect(boundaryReconciliations).toBe(2)
          yield* TestClock.adjust(1)
          yield* TestClock.withLive(
            Deferred.await(postMutationReconciled).pipe(
              Effect.timeout('1 second'),
              Effect.mapError(() => new Error('timed out waiting for Restate-owned post-mutation reconciliation')),
            ),
          )
          expect(boundaryReconciliations).toBe(3)
          expect(authorityRestrictions).toBe(0)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(boundaryReconciliations).toBe(3)
    expect(authorityRestrictions).toBe(0)
  })

  test('bounds the complete writer-fenced reconciliation pass and interrupts stalled persistence', async () => {
    const signalSessionDate: IsoDate = '2020-04-29'
    const calendarMaterial = {
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
      source: 'alpaca-v2-calendar' as const,
      requestedRange: { start: signalSessionDate, end: '2020-05-29' },
      timeZone: 'UTC' as const,
      sessions: [
        {
          date: signalSessionDate,
          openAt: '2020-04-29T13:30:00.000Z',
          closeAt: '2020-04-29T20:00:00.000Z',
        },
        {
          date: signalDate,
          openAt: '2020-04-30T13:30:00.000Z',
          closeAt: '2020-04-30T20:00:00.000Z',
        },
      ],
    }
    const ordinaryCalendar: MarketCalendarObservation = {
      ...calendarMaterial,
      normalizedResponseHash: canonicalHashV1(calendarMaterial),
    }
    const readEvidence = (identity: string): ReadEvidence => ({
      requestId: `bounded-pass-${identity}`,
      status: 200,
      contentHash: canonicalHashV1({ identity }),
      observedAt: reconciledAt,
    })
    const brokerAccount: BrokerAccount = {
      id: accountId,
      status: BrokerAccountStatus.Active,
      currency: 'USD',
      cashMicros: account.cashMicros,
      equityMicros: account.equityMicros,
      lastEquityMicros: account.equityMicros,
      buyingPowerMicros: account.buyingPowerMicros,
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
      observedAt: reconciledAt,
    }
    const brokerRead: BrokerReadShape = {
      account: Effect.succeed({ value: brokerAccount, evidence: readEvidence('account') }),
      accountConfiguration: Effect.die(new Error('bounded reconciliation used account configuration')),
      assetBySymbol: unusedAssetBySymbol,
      positions: Effect.succeed({ value: [], evidence: readEvidence('positions') }),
      orders: () => Effect.succeed({ value: [], evidence: readEvidence('orders') }),
      orderById: () => Effect.die(new Error('bounded reconciliation used order lookup')),
      orderByClientId: () => Effect.die(new Error('bounded reconciliation used client-order lookup')),
      fillActivities: () => Effect.succeed({ value: { items: [] }, evidence: readEvidence('fills') }),
      marketCalendar: (query) => {
        expect(query).toEqual(calendarMaterial.requestedRange)
        return Effect.succeed({ value: ordinaryCalendar, evidence: readEvidence('calendar') })
      },
    }
    const marketDataService: MarketDataService = {
      ...marketData([]),
      inspectCyclePublications: Effect.succeed({
        outcome: 'FINALIZED',
        observedAt: '2020-04-29T22:00:00.000Z',
        publications: [
          {
            manifest: snapshot.manifest,
            sessionDates: [signalSessionDate],
            signalSession: {
              calendar_version: 'fixture-calendar-v2',
              session_date: signalSessionDate,
              close_time: '16:00',
              timezone: 'America/New_York' as const,
            },
          },
        ],
      }),
    }
    const unusedCycleStore = Effect.die(new Error('bounded NOT_DUE pass attempted to mutate cycle state'))
    const cycleStore: CycleStoreShape = {
      acquire: () => unusedCycleStore,
      read: () => unusedCycleStore,
      readAuthoritySlot: () => Effect.succeed(Option.none()),
      readDecisionDocument: () => unusedCycleStore,
      readOldestUnfinished: () => Effect.succeed(Option.none()),
      bindSnapshot: () => unusedCycleStore,
      activate: () => unusedCycleStore,
      bindDecision: () => unusedCycleStore,
      finish: () => unusedCycleStore,
      block: () => unusedCycleStore,
    }
    const exact = reconciliationResult()
    const authority = exact.riskContext.authority
    expect(authority).not.toBeNull()
    if (authority === null) expect.unreachable('bounded reconciliation fixture requires authority')
    const unusedAccounting = Effect.die(new Error('empty reconciliation must not account a fill'))
    let authorityRestrictions = 0
    let fencedTransactions = 0

    const observation = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(reconciledAt))
          const persistenceStarted = yield* Deferred.make<void>()
          const persistenceInterrupted = yield* Deferred.make<void>()
          const pass =
            yield* Deferred.make<
              Parameters<Parameters<ReturnType<typeof makeObserveAutonomousCycleStartup>>[0]['recordPass']>[0]
            >()
          const executionStore = {
            ingest: () => Effect.succeed({ eventId: '1'.repeat(64), sourceSequence: '1', deduplicated: false }),
            ingestPositions: () => Effect.succeed({ snapshotId: '2'.repeat(64), eventIds: [], deduplicated: false }),
            account: () => unusedAccounting,
            value: () =>
              Effect.succeed({
                schemaVersion: 'bayn.paper-valuation.v1' as const,
                valuationId: '3'.repeat(64),
                accountId,
                sourceHash: '4'.repeat(64),
                cashMicros: account.cashMicros,
                longMarketValueMicros: '0',
                shortMarketValueMicros: '0',
                equityMicros: account.equityMicros,
                asOf: reconciledAt,
              }),
            hasAccountBaseline: () => Effect.succeed(true),
            bindings: () => Effect.succeed([]),
            reconcile: () =>
              Deferred.succeed(persistenceStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(persistenceInterrupted, undefined).pipe(Effect.asVoid)),
              ),
            ensureAuthorityGeneration: () => Effect.succeed(authority),
            restrictAuthority: () =>
              Effect.sync(() => {
                authorityRestrictions += 1
              }),
          } satisfies BrokerEventStoreShape &
            FillAccountingStoreShape &
            ValuationStoreShape &
            ReconciliationStoreShape &
            AuthorityGenerationStoreShape &
            AuthorityRestrictionStoreShape
          const writerFence: WriterFenceService = {
            backendPid: 1,
            check: Effect.void,
            transaction: (effect) =>
              Effect.sync(() => {
                fencedTransactions += 1
              }).pipe(Effect.andThen(effect)),
          }
          const startup = makeObserveAutonomousCycleStartup({
            accountId,
            authorityGenerationHash: generationHash,
            pollIntervalMs: 1_000,
            reconciliationIntervalMs: 100,
            reconciliationPassTimeoutMs: 50,
            strategy: fixtureRuntime,
          })
          const loop = yield* startup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: (result) => Deferred.succeed(pass, result).pipe(Effect.asVoid),
          }).pipe(Effect.provideService(AuthorityGenerationStore, executionStore))
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(MarketData, marketDataService),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(IntentStore, {} as IntentStoreService),
            Effect.provideService(MutationStore, {} as MutationStoreShape),
            Effect.provideService(WriterFence, writerFence),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(persistenceStarted)
          yield* TestClock.adjust(51)
          const result = yield* Deferred.await(pass).pipe(Effect.timeout('1 second'))
          yield* Deferred.await(persistenceInterrupted).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
          return result
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observation).toMatchObject({
      result: 'FAILURE',
      operation: 'reconcile-not-due',
      failure: 'market-data',
      message: 'same-pass broker reconciliation timed out after 50ms',
    })
    expect(fencedTransactions).toBe(1)
    expect(authorityRestrictions).toBe(0)
  })

  test('terminalizes an unbound PAPER cycle and refuses new discovery after the entry-authority cutoff', async () => {
    const cutoffAt = '2020-05-01T12:45:00.000Z'
    const observedAt = '2020-05-01T12:45:01.000Z'
    const terminalCycle = Effect.runSync(
      decodeAutonomousCycle({
        ...cycle,
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.Authority,
        stateVersion: cycle.stateVersion + 1,
        updatedAt: observedAt,
        terminalAt: observedAt,
      }),
    )
    const forbidden = (capability: string) => Effect.die(new Error(`cutoff recovery must not use ${capability}`))
    let blocked = 0
    let terminal = false
    const cycleStore: CycleStoreShape = {
      acquire: () => forbidden('cycle acquisition'),
      read: () => forbidden('cycle read by ID'),
      readAuthoritySlot: () => forbidden('authority-slot read'),
      readOldestUnfinished: () => Effect.succeed(terminal ? Option.none() : Option.some(cycle)),
      readDecisionDocument: () => forbidden('decision document read'),
      bindSnapshot: () => forbidden('snapshot binding'),
      activate: () => forbidden('cycle activation'),
      bindDecision: () => forbidden('decision binding'),
      finish: () => forbidden('cycle finishing'),
      block: (cycleId, reason, blockAt) =>
        Effect.sync(() => {
          blocked += 1
          expect(cycleId).toBe(cycle.identity.cycleId)
          expect(reason).toBe(CycleTerminalReason.Authority)
          expect(blockAt).toBe(observedAt)
          terminal = true
          return { cycle: terminalCycle, changed: true }
        }),
    }
    const reconciliationServices = makeExactReconciliationServices()
    const brokerRead = reconciliationServices.brokerRead
    const executionStore = {
      ...reconciliationServices.executionStore,
      ensureAuthorityGeneration: () => forbidden('authority initialization'),
      restrictAuthority: () => forbidden('authority restriction'),
    } satisfies BrokerEventStoreShape &
      FillAccountingStoreShape &
      ValuationStoreShape &
      ReconciliationStoreShape &
      AuthorityGenerationStoreShape &
      AuthorityRestrictionStoreShape
    const marketDataService: MarketDataService = {
      check: forbidden('market-data health check'),
      inspect: forbidden('market-data inspection'),
      inspectCyclePublications: forbidden('cycle publication inspection'),
      inspectPublication: () => forbidden('publication inspection'),
      inspectSnapshotPublication: () => forbidden('snapshot publication inspection'),
      loadSnapshotPublication: () => forbidden('snapshot publication load'),
      load: forbidden('market-data load'),
    }
    const writerFence = reconciliationServices.writerFence
    const startup = makeMutationAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: fixtureRuntime,
      cycleCadence: 'EVERY_SESSION',
      executionProgram: sandboxExecutionProgram(),
      executionMandateCutoffAt: cutoffAt,
    })

    const observations = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(observedAt))
          const firstPass = yield* Deferred.make<Parameters<Parameters<typeof startup>[0]['recordPass']>[0]>()
          const secondPass = yield* Deferred.make<Parameters<Parameters<typeof startup>[0]['recordPass']>[0]>()
          let passCount = 0
          const loop = yield* startup({
            qualificationRunId: cycle.identity.qualificationRunId,
            recordPass: (result) => {
              const target = passCount === 0 ? firstPass : secondPass
              passCount += 1
              return Deferred.succeed(target, result).pipe(Effect.asVoid)
            },
          })
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(MarketData, marketDataService),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(IntentStore, {} as IntentStoreService),
            Effect.provideService(MutationStore, {} as MutationStoreShape),
            Effect.provideService(WriterFence, writerFence),
            Effect.forkScoped({ startImmediately: true }),
          )
          const first = yield* Deferred.await(firstPass).pipe(Effect.timeout('1 second'))
          yield* TestClock.adjust(30_000)
          const second = yield* Deferred.await(secondPass).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
          return [first, second] as const
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observations[0]).toMatchObject({ result: 'SUCCESS', outcome: 'RECOVERED' })
    expect(observations[1]).toMatchObject({ result: 'SUCCESS', outcome: 'NO_PUBLICATION' })
    expect(blocked).toBe(1)
    expect(terminal).toBe(true)
  })

  test('recovers a bound OBSERVE decision before entering PAPER intent or broker execution', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const document = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        return yield* buildObserveCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixtureProtocol.executionModel,
          policy,
          reconcile: Effect.succeed(reconciliationResult()),
          strategy: runtimeWithDecision(() => Result.succeed(decision)),
        })
      }).pipe(
        (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
        Effect.provide(TestClock.layer()),
      ),
    )
    const boundCycle = Effect.runSync(
      decodeAutonomousCycle({
        ...cycle,
        bindings: { ...cycle.bindings, decisionHash: document.contentHash },
        stateVersion: cycle.stateVersion + 1,
        updatedAt: document.createdAt,
      }),
    )
    const recoveredAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 1)
    const completedCycle = Effect.runSync(
      decodeAutonomousCycle({
        ...boundCycle,
        state: CycleState.Completed,
        stateVersion: boundCycle.stateVersion + 1,
        updatedAt: recoveredAt,
        terminalAt: recoveredAt,
      }),
    )
    let unfinishedReads = 0
    let documentReads = 0
    let finishes = 0
    let terminal = false
    const forbidden = (capability: string) => Effect.die(new Error(`OBSERVE recovery must not use ${capability}`))
    const cycleStore: CycleStoreShape = {
      acquire: () => forbidden('cycle acquisition'),
      read: () => forbidden('cycle read by ID'),
      readAuthoritySlot: () => forbidden('authority-slot read'),
      readOldestUnfinished: () =>
        Effect.sync(() => {
          unfinishedReads += 1
          return terminal ? Option.none() : Option.some(boundCycle)
        }),
      readDecisionDocument: (cycleId) =>
        Effect.sync(() => {
          documentReads += 1
          expect(cycleId).toBe(boundCycle.identity.cycleId)
          return Option.some(document)
        }),
      bindSnapshot: () => forbidden('snapshot binding'),
      activate: () => forbidden('cycle activation'),
      bindDecision: () => forbidden('decision binding'),
      finish: (cycleId, state, observedAt) =>
        Effect.sync(() => {
          finishes += 1
          expect(cycleId).toBe(boundCycle.identity.cycleId)
          expect(state).toBe(CycleState.Completed)
          expect(observedAt).toBe(recoveredAt)
          terminal = true
          return { cycle: completedCycle, changed: true }
        }),
      block: () => forbidden('cycle blocking'),
    }
    const reconciliationServices = makeExactReconciliationServices()
    const brokerRead = reconciliationServices.brokerRead
    const executionStore = {
      ...reconciliationServices.executionStore,
      ensureAuthorityGeneration: () => forbidden('authority initialization'),
      restrictAuthority: () => forbidden('authority restriction'),
    } satisfies BrokerEventStoreShape &
      FillAccountingStoreShape &
      ValuationStoreShape &
      ReconciliationStoreShape &
      AuthorityGenerationStoreShape &
      AuthorityRestrictionStoreShape
    const marketDataService: MarketDataService = {
      check: forbidden('market-data health check'),
      inspect: forbidden('market-data inspection'),
      inspectCyclePublications: forbidden('cycle publication inspection'),
      inspectPublication: () => forbidden('publication inspection'),
      inspectSnapshotPublication: () => forbidden('snapshot publication inspection'),
      loadSnapshotPublication: () => forbidden('snapshot publication load'),
      load: forbidden('market-data load'),
    }
    const writerFence = reconciliationServices.writerFence
    const startup = makeMutationAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: fixtureRuntime,
      executionProgram: sandboxExecutionProgram(),
    })

    const observation = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(recoveredAt))
          const pass = yield* Deferred.make<Parameters<Parameters<typeof startup>[0]['recordPass']>[0]>()
          const loop = yield* startup({
            qualificationRunId: boundCycle.identity.qualificationRunId,
            recordPass: (result) => Deferred.succeed(pass, result).pipe(Effect.asVoid),
          })
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(MarketData, marketDataService),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(WriterFence, writerFence),
            Effect.provideService(IntentStore, {} as IntentStoreService),
            Effect.provideService(MutationStore, {} as MutationStoreShape),
            Effect.forkScoped({ startImmediately: true }),
          )
          const result = yield* Deferred.await(pass).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
          return result
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observation).toMatchObject({ result: 'SUCCESS', outcome: 'RECOVERED' })
    expect(unfinishedReads).toBe(2)
    expect(documentReads).toBe(2)
    expect(finishes).toBe(1)
    expect(terminal).toBe(true)
  })

  test('starts mutation mode without projecting or initializing OBSERVE authority', async () => {
    const unused = Effect.die(new Error('missing-publication mutation loop must not use this capability'))
    let authorityInitializations = 0
    const reconciliationServices = makeExactReconciliationServices()
    const executionStore = {
      ...reconciliationServices.executionStore,
      ensureAuthorityGeneration: () =>
        Effect.sync(() => {
          authorityInitializations += 1
          throw new Error('mutation startup must not initialize OBSERVE authority')
        }),
      restrictAuthority: () => unused,
    } satisfies BrokerEventStoreShape &
      FillAccountingStoreShape &
      ValuationStoreShape &
      ReconciliationStoreShape &
      AuthorityGenerationStoreShape &
      AuthorityRestrictionStoreShape
    const cycleStore: CycleStoreShape = {
      acquire: () => unused,
      read: () => unused,
      readAuthoritySlot: () => unused,
      readDecisionDocument: () => unused,
      readOldestUnfinished: () => Effect.succeed(Option.none()),
      bindSnapshot: () => unused,
      activate: () => unused,
      bindDecision: () => unused,
      finish: () => unused,
      block: () => unused,
    }
    const brokerRead = reconciliationServices.brokerRead
    const marketDataService: MarketDataService = {
      ...marketData([]),
      inspectCyclePublications: Effect.succeed({
        outcome: 'MISSING',
        observedAt: '2026-01-30T21:20:00.000Z',
      }),
    }
    const writerFence = reconciliationServices.writerFence
    const intentStore = {} as IntentStoreService
    const mutationStore = {} as MutationStoreShape
    const startup = makeMutationAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: fixtureRuntime,
      executionProgram: sandboxExecutionProgram(),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pass = yield* Deferred.make<Parameters<Parameters<typeof startup>[0]['recordPass']>[0]>()
          const loop = yield* startup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: (observation) => Deferred.succeed(pass, observation).pipe(Effect.asVoid),
          })
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(MarketData, marketDataService),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(WriterFence, writerFence),
            Effect.provideService(IntentStore, intentStore),
            Effect.provideService(MutationStore, mutationStore),
            Effect.forkScoped,
          )
          const observation = yield* Deferred.await(pass).pipe(Effect.timeout('1 second'))
          expect(observation).toMatchObject({
            result: 'SUCCESS',
            outcome: 'NO_PUBLICATION',
          })
          expect(authorityInitializations).toBe(0)
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )
  })

  test('keeps the observe startup interface read-only by construction', () => {
    const startup = makeObserveAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: fixtureRuntime,
    })

    expect(typeof startup).toBe('function')
  })

  test('binds mutation startup to the exact guarded execution program authority and strategy identity', async () => {
    for (const executionProgram of [
      sandboxExecutionProgram('9'.repeat(64)),
      sandboxExecutionProgram(generationHash, {
        ...fixtureRuntime.provenance.strategy,
        behaviorHash: '8'.repeat(64),
      }),
    ]) {
      const startup = makeMutationAutonomousCycleStartup({
        accountId,
        authorityGenerationHash: generationHash,
        pollIntervalMs: 30_000,
        reconciliationIntervalMs: 30_000,
        reconciliationPassTimeoutMs: 30_000,
        strategy: fixtureRuntime,
        executionProgram,
      })

      const exit = await Effect.runPromise(
        Effect.exit(
          startup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: () => Effect.void,
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error('mismatched mutation startup unexpectedly succeeded')
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isNone(failure)) throw new Error('mismatched mutation startup failed without a typed cause')

      expect(failure.value).toMatchObject({
        _tag: 'OperationalError',
        component: 'config',
        operation: 'cycle-loop',
        message: 'mutation cycle execution program does not match its account, authority generation, and strategy',
      })
    }
  })
})
