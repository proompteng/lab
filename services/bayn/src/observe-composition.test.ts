import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import type { AutonomousCycleLoop } from './app'
import { fixtureProtocol, fixtureRuntime } from './testing/runtime-fixtures'
import {
  AccountStatus as BrokerAccountStatus,
  BrokerRead,
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
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
} from './cycle'
import { makeStrategyProtocolHash } from './contracts.test-support'
import { CycleStore, CycleStoreError, type CycleStoreShape } from './cycle/store'
import { decideCompletion, validateCompletionDocument } from './cycle/store/decisions'
import type { ReconciliationWriteResult } from './db/reconciliation'
import {
  BrokerEventStore,
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
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
import type { OperationalError } from './errors'
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
import { WriterFence, type WriterFenceService } from './execution/writer-fence'
import { canonicalHashV1 } from './hash'
import {
  IntradaySnapshotPurpose,
  MarketData,
  type IntradayMarketDataService,
  type IntradaySnapshotRequest,
  type MarketDataService,
  type MarketDataSnapshot,
} from './market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from './market-data/intraday/model'
import { intradayMomentumBehaviorHash, makeIntradayMomentumDefinition } from './strategy/intraday-momentum/decision'
import { intradayTestArchiveTopics, makeIntradayMomentumTestSnapshot } from './strategy/intraday-momentum/test-support'
import { decodeDefaultIntradayMomentumProtocol } from './strategy/intraday-momentum/protocol'
import { makePersistedSnapshotFixture } from './testing/persisted-snapshot-fixture'
import {
  buildMutationShadowCycleDecision,
  buildClosingExecutionCycleDecision,
  makeClosingDecisionPlan,
  appendPendingMutationOrder,
  blockedEntryRequiresCloseOnlyContainment,
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
  loadQuoteBoundExecutionRiskPolicy,
  loadStrategyExecutionRiskPolicy,
  makeMutationAutonomousCycleStartup as makeMutationAutonomousCycleStartupProduction,
  makeObserveAutonomousCycleStartup as makeObserveAutonomousCycleStartupProduction,
  prepareObserveStartup,
  recoveryFirstCycleNextDelayMs,
  terminalizeBlockedExecutionCycle,
  type MutationAutonomousCycleInput,
  type ObserveAutonomousCycleInput,
  type RecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverOwner,
} from './observe-composition'
import { selectClosingSymbolPass } from './observe-composition/decision-builder'
import { recoverBoundExecutionContext } from './observe-composition/execution-cycle'
import {
  compileIntradayMomentumDecision,
  evaluateIntradayMomentumDecision,
} from './observe-composition/intraday-momentum-decision'
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
import type { ReconciliationPassResult } from './reconciler'
import { reconciledStateHash } from './reconciliation'
import type { Policy } from './risk'
import { decodeExecutionDecisionDocument, makeExecutionDecisionDocument } from './shadow-decision-contract'
import { TargetPlanReason, TargetPlanStatus } from './target-planner'
import { utcInstantFromEpochMillis } from './time'
import type { DecisionPlan, IsoDate } from './types'

const signalDate = '2020-04-30'
const executionDate = '2020-05-01'
const accountId = 'paper-account-1'
const snapshotId = '7'.repeat(64)
const generationHash = 'a'.repeat(64)
const accountingHash = 'b'.repeat(64)
const reconciledAt = '2020-05-01T12:44:59.000Z'
const evaluatedAt = '2020-05-01T12:45:00.000Z'

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
      openAt: '2020-05-01T10:00:00.000Z',
      closeAt: '2020-05-01T16:30:00.000Z',
    },
  ],
} as const

const calendar: MarketCalendarObservation = {
  ...calendarMaterial,
  normalizedResponseHash: canonicalHashV1(calendarMaterial),
}

const currentIntradayProtocol = Result.getOrThrow(decodeDefaultIntradayMomentumProtocol())
const currentIntradayDefinition = makeIntradayMomentumDefinition(currentIntradayProtocol)
const currentIntradayRuntime = {
  definition: currentIntradayDefinition,
  provenance: {
    ...fixtureRuntime.provenance,
    strategy: {
      name: currentIntradayDefinition.name,
      behaviorHash: intradayMomentumBehaviorHash,
      parameterHash: canonicalHashV1(currentIntradayProtocol),
      parameterSchemaVersion: currentIntradayProtocol.schemaVersion,
    },
  },
}

const executionPolicyResult = makeCycleExecutionPolicyFromModel(currentIntradayProtocol.executionModel)
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
  schemaVersion: 'bayn.autonomous-cycle-identity.v3',
  strategyName: currentIntradayDefinition.name,
  qualificationRunId: generationHash,
  strategyProtocolHash: makeStrategyProtocolHash(currentIntradayRuntime.provenance.strategy),
  accountId,
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

const windowResult = makeIntradayCycleWindow(executionCalendar, executionPolicy)
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
    bindings: {},
    stateVersion: 3,
    createdAt: window.submissionOpenAt,
    updatedAt: window.submissionOpenAt,
  }),
)

const sourceManifest = makePersistedSnapshotFixture()
const { hash: _sourceManifestHash, ...sourceManifestMaterial } = sourceManifest
const snapshotManifest = {
  ...sourceManifestMaterial,
  finalizedSnapshot: {
    ...sourceManifestMaterial.finalizedSnapshot,
    snapshotId,
    finalizedAt: '2020-04-30T22:00:00.000Z',
  },
} as const
const snapshot: MarketDataSnapshot = {
  bars: [],
  manifest: { ...snapshotManifest, hash: canonicalHashV1(snapshotManifest) },
}

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
  strategy = currentIntradayRuntime.provenance.strategy,
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
  const heldPositions: readonly Position[] =
    strategyDecision === partialFillDecision
      ? [
          {
            schemaVersion: 'bayn.paper-position.v1',
            accountId,
            symbol: 'AMD',
            quantityMicros: '1000000',
            averageEntryPriceMicros: '10000000',
            marketPriceMicros: '10000000',
            marketValueMicros: '10000000',
            unrealizedPnlMicros: '0',
            observedAt: reconciledAt,
          },
        ]
      : []
  const intradayMarketData: IntradayMarketDataService = {
    check: Effect.void,
    captureVersion: () =>
      Effect.succeed(
        Object.values(intradayTestArchiveTopics)
          .sort()
          .map((sourceTopic) => ({
            sourceTopic,
            sourcePartition: 0,
            inclusiveLastOffset: String(
              currentIntradayProtocol.universe.length * currentIntradayProtocol.lookbackMinutes,
            ),
          })),
      ),
    loadSnapshot: (request) =>
      Effect.succeed(
        makeIntradayMomentumTestSnapshot(
          currentIntradayProtocol,
          request,
          { NVDA: 0.02 },
          10,
        ) as ArchiveVerifiedIntradayMarketSnapshot,
      ),
    verifyArchiveSnapshot: (snapshot) => Effect.succeed(snapshot as ArchiveVerifiedIntradayMarketSnapshot),
  }
  const input = {
    accountId,
    authorityGenerationHash: generationHash,
    pollIntervalMs: 30_000,
    reconciliationIntervalMs: 30_000,
    reconciliationPassTimeoutMs: 30_000,
    strategy: currentIntradayRuntime,
    intradayMarketData,
    executionProgram: sandboxExecutionProgram(),
  } as const
  const preparation = Result.getOrThrow(prepareObserveStartup(input))
  const policy = transformPolicy(
    await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, currentIntradayRuntime)),
  )
  const document = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      return yield* buildMutationShadowCycleDecision({
        authorityGenerationHash: generationHash,
        cycle,
        executionModel: currentIntradayProtocol.executionModel,
        policy,
        reconcile: Effect.succeed(reconciliationResult(generationHash, Authority.Execution, heldPositions)),
        strategy: currentIntradayRuntime,
        intradayMarketData,
      })
    }).pipe(
      (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
      Effect.provide(TestClock.layer()),
    ),
  )
  const boundCycle = Effect.runSync(
    decodeAutonomousCycle({
      ...cycle,
      bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
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
  test('recovers an unfinished intraday cycle only with the current source-controlled risk policy', async () => {
    const fixture = await executionLifecycleFixture()
    const currentProtocol = Result.getOrThrow(decodeDefaultIntradayMomentumProtocol())
    const currentDefinition = makeIntradayMomentumDefinition(currentProtocol)
    const currentStrategy = {
      definition: currentDefinition,
      provenance: {
        ...fixtureRuntime.provenance,
        strategy: {
          name: currentDefinition.name,
          behaviorHash: intradayMomentumBehaviorHash,
          parameterHash: canonicalHashV1(currentDefinition.parameters),
          parameterSchemaVersion: currentDefinition.parameters.schemaVersion,
        },
      },
    }
    const currentPolicy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, currentStrategy))

    const recovered = await Effect.runPromise(
      recoverBoundExecutionContext(currentPolicy, fixture.boundCycle, fixture.document),
    )

    expect(recovered.preparation.executionModel).toEqual(currentProtocol.executionModel)
    expect(recovered.policy).toEqual(currentPolicy)
    expect(recovered.policy.allowedSymbols).toEqual([...currentProtocol.universe].sort())
  })

  test('defers causally noncanonical quote-bound entry holdings to close-only containment', () => {
    const blocked = (reason: TargetPlanReason) => ({ status: TargetPlanStatus.Blocked, reason })
    const strategyUniverse = currentIntradayProtocol.universe

    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.ShortPositionNotAllowed),
        [{ symbol: 'AAPL', quantityMicros: '-1000000' }],
        ['AAPL'],
      ),
    ).toBe(true)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InputMismatch),
        [{ symbol: 'AAPL', quantityMicros: '500000' }],
        ['AAPL'],
      ),
    ).toBe(true)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.IdentityMismatch),
        [{ symbol: 'TSLA', quantityMicros: '1000000' }],
        strategyUniverse,
      ),
    ).toBe(true)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InsufficientBuyLiquidity),
        [{ symbol: 'AAPL', quantityMicros: '500000' }],
        ['AAPL'],
      ),
    ).toBe(true)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InsufficientBuyLiquidity),
        [{ symbol: 'AAPL', quantityMicros: '0' }],
        ['AAPL'],
      ),
    ).toBe(false)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InsufficientSellLiquidity),
        [{ symbol: 'AAPL', quantityMicros: '1000000' }],
        ['AAPL'],
      ),
    ).toBe(true)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InsufficientSellLiquidity),
        [{ symbol: 'AAPL', quantityMicros: '0' }],
        ['AAPL'],
      ),
    ).toBe(false)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InputStale),
        [{ symbol: 'AAPL', quantityMicros: '500000' }],
        ['AAPL'],
      ),
    ).toBe(false)
    expect(
      blockedEntryRequiresCloseOnlyContainment(
        blocked(TargetPlanReason.InputMismatch),
        [{ symbol: 'AAPL', quantityMicros: '1000000' }],
        ['AAPL'],
      ),
    ).toBe(false)
  })

  test('closes external holdings before quote-bound in-universe holdings', () => {
    const positions = [
      { symbol: 'AAPL', quantityMicros: '1000000' },
      { symbol: 'TSLA', quantityMicros: '2000000' },
    ]

    expect(selectClosingSymbolPass(positions, ['AAPL'])).toEqual({
      kind: 'broker-position',
      symbols: ['TSLA'],
    })
    expect(
      selectClosingSymbolPass(
        positions.filter(({ symbol }) => symbol === 'AAPL'),
        ['AAPL'],
      ),
    ).toEqual({ kind: 'quote-bound', symbols: ['AAPL'] })
  })

  test('uses the fractional pass only after external holdings are flat', () => {
    const positions = [
      { symbol: 'AAPL', quantityMicros: '500000' },
      { symbol: 'TSLA', quantityMicros: '250000' },
    ]

    expect(selectClosingSymbolPass(positions, ['AAPL'])).toEqual({
      kind: 'broker-position',
      symbols: ['TSLA'],
    })
    expect(
      selectClosingSymbolPass(
        positions.filter(({ symbol }) => symbol === 'AAPL'),
        ['AAPL'],
      ),
    ).toEqual({ kind: 'fractional', symbols: ['AAPL'] })
  })

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
      fixture.input,
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
    expect(decideReconciledExecutionCycleTerminalization(flatReconciliation, 'COMPLETE')).toEqual({
      _tag: 'Complete',
      observedAt: reconciliationCompletedAt,
    })
    expect(decideReconciledExecutionCycleTerminalization(flatReconciliation, 'MISSING')).toEqual({
      _tag: 'Block',
      reason: CycleTerminalReason.MissedSubmission,
      observedAt: reconciliationCompletedAt,
    })
    expect(decideReconciledExecutionCycleTerminalization(flatReconciliation, 'UNSUCCESSFUL')).toEqual({
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
    expect(fixture.intent.symbol).toBe('NVDA')
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
    const { executionSession: _legacyExecutionSession, ...legacyDocument } = fixture.document
    const legacyFailure = await buildClose(legacyDocument as typeof fixture.document).then(
      () => undefined,
      (cause: unknown) => cause,
    )

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
    expect(decideExecutionCycleCloseDocument({ ...close, dispatchable: false })).toEqual({ _tag: 'Block' })
    expect(legacyFailure).toMatchObject({
      _tag: 'CycleRunnerError',
      failure: 'contract',
      message: 'intraday close requires its persisted v3 execution-session binding',
    })

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
          strategyName: 'intraday-momentum',
          executionSessionDate: executionDate,
        },
        ['NVDA', 'AMD', 'NVDA'],
      ),
    )

    expect(close).toEqual({
      schemaVersion: 'bayn.execution-flat-target.v1',
      strategyName: 'intraday-momentum',
      sessionDate: executionDate,
      targetWeights: { AMD: 0, NVDA: 0 },
      symbols: ['AMD', 'NVDA'],
      reason: 'mandate-close',
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
      strategy: currentIntradayRuntime,
    })

    expect(Result.isSuccess(prepared)).toBe(true)
    if (Result.isSuccess(prepared)) {
      expect(prepared.success.strategyProtocolHash).toBe(
        makeStrategyProtocolHash(currentIntradayRuntime.provenance.strategy),
      )
    }
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
        warmupAfterOpenMs: 3_600_000,
        submissionCutoffBeforeCloseMs: 3_600_000,
      })
    }

    const customDefinition = makeIntradayMomentumDefinition({ ...protocol, lookbackMinutes: 10 })
    const customProtocol = prepareObserveStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: {
        definition: customDefinition,
        provenance: {
          ...fixtureRuntime.provenance,
          strategy: {
            name: customDefinition.name,
            behaviorHash: intradayMomentumBehaviorHash,
            parameterHash: canonicalHashV1(customDefinition.parameters),
            parameterSchemaVersion: customDefinition.parameters.schemaVersion,
          },
        },
      },
    })
    expect(Result.isFailure(customProtocol)).toBe(true)
    if (Result.isFailure(customProtocol)) {
      expect(customProtocol.failure.message).toBe(
        'intraday-momentum autonomous execution requires the source-controlled protocol',
      )
    }
  })

  test('builds an authority-gated intraday execution decision from verified archive data', async () => {
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
    const executionCalendar = Result.getOrThrow(
      makeExecutionCalendarObservation({
        schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
        source: 'alpaca-v2-calendar',
        date: executionDate,
        openAt: '2020-05-01T10:00:00.000Z',
        closeAt: '2020-05-01T16:30:00.000Z',
      }),
    )
    const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
    if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') {
      return expect.unreachable('intraday-momentum fixture requires the full-session execution policy')
    }
    const identity = Result.getOrThrow(
      makeCycleIdentity({
        schemaVersion: 'bayn.autonomous-cycle-identity.v3',
        strategyName: definition.name,
        qualificationRunId: generationHash,
        strategyProtocolHash: makeStrategyProtocolHash(strategy.provenance.strategy),
        accountId,
        executionSessionDate: executionCalendar.executionSessionDate,
        executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
        executionCalendarSource: executionCalendar.executionCalendarSource,
        executionCalendarHash: executionCalendar.executionCalendarHash,
        executionPolicy,
      }),
    )
    const window = Result.getOrThrow(makeIntradayCycleWindow(executionCalendar, executionPolicy))
    const activeCycle = Effect.runSync(
      decodeAutonomousCycle({
        ...Result.getOrThrow(makeCycleDraft(identity, window)),
        state: CycleState.Active,
        bindings: {},
        stateVersion: 3,
        createdAt: window.executionOpenAt,
        updatedAt: window.submissionOpenAt,
      }),
    )
    const observedAt = evaluatedAt
    const heldPosition: Position = {
      schemaVersion: 'bayn.paper-position.v1',
      accountId,
      symbol: 'AMD',
      quantityMicros: '1000000',
      averageEntryPriceMicros: '10000000',
      marketPriceMicros: '10000000',
      marketValueMicros: '10000000',
      unrealizedPnlMicros: '0',
      observedAt,
    }
    const archiveRequests: IntradaySnapshotRequest[] = []
    let displayedBidSizes: Readonly<Record<string, number>> = {}
    const archive: IntradayMarketDataService = {
      check: Effect.void,
      captureVersion: () =>
        Effect.succeed(
          Object.values(intradayTestArchiveTopics)
            .sort()
            .map((sourceTopic) => ({
              sourceTopic,
              sourcePartition: 0,
              inclusiveLastOffset: String(protocol.universe.length * protocol.lookbackMinutes),
            })),
        ),
      loadSnapshot: (request) =>
        Effect.sync(() => {
          archiveRequests.push(request)
          return makeIntradayMomentumTestSnapshot(
            protocol,
            request,
            { NVDA: 0.02 },
            10,
            displayedBidSizes,
          ) as ArchiveVerifiedIntradayMarketSnapshot
        }),
      verifyArchiveSnapshot: (snapshot) => Effect.succeed(snapshot as ArchiveVerifiedIntradayMarketSnapshot),
    }
    const input = {
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy,
      intradayMarketData: archive,
    } as const
    const preparation = Result.getOrThrow(prepareObserveStartup(input))
    const policy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, strategy))
    const document = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle: activeCycle,
          executionModel: preparation.executionModel,
          policy,
          reconcile: Effect.succeed(reconciliationResultAt(observedAt, 0, 0, [heldPosition])),
          strategy,
          intradayMarketData: archive,
          decisionFinalizationHeadroomMs: 60_000,
        })
      }).pipe(
        (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(archiveRequests).toHaveLength(2)
    expect(archiveRequests[0]).toMatchObject({
      symbols: ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH', 'SPY'],
    })
    expect(archiveRequests[1]).toMatchObject({
      symbols: ['AAPL', 'AMD', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH'],
      purpose: IntradaySnapshotPurpose.EntryPricing,
    })
    expect(document).toMatchObject({
      schemaVersion: 'bayn.paper-cycle-decision.v1',
      mode: 'PAPER',
      dispatchable: true,
      bindings: {
        strategyName: 'intraday-momentum',
        accountId,
        cycleId: activeCycle.identity.cycleId,
        decisionMarketData: { symbols: ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH', 'SPY'] },
        executionMarketData: {
          symbols: ['AAPL', 'AMD', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH'],
          purpose: IntradaySnapshotPurpose.EntryPricing,
        },
      },
      targetPlan: {
        status: TargetPlanStatus.Planned,
      },
    })
    expect(document.targetPlan.intentTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'AMD', side: OrderSide.Sell, quantityMicros: '1000000' }),
        expect.objectContaining({ symbol: 'NVDA', side: OrderSide.Buy }),
      ]),
    )
    expect(document.targetPlan.intentTargets).toHaveLength(2)
    expect(document.deltaRisk).toHaveLength(2)
    expect(document.deltaRisk.every(({ evaluation }) => evaluation.decision.outcome === RiskOutcome.Approved)).toBe(
      true,
    )
    expect(document.orderedIntentIds).toHaveLength(2)

    const { contentHash: _contentHash, ...executionMaterial } = document
    const forgedEntryRiskPhase = makeExecutionDecisionDocument({
      ...executionMaterial,
      deltaRisk: executionMaterial.deltaRisk.map((risk) => ({
        ...risk,
        ...(risk.facts === undefined
          ? {}
          : {
              facts: {
                ...risk.facts,
                state: {
                  ...risk.facts.state,
                  closeOnly: true,
                  closeOnlyExpiresAt: executionMaterial.expiresAt,
                },
              },
            }),
      })),
    })
    expect(Result.isFailure(forgedEntryRiskPhase)).toBe(true)
    if (Result.isFailure(forgedEntryRiskPhase)) {
      expect(String(forgedEntryRiskPhase.failure.cause)).toContain(
        'must bind non-close-only entry state or the exact close-only lease',
      )
    }

    const satisfiedTarget = document.targetPlan.targets.find(({ symbol }) => symbol === 'NVDA')
    if (satisfiedTarget === undefined) return expect.unreachable('intraday decision must persist the NVDA target')
    const satisfiedQuantity = BigInt(satisfiedTarget.targetQuantityMicros)
    if (satisfiedQuantity <= 0n) return expect.unreachable('selected NVDA target must be positive')
    const satisfiedPosition: Position = {
      ...heldPosition,
      symbol: 'NVDA',
      quantityMicros: satisfiedTarget.targetQuantityMicros,
      marketValueMicros: ((satisfiedQuantity * BigInt(heldPosition.marketPriceMicros)) / 1_000_000n).toString(),
    }
    const partiallySatisfied = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle: activeCycle,
          executionModel: preparation.executionModel,
          policy,
          reconcile: Effect.succeed(reconciliationResultAt(observedAt, 0, 0, [heldPosition, satisfiedPosition])),
          strategy,
          intradayMarketData: archive,
          decisionFinalizationHeadroomMs: 60_000,
        })
      }).pipe(
        (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(archiveRequests.slice(2)).toEqual([
      expect.objectContaining({ symbols: ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH', 'SPY'] }),
      expect.objectContaining({
        symbols: ['AAPL', 'AMD', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH'],
        purpose: IntradaySnapshotPurpose.EntryPricing,
      }),
    ])
    expect(partiallySatisfied.targetPlan.targets.map(({ symbol }) => symbol)).toEqual([
      'AAPL',
      'AMD',
      'AMZN',
      'IWM',
      'NVDA',
      'QQQ',
      'SMH',
    ])
    expect(partiallySatisfied.targetPlan.intentTargets.map(({ symbol }) => symbol)).toEqual(['AMD'])
    expect(partiallySatisfied.bindings.executionMarketData).toMatchObject({
      symbols: ['AAPL', 'AMD', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH'],
    })

    displayedBidSizes = { AMD: 0.5 }
    const lowLiquidityDocument = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle: activeCycle,
          executionModel: preparation.executionModel,
          policy,
          reconcile: Effect.succeed(reconciliationResultAt(observedAt, 0, 0, [heldPosition])),
          strategy,
          intradayMarketData: archive,
          decisionFinalizationHeadroomMs: 60_000,
        })
      }).pipe(
        (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(lowLiquidityDocument.targetPlan).toMatchObject({
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.InsufficientSellLiquidity,
      intentTargets: [],
    })
    expect(lowLiquidityDocument.bindings.executionMarketData).toMatchObject({
      symbols: ['AAPL', 'AMD', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH'],
      purpose: IntradaySnapshotPurpose.EntryPricing,
    })
    displayedBidSizes = {}

    const externalPosition: Position = { ...heldPosition, symbol: 'TSLA' }
    const externalHoldingRequestsStart = archiveRequests.length
    const externalHoldingDocument = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* buildMutationShadowCycleDecision({
          authorityGenerationHash: generationHash,
          cycle: activeCycle,
          executionModel: preparation.executionModel,
          policy,
          reconcile: Effect.succeed(reconciliationResultAt(observedAt, 0, 0, [externalPosition])),
          strategy,
          intradayMarketData: archive,
          decisionFinalizationHeadroomMs: 60_000,
        })
      }).pipe(
        (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
        Effect.provide(TestClock.layer()),
      ),
    )
    const externalHoldingRequests = archiveRequests.slice(externalHoldingRequestsStart)
    expect(externalHoldingRequests).toHaveLength(2)
    expect(externalHoldingRequests.every((request) => !request.symbols?.includes('TSLA'))).toBe(true)
    expect(externalHoldingDocument.targetPlan).toMatchObject({
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.IdentityMismatch,
      intentTargets: [],
    })

    const decisionRequest = archiveRequests[0]
    if (decisionRequest === undefined) return expect.unreachable('intraday decision request must be captured')
    const noTradeSnapshot = makeIntradayMomentumTestSnapshot(protocol, decisionRequest, {}, 10)
    const noTradeDecision = Result.getOrThrow(
      evaluateIntradayMomentumDecision(definition, activeCycle, noTradeSnapshot),
    )
    const noTradeCompiled = Result.getOrThrow(
      compileIntradayMomentumDecision(noTradeDecision, noTradeSnapshot, noTradeSnapshot),
    )
    expect(noTradeDecision.selectedSymbols).toEqual([])
    expect(noTradeCompiled.decisionMarketData).toBeUndefined()
    expect('purpose' in noTradeCompiled.executionMarketData).toBe(false)

    const closeObservedAt = '2020-05-01T15:30:01.000Z'
    const closeCycle = Effect.runSync(
      decodeAutonomousCycle({
        ...activeCycle,
        bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
        stateVersion: activeCycle.stateVersion + 1,
        updatedAt: document.createdAt,
      }),
    )
    const closeDocument = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(closeObservedAt))
        return yield* buildClosingExecutionCycleDecision({
          input,
          preparation,
          policy,
          cycle: closeCycle,
          entryDocument: document,
          reconcile: Effect.succeed(
            reconciliationResultAt(closeObservedAt, 0, 0, [{ ...heldPosition, observedAt: closeObservedAt }]),
          ),
          closeExpiresAt: '2020-05-01T16:00:00.000Z',
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
    expect(closeDocument.bindings.executionMarketData).toMatchObject({
      schemaVersion: 'bayn.execution-market-data-binding.v2',
      purpose: IntradaySnapshotPurpose.Liquidation,
      rangeStartAt: '2020-05-01T15:29:00.000Z',
      rangeEndAt: '2020-05-01T15:30:00.000Z',
      observedAt: closeObservedAt,
    })
    const { contentHash: _closeContentHash, ...closeMaterial } = closeDocument
    const forgedClose = (material: typeof closeMaterial, expectedFailure: string) => {
      const result = decodeExecutionDecisionDocument({ ...material, contentHash: canonicalHashV1(material) })
      expect(Result.isFailure(result)).toBeTrue()
      if (Result.isFailure(result)) expect(String(result.failure.cause)).toContain(expectedFailure)
    }
    forgedClose(
      { ...closeMaterial, createdAt: utcInstantFromEpochMillis(Date.parse(closeDocument.createdAt) + 1_000) },
      'observation must equal the close decision instant',
    )
    forgedClose(
      { ...closeMaterial, createdAt: utcInstantFromEpochMillis(Date.parse(closeDocument.createdAt) + 60_000) },
      'must bind the exact completed one-minute window',
    )
    const { executionSession: _closeExecutionSession, ...withoutCloseExecutionSession } = closeMaterial
    forgedClose(
      withoutCloseExecutionSession as typeof closeMaterial,
      'must match the persisted execution session and calendar',
    )
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
        strategy: currentIntradayRuntime,
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
            cycleBindingId: 'c'.repeat(64),
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
            strategy: currentIntradayRuntime,
          })
          const loop = yield* startup({
            cycleBindingId: 'c'.repeat(64),
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
      operation: 'reconcile',
      failure: 'market-data',
      message: 'same-pass broker reconciliation timed out after 50ms',
    })
    expect(fencedTransactions).toBe(1)
    expect(authorityRestrictions).toBe(0)
  })

  test('terminalizes an unbound execution cycle and refuses new discovery after the entry-authority cutoff', async () => {
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
      strategy: currentIntradayRuntime,
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
            cycleBindingId: cycle.identity.qualificationRunId,
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
    expect(observations[1]).toMatchObject({ result: 'SUCCESS', outcome: 'WINDOW_CLOSED' })
    expect(blocked).toBe(1)
    expect(terminal).toBe(true)
  })

  test('keeps the observe startup interface read-only by construction', () => {
    const startup = makeObserveAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: currentIntradayRuntime,
    })

    expect(typeof startup).toBe('function')
  })

  test('binds mutation startup to the exact guarded execution program authority and strategy identity', async () => {
    for (const executionProgram of [
      sandboxExecutionProgram('9'.repeat(64)),
      sandboxExecutionProgram(generationHash, {
        ...currentIntradayRuntime.provenance.strategy,
        behaviorHash: '8'.repeat(64),
      }),
    ]) {
      const startup = makeMutationAutonomousCycleStartup({
        accountId,
        authorityGenerationHash: generationHash,
        pollIntervalMs: 30_000,
        reconciliationIntervalMs: 30_000,
        reconciliationPassTimeoutMs: 30_000,
        strategy: currentIntradayRuntime,
        executionProgram,
      })

      const exit = await Effect.runPromise(
        Effect.exit(
          startup({
            cycleBindingId: 'c'.repeat(64),
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
