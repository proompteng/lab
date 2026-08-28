import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Result, Schema } from 'effect'

import {
  AutonomousCycleSchema,
  CycleState,
  cycleAuthoritySessionDate,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type AutonomousCycle,
} from './cycle'
import { defaultExecutionModel } from './execution-model'
import { bindExecutionSession, type BindExecutionSessionInput } from './execution-session'
import { canonicalHashV1, sha256 } from './hash'
import { utcInstantFromEpochMillis } from './time'
import {
  AccountStatus,
  Authority,
  KillState,
  OrderSide,
  OrderType,
  ReconciliationStatus,
  RiskOutcome,
  TimeInForce,
  type AccountSnapshot,
  type Position,
  type Reconciliation,
} from './execution/contracts'
import { reconciledStateHash } from './reconciliation'
import { BrokerMode, Gate, PolicySchema, Reason, StateSchema, type Policy, type State } from './risk'
import { strictParseOptions } from './schemas'
import {
  decodeObserveShadowDecisionDocument,
  ExecutionMarketDataBindingSchema,
  makeExecutionDecisionDocument,
  makeObserveShadowDecisionDocument,
  ShadowDecisionContractFailure,
  type ExecutionMarketDataBinding,
  type ObserveShadowDecisionDocument,
} from './shadow-decision-contract'
import {
  buildExecutionDecision,
  buildObserveShadowDecision,
  type ObserveShadowDecisionInput,
  type ShadowDeltaRiskInput,
} from './shadow-decision'
import { FlatExecutionTargetSchema, runtimeDecisionMatchesStrategy } from './strategy/runtime-decision'
import type { IntradayMomentumTargetPortfolio } from './strategy/intraday-momentum/model'
import { intradayMomentumExecutionModel } from './strategy/intraday-momentum/protocol'
import type { OpeningDriveTargetPortfolio } from './strategy/opening-drive/model'
import { openingDriveExecutionModel } from './strategy/opening-drive/protocol'
import {
  intradaySnapshotReferencePricesSchemaVersion,
  quoteBoundTargetPlannerInputSchemaVersion,
  TargetPlanReason,
  TargetPlanStatus,
  planTargets,
  type QuoteBoundTargetPlannerInput,
  type TargetPlannerInput,
} from './target-planner'
import type { DecisionPlan } from './types'

const hash = (character: string): string => character.repeat(64)
const accountId = 'paper-account-1'
const signalDate = '2026-07-21' as const
const executionDate = '2026-07-22' as const
const brokerObservedAt = '2026-07-22T13:00:00.000Z'
const plannedAt = '2026-07-22T13:05:00.000Z'
const snapshotFinalizedAt = '2026-07-21T20:05:00.000Z'
const snapshotId = hash('2')
const snapshotContentHash = hash('3')
const accountingHash = hash('a')

type ShadowContractOperationReason<Input> = Input extends {
  readonly operation: infer Operation
  readonly reason: infer FailureReason
}
  ? { readonly operation: Operation; readonly reason: FailureReason }
  : never
type ShadowContractFailurePair = ShadowContractOperationReason<
  ConstructorParameters<typeof ShadowDecisionContractFailure>[0]
>
const shadowContractFailurePairs = [
  { operation: 'make', reason: 'canonicalization' },
  { operation: 'make', reason: 'contract' },
  { operation: 'decode', reason: 'contract' },
] as const satisfies readonly ShadowContractFailurePair[]
type MissingShadowContractFailurePair = Exclude<ShadowContractFailurePair, (typeof shadowContractFailurePairs)[number]>
type InvalidShadowContractFailurePair = Exclude<(typeof shadowContractFailurePairs)[number], ShadowContractFailurePair>
const shadowContractFailurePairCoverage: [MissingShadowContractFailurePair, InvalidShadowContractFailurePair] extends [
  never,
  never,
]
  ? true
  : never = true

const resultValue = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}
const makeCycleDraftSuccess = (...args: Parameters<typeof makeCycleDraft>) => resultValue(makeCycleDraft(...args))
const makeCycleExecutionPolicySuccess = (...args: Parameters<typeof makeCycleExecutionPolicy>) =>
  resultValue(makeCycleExecutionPolicy(...args))
const makeCycleIdentitySuccess = (...args: Parameters<typeof makeCycleIdentity>) =>
  resultValue(makeCycleIdentity(...args))
const makeCycleWindowSuccess = (...args: Parameters<typeof makeCycleWindow>) => resultValue(makeCycleWindow(...args))
const makeExecutionCalendarObservationSuccess = (...args: Parameters<typeof makeExecutionCalendarObservation>) =>
  resultValue(makeExecutionCalendarObservation(...args))
const bindExecutionSessionSuccess = (input: BindExecutionSessionInput) => resultValue(bindExecutionSession(input))
const planTargetsSuccess = (input: TargetPlannerInput) => resultValue(planTargets(input))

const decodeCycle = Schema.decodeUnknownSync(AutonomousCycleSchema, strictParseOptions)
const decodePolicy = Schema.decodeUnknownSync(PolicySchema, strictParseOptions)
const decodeState = Schema.decodeUnknownSync(StateSchema, strictParseOptions)

const makeCycle = (): AutonomousCycle => {
  const executionPolicy = makeCycleExecutionPolicySuccess({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: canonicalHashV1(defaultExecutionModel),
    submissionWindowMs: 3_600_000,
    submissionCutoffBeforeOpenMs: 900_000,
  })
  const executionCalendar = makeExecutionCalendarObservationSuccess({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: executionDate,
    openAt: '2026-07-22T13:30:00.000Z',
    closeAt: '2026-07-22T20:00:00.000Z',
  })
  const identity = makeCycleIdentitySuccess({
    schemaVersion: 'bayn.autonomous-cycle-identity.v1',
    strategyName: 'risk-balanced-trend',
    qualificationRunId: hash('1'),
    strategyProtocolHash: hash('4'),
    accountId,
    signalSessionDate: signalDate,
    signalCalendarVersion: 'XNYS-v1',
    executionSessionDate: executionDate,
    executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
    executionCalendarSource: executionCalendar.executionCalendarSource,
    executionCalendarHash: executionCalendar.executionCalendarHash,
    executionPolicy,
  })
  const window = makeCycleWindowSuccess(
    {
      calendar_version: 'XNYS-v1',
      session_date: signalDate,
      close_time: '16:00',
      timezone: 'America/New_York',
    },
    executionCalendar,
    executionPolicy,
  )
  const draft = makeCycleDraftSuccess(identity, window)
  return decodeCycle({
    ...draft,
    state: CycleState.Active,
    bindings: { snapshotId },
    stateVersion: 3,
    createdAt: '2026-07-22T11:45:00.000Z',
    updatedAt: '2026-07-22T12:45:00.000Z',
  })
}

const makeOpeningDriveCycle = (): AutonomousCycle => {
  const executionPolicy = resultValue(makeCycleExecutionPolicyFromModel(openingDriveExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v2') {
    throw new Error('opening-drive fixture requires an intraday execution policy')
  }
  const executionCalendar = makeExecutionCalendarObservationSuccess({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: executionDate,
    openAt: '2026-07-22T13:30:00.000Z',
    closeAt: '2026-07-22T20:00:00.000Z',
  })
  const identity = makeCycleIdentitySuccess({
    schemaVersion: 'bayn.autonomous-cycle-identity.v3',
    strategyName: 'opening-drive-momentum',
    qualificationRunId: hash('1'),
    strategyProtocolHash: hash('4'),
    accountId,
    executionSessionDate: executionDate,
    executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
    executionCalendarSource: executionCalendar.executionCalendarSource,
    executionCalendarHash: executionCalendar.executionCalendarHash,
    executionPolicy,
  })
  const window = resultValue(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  const draft = makeCycleDraftSuccess(identity, window)
  return decodeCycle({
    ...draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 3,
    createdAt: '2026-07-22T11:45:00.000Z',
    updatedAt: window.submissionOpenAt,
  })
}

const makeIntradayMomentumCycle = (): AutonomousCycle => {
  const executionPolicy = resultValue(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') {
    throw new Error('intraday-momentum fixture requires a rolling intraday execution policy')
  }
  const executionCalendar = makeExecutionCalendarObservationSuccess({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: executionDate,
    openAt: '2026-07-22T13:30:00.000Z',
    closeAt: '2026-07-22T20:00:00.000Z',
  })
  const identity = makeCycleIdentitySuccess({
    schemaVersion: 'bayn.autonomous-cycle-identity.v3',
    strategyName: 'intraday-momentum',
    qualificationRunId: hash('1'),
    strategyProtocolHash: hash('4'),
    accountId,
    executionSessionDate: executionDate,
    executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
    executionCalendarSource: executionCalendar.executionCalendarSource,
    executionCalendarHash: executionCalendar.executionCalendarHash,
    executionPolicy,
  })
  const window = resultValue(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  const draft = makeCycleDraftSuccess(identity, window)
  return decodeCycle({
    ...draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 3,
    createdAt: '2026-07-22T11:45:00.000Z',
    updatedAt: window.submissionOpenAt,
  })
}

const makeHistoricalOpeningDriveCycle = (): AutonomousCycle => {
  const executionPolicy = resultValue(makeCycleExecutionPolicyFromModel(openingDriveExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v2') {
    throw new Error('opening-drive fixture requires an intraday execution policy')
  }
  const executionCalendar = makeExecutionCalendarObservationSuccess({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: executionDate,
    openAt: '2026-07-22T13:30:00.000Z',
    closeAt: '2026-07-22T20:00:00.000Z',
  })
  const identity = makeCycleIdentitySuccess({
    schemaVersion: 'bayn.autonomous-cycle-identity.v2',
    strategyName: 'opening-drive-momentum',
    qualificationRunId: hash('1'),
    strategyProtocolHash: hash('4'),
    accountId,
    signalSessionDate: signalDate,
    signalCalendarVersion: 'XNYS-v1',
    executionSessionDate: executionDate,
    executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
    executionCalendarSource: executionCalendar.executionCalendarSource,
    executionCalendarHash: executionCalendar.executionCalendarHash,
    executionPolicy,
  })
  const window = makeCycleWindowSuccess(
    {
      calendar_version: 'XNYS-v1',
      session_date: signalDate,
      close_time: '16:00',
      timezone: 'America/New_York',
    },
    executionCalendar,
    executionPolicy,
  )
  const draft = makeCycleDraftSuccess(identity, window)
  return decodeCycle({
    ...draft,
    state: CycleState.Active,
    bindings: { snapshotId },
    stateVersion: 3,
    createdAt: '2026-07-22T11:45:00.000Z',
    updatedAt: window.submissionOpenAt,
  })
}

const position = (symbol: string): Position => ({
  schemaVersion: 'bayn.paper-position.v1',
  accountId,
  symbol,
  quantityMicros: '1000000',
  averageEntryPriceMicros: '100000000',
  marketPriceMicros: '100000000',
  marketValueMicros: '100000000',
  unrealizedPnlMicros: '0',
  observedAt: brokerObservedAt,
})

const defaultPositions = (): readonly Position[] => [position('AMD'), position('NVDA')]

const makeBrokerState = (positions: readonly Position[] = defaultPositions()) => {
  const account: AccountSnapshot = {
    schemaVersion: 'bayn.paper-account-snapshot.v1',
    accountId,
    status: AccountStatus.Active,
    currency: 'USD',
    cashMicros: '800000000',
    equityMicros: '1000000000',
    buyingPowerMicros: '1000000000',
    observedAt: brokerObservedAt,
  }
  const orders = [] as const
  const stateHash = Result.getOrThrow(
    reconciledStateHash({
      account,
      positions,
      positionsObservedAt: brokerObservedAt,
      orders,
      ordersObservedAt: brokerObservedAt,
      accountingHash,
    }),
  )
  const reconciliationMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt: brokerObservedAt,
  }
  const reconciliationId = canonicalHashV1({
    schemaVersion: 'bayn.paper-reconciliation-id.v1',
    material: reconciliationMaterial,
  })
  const reconciliation: Reconciliation = {
    ...reconciliationMaterial,
    reconciliationId,
    contentHash: canonicalHashV1({ ...reconciliationMaterial, reconciliationId }),
  }
  return { account, positions, orders, reconciliation, stateHash }
}

const makeDecision = (targetWeights: Readonly<Record<string, number>>): DecisionPlan => ({
  schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
  signalDate,
  covarianceWindow: {
    returnCount: 63,
    firstSession: '2026-04-22',
    lastSession: signalDate,
    sessionsHash: hash('5'),
  },
  estimatedAnnualizedPortfolioVolatility: 0.08,
  exposureScale: 1,
  targetWeights,
  signals: ['AMD', 'NVDA'].map((symbol) => ({
    symbol,
    horizons: [{ horizonSessions: 21, return: 0.1, normalizedTrend: 1 }],
    dailyVolatility: 0.01,
    annualizedVolatility: 0.15,
    compositeScore: 1,
    positiveScore: 1,
    eligible: true,
    uncappedWeight: targetWeights[symbol],
    cappedWeight: targetWeights[symbol],
    targetWeight: targetWeights[symbol],
  })),
})

const makePolicy = (): Policy =>
  decodePolicy({
    schemaVersion: 'bayn.paper-risk-policy.v2',
    accountId,
    brokerMode: BrokerMode.Execution,
    allowedSymbols: ['AMD', 'NVDA'],
    allowedOrderTypes: [OrderType.Market],
    allowedTimeInForce: [TimeInForce.Day],
    maxOrderNotionalMicros: '600000000',
    maxSymbolExposureMicros: '600000000',
    maxGrossExposureMicros: '1000000000',
    maxNetExposureMicros: '1000000000',
    maxDailyTradedNotionalMicros: '1000000000',
    maxDailyLossMicros: '100000000',
    maxDrawdownMicros: '100000000',
    maxIntentAgeMs: 1_800_000,
    maxBrokerStateAgeMs: 1_800_000,
    maxMarketDataAgeMs: 1_800_000,
    maxAdverseSlippageBps: 100,
    maxOpenOrders: 2,
    decisionTtlMs: 1_200_000,
  })

const referencePrices = () => {
  const material = {
    schemaVersion: 'bayn.signal-session-reference-prices.v1' as const,
    signalDate,
    observedAt: brokerObservedAt,
    priceMicros: { AMD: '100000000', NVDA: '100000000' },
  }
  return { ...material, contentHash: canonicalHashV1(material) }
}

const makePlannerInput = (
  cycle: AutonomousCycle,
  decision: DecisionPlan,
  policy: Policy,
  maximumInputAgeMs = 1_800_000,
  positions: readonly Position[] = defaultPositions(),
): TargetPlannerInput => {
  const brokerState = makeBrokerState(positions)
  return {
    schemaVersion: 'bayn.paper-target-planner-input.v1',
    strategyName: 'risk-balanced-trend',
    cycleId: cycle.identity.cycleId,
    decisionHash: canonicalHashV1(decision),
    policyHash: canonicalHashV1(policy),
    accountId,
    signalDate,
    targetWeights: decision.targetWeights,
    referencePrices: referencePrices(),
    brokerState: {
      account: brokerState.account,
      positions: brokerState.positions,
      positionsObservedAt: brokerObservedAt,
      orders: brokerState.orders,
      ordersObservedAt: brokerObservedAt,
      accountingHash,
      reconciliation: brokerState.reconciliation,
      unknownOrderCount: 0,
    },
    precision: defaultExecutionModel.precision,
    maximumInputAgeMs,
    submissionCutoffAt: cycle.window.submissionCutoffAt,
    observedAt: plannedAt,
  }
}

const makeRiskState = (
  cycle: AutonomousCycle,
  symbol: string,
  positions: readonly Position[] = defaultPositions(),
): State => {
  const brokerState = makeBrokerState(positions)
  const calendarMaterial = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: { start: signalDate, end: executionDate },
    timeZone: 'UTC' as const,
    sessions: [
      {
        date: executionDate,
        openAt: cycle.window.executionOpenAt,
        closeAt: cycle.window.executionCloseAt,
      },
    ],
  }
  const executionSession = bindExecutionSessionSuccess({
    signal: {
      sessionDate: signalDate,
      finalizedAt: snapshotFinalizedAt,
      contentHash: snapshotContentHash,
    },
    planningBrokerState: {
      observedAt: brokerObservedAt,
      contentHash: brokerState.stateHash,
    },
    calendar: {
      ...calendarMaterial,
      normalizedResponseHash: canonicalHashV1(calendarMaterial),
    },
    executionModel: defaultExecutionModel,
  })
  return decodeState({
    schemaVersion: 'bayn.paper-risk-state.v2',
    brokerMode: BrokerMode.Execution,
    account: brokerState.account,
    positions: brokerState.positions,
    positionsObservedAt: brokerObservedAt,
    orders: brokerState.orders,
    ordersObservedAt: brokerObservedAt,
    reconciliation: brokerState.reconciliation,
    authority: {
      schemaVersion: 'bayn.paper-authority.v1',
      generationHash: hash('6'),
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Clear,
      version: 1,
      updatedAt: brokerObservedAt,
    },
    authorityObservedAt: brokerObservedAt,
    unknownMutationCount: 0,
    dailyTradedNotionalMicros: '0',
    dayStartEquityMicros: '1000000000',
    peakEquityMicros: '1000000000',
    accountingHash,
    marketDataSymbol: symbol,
    marketDataHash: snapshotContentHash,
    referencePriceMicros: '100000000',
    expectedExecutionPriceMicros: '100000000',
    marketDataObservedAt: brokerObservedAt,
    executionSession,
    reservedBuyingPowerMicros: '0',
    evaluatedAt: plannedAt,
  })
}

const makeInput = (
  targetWeights: Readonly<Record<string, number>> = { AMD: 0.4, NVDA: 0.6 },
  positions: readonly Position[] = defaultPositions(),
  policy: Policy = makePolicy(),
): ObserveShadowDecisionInput => {
  const cycle = makeCycle()
  const compiledDecision = makeDecision(targetWeights)
  const plannerInput = makePlannerInput(cycle, compiledDecision, policy, 1_800_000, positions)
  const targetPlan = planTargetsSuccess(plannerInput)
  const riskInputs: ShadowDeltaRiskInput[] =
    targetPlan.status === TargetPlanStatus.Planned
      ? targetPlan.intentTargets.map((target) => {
          const referencePrice = plannerInput.referencePrices.priceMicros[target.symbol]
          if (referencePrice === undefined) throw new Error(`missing fixture reference price for ${target.symbol}`)
          return {
            symbol: target.symbol,
            notionalLimitMicros: ((BigInt(target.quantityMicros) * BigInt(referencePrice)) / 1_000_000n).toString(),
            state: makeRiskState(cycle, target.symbol, positions),
          }
        })
      : []
  return {
    cycle,
    snapshot: {
      snapshotId,
      contentHash: snapshotContentHash,
      finalizedAt: snapshotFinalizedAt,
    },
    compiledDecision,
    plannerInput,
    targetPlan,
    policy,
    riskInputs,
  }
}

const openingDriveDecision = (calendarHash: string, boundSnapshotId: string): OpeningDriveTargetPortfolio => ({
  schemaVersion: 'bayn.opening-drive.target.v1',
  strategy: 'opening-drive-momentum',
  sessionDate: executionDate,
  snapshotId: boundSnapshotId,
  observedAt: '2026-07-22T13:35:01.000Z',
  calendarHash,
  selectedSymbols: [],
  targetWeights: { AMD: 0, NVDA: 0 },
  signals: ['AMD', 'NVDA'].map((symbol) => ({
    symbol,
    openingPriceMicros: '100000000',
    rangeHighPriceMicros: '101000000',
    rangeLowPriceMicros: '99000000',
    bidPriceMicros: '100000000',
    askPriceMicros: '100100000',
    quoteObservedAt: '2026-07-22T13:35:00.500Z',
    breakoutTradePriceMicros: '100000000',
    breakoutTradeObservedAt: '2026-07-22T13:35:00.500Z',
    openingReturnBps: 0,
    breakoutBps: -100,
    rangeLocationPpm: 500_000,
    spreadBps: 10,
    openingDollarVolumeMicros: '100000000',
    eligible: false,
    rejectionReasons: ['opening-return', 'breakout'] as const,
    rank: null,
  })),
})

const intradayMomentumDecision = (calendarHash: string, boundSnapshotId: string): IntradayMomentumTargetPortfolio => ({
  schemaVersion: 'bayn.intraday-momentum.target.v1',
  strategy: 'intraday-momentum',
  sessionDate: executionDate,
  snapshotId: boundSnapshotId,
  observedAt: '2026-07-22T16:00:02.000Z',
  calendarHash,
  selectedSymbols: [],
  targetWeights: { AMD: 0, NVDA: 0 },
  signals: ['AMD', 'NVDA'].map((symbol) => ({
    symbol,
    referencePriceMicros: '100000000',
    rangeHighPriceMicros: '101000000',
    rangeLowPriceMicros: '99000000',
    bidPriceMicros: '100000000',
    askPriceMicros: '100100000',
    quoteObservedAt: '2026-07-22T16:00:01.000Z',
    confirmationTradePriceMicros: '100000000',
    confirmationTradeObservedAt: '2026-07-22T16:00:01.000Z',
    lookbackReturnBps: 0,
    breakoutBps: -100,
    rangeLocationPpm: 500_000,
    spreadBps: 10,
    eligible: false,
    rejectionReasons: ['lookback-return'] as const,
    rank: null,
  })),
})

type ArchiveMarketDataBindingV1 = Extract<
  ExecutionMarketDataBinding,
  { readonly schemaVersion: 'bayn.execution-market-data-binding.v1' }
>
type ArchiveMarketDataBindingV2 = Extract<
  ExecutionMarketDataBinding,
  { readonly schemaVersion: 'bayn.execution-market-data-binding.v2' }
>

const openingDriveMarketDataBinding = (
  cycle: AutonomousCycle,
  barsContentHash: string = hash('8'),
): ArchiveMarketDataBindingV1 => {
  const calendarMaterial = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: { start: executionDate, end: executionDate },
    timeZone: 'UTC' as const,
    sessions: [
      {
        date: executionDate,
        openAt: cycle.window.executionOpenAt,
        closeAt: cycle.window.executionCloseAt,
      },
    ],
  }
  const sourceTopics = {
    bars: 'torghut.bars.1m.v1',
    quotes: 'torghut.quotes.v1',
    trades: 'torghut.trades.v1',
  }
  const archiveWatermarks = Object.values(sourceTopics).map((sourceTopic, index) => ({
    sourceTopic,
    sourcePartition: 0,
    inclusiveLastOffset: String(10 + index),
  }))
  const lineage = Object.values(sourceTopics).map((sourceTopic, index) => ({
    sourceTopic,
    sourcePartition: 0,
    firstOffset: String(1 + index),
    lastOffset: String(10 + index),
    recordCount: index === 0 ? 10 : 2,
  }))
  const snapshotMaterial = {
    schemaVersion: 'bayn.intraday-market-snapshot.v1' as const,
    sessionDate: executionDate,
    calendar: { ...calendarMaterial, normalizedResponseHash: canonicalHashV1(calendarMaterial) },
    rangeStartAt: cycle.window.executionOpenAt,
    rangeEndAt: '2026-07-22T13:35:00.000Z',
    observedAt: cycle.window.submissionOpenAt,
    universeId: 'opening-drive-fixture-v1',
    universeSymbolHash: hash('7'),
    symbols: ['AMD', 'NVDA'],
    feed: 'sip' as const,
    delayClass: 'real_time_consolidated' as const,
    sourceTopics,
    archiveWatermarks,
    maximumQuoteAgeMs: 5_000,
    minimumWatermarkLagMs: 1_000,
    barCount: 10,
    quoteCount: 2,
    tradeCount: 2,
    barsContentHash,
    quotesContentHash: hash('9'),
    tradesContentHash: hash('a'),
    lineage,
  }
  const contentHash = canonicalHashV1(snapshotMaterial)
  const { schemaVersion: snapshotSchemaVersion, ...material } = snapshotMaterial
  return {
    schemaVersion: 'bayn.execution-market-data-binding.v1',
    snapshotSchemaVersion,
    ...material,
    contentHash,
    snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash }),
  }
}

const currentEntryMarketDataBinding = (
  cycle: AutonomousCycle,
  barsContentHash?: string,
): ArchiveMarketDataBindingV2 => {
  const binding = openingDriveMarketDataBinding(cycle, barsContentHash)
  const {
    contentHash: _contentHash,
    snapshotId: _snapshotId,
    schemaVersion: _bindingSchemaVersion,
    snapshotSchemaVersion,
    ...bindingMaterial
  } = binding
  const universe = [...binding.symbols].sort()
  const currentMaterial = {
    ...bindingMaterial,
    universe,
    universeSymbolHash: sha256(universe.join(',')),
  }
  const snapshotMaterial = { schemaVersion: snapshotSchemaVersion, ...currentMaterial }
  const contentHash = canonicalHashV1(snapshotMaterial)
  const decoded = Result.getOrThrow(
    Schema.decodeUnknownResult(
      ExecutionMarketDataBindingSchema,
      strictParseOptions,
    )({
      schemaVersion: 'bayn.execution-market-data-binding.v2',
      snapshotSchemaVersion,
      ...currentMaterial,
      contentHash,
      snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash }),
    }),
  )
  if (decoded.schemaVersion !== 'bayn.execution-market-data-binding.v2') {
    throw new Error('current entry fixture must decode as archive binding v2')
  }
  return decoded
}

const liquidationMarketDataBinding = (
  cycle: AutonomousCycle,
  barsContentHash: string = hash('8'),
  symbols?: readonly string[],
): ArchiveMarketDataBindingV2 => {
  const binding = openingDriveMarketDataBinding(cycle, barsContentHash)
  const {
    contentHash: _contentHash,
    snapshotId: _snapshotId,
    schemaVersion: _bindingSchemaVersion,
    snapshotSchemaVersion,
    purpose: _purpose,
    universe: _universe,
    ...bindingMaterial
  } = binding
  const universe = [...binding.symbols].sort()
  const liquidationSymbols = [...(symbols ?? binding.symbols)].sort()
  const liquidationMaterial = {
    ...bindingMaterial,
    symbols: liquidationSymbols,
    universe,
    universeSymbolHash: sha256(universe.join(',')),
    purpose: 'LIQUIDATION' as const,
    barCount: 0,
    tradeCount: 0,
  }
  const snapshotMaterial = { schemaVersion: snapshotSchemaVersion, ...liquidationMaterial }
  const contentHash = canonicalHashV1(snapshotMaterial)
  const decoded = Result.getOrThrow(
    Schema.decodeUnknownResult(
      ExecutionMarketDataBindingSchema,
      strictParseOptions,
    )({
      schemaVersion: 'bayn.execution-market-data-binding.v2',
      snapshotSchemaVersion,
      ...liquidationMaterial,
      contentHash,
      snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash }),
    }),
  )
  if (decoded.schemaVersion !== 'bayn.execution-market-data-binding.v2') {
    throw new Error('liquidation fixture must decode as archive binding v2')
  }
  return decoded
}

type OpeningDriveShadowDecisionInput = Omit<ObserveShadowDecisionInput, 'plannerInput'> & {
  readonly plannerInput: QuoteBoundTargetPlannerInput
}

const makeOpeningDriveInput = (
  calendarHash?: string,
  cycle: AutonomousCycle = makeOpeningDriveCycle(),
): OpeningDriveShadowDecisionInput => {
  const executionMarketData = openingDriveMarketDataBinding(cycle)
  const compiledDecision = openingDriveDecision(
    calendarHash ?? cycle.window.executionCalendarHash,
    executionMarketData.snapshotId,
  )
  const policy = makePolicy()
  const plannerSessionDate = cycleAuthoritySessionDate(cycle.identity)
  const intradayPriceMaterial = {
    schemaVersion: intradaySnapshotReferencePricesSchemaVersion,
    signalDate: plannerSessionDate,
    observedAt: executionMarketData.observedAt,
    snapshotId: executionMarketData.snapshotId,
    snapshotContentHash: executionMarketData.contentHash,
    priceReference: 'verified-adverse-quote-boundary' as const,
    priceMicros: { AMD: '100100000', NVDA: '100100000' },
    bidPriceMicros: { AMD: '100000000', NVDA: '100000000' },
    askPriceMicros: { AMD: '100100000', NVDA: '100100000' },
  }
  const plannerInput: QuoteBoundTargetPlannerInput = {
    ...makePlannerInput(cycle, makeDecision({ AMD: 0, NVDA: 0 }), policy, 3_600_000, []),
    schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
    strategyName: 'opening-drive-momentum',
    signalDate: plannerSessionDate,
    decisionHash: canonicalHashV1(compiledDecision),
    targetWeights: compiledDecision.targetWeights,
    referencePrices: { ...intradayPriceMaterial, contentHash: canonicalHashV1(intradayPriceMaterial) },
    precision: {
      quantityIncrementMicros: '1000000',
      priceIncrementMicros: openingDriveExecutionModel.precision.priceIncrementMicros,
      minimumBuyNotionalMicros: openingDriveExecutionModel.precision.minimumBuyNotionalMicros,
    },
    allocationCapitalMicros: '1000000000',
    executionTerms: {
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      priceReference: 'verified-adverse-quote-boundary',
      snapshotId: executionMarketData.snapshotId,
      snapshotContentHash: executionMarketData.contentHash,
      maximumBuyQuantityMicros: { AMD: '1000000', NVDA: '1000000' },
    },
    submissionCutoffAt: cycle.window.submissionCutoffAt,
    observedAt: cycle.window.submissionOpenAt,
  }
  return {
    cycle,
    snapshot:
      cycle.schemaVersion === 'bayn.autonomous-cycle.v2'
        ? { snapshotId, contentHash: snapshotContentHash, finalizedAt: snapshotFinalizedAt }
        : {
            snapshotId: executionMarketData.snapshotId,
            contentHash: executionMarketData.contentHash,
            finalizedAt: executionMarketData.observedAt,
          },
    compiledDecision,
    plannerInput,
    targetPlan: planTargetsSuccess(plannerInput),
    policy,
    riskInputs: [],
    executionMarketData,
  }
}

const makeIntradayMomentumInput = (calendarHash?: string): OpeningDriveShadowDecisionInput => {
  const cycle = makeIntradayMomentumCycle()
  const base = makeOpeningDriveInput(undefined, cycle)
  const executionMarketData = currentEntryMarketDataBinding(cycle)
  const compiledDecision = intradayMomentumDecision(
    calendarHash ?? cycle.window.executionCalendarHash,
    executionMarketData.snapshotId,
  )
  const { contentHash: _referencePriceHash, ...referencePriceMaterial } = base.plannerInput.referencePrices
  const currentReferencePriceMaterial = {
    ...referencePriceMaterial,
    snapshotId: executionMarketData.snapshotId,
    snapshotContentHash: executionMarketData.contentHash,
  }
  const plannerInput: QuoteBoundTargetPlannerInput = {
    ...base.plannerInput,
    strategyName: 'intraday-momentum',
    decisionHash: canonicalHashV1(compiledDecision),
    targetWeights: compiledDecision.targetWeights,
    referencePrices: {
      ...currentReferencePriceMaterial,
      contentHash: canonicalHashV1(currentReferencePriceMaterial),
    },
    executionTerms: {
      ...base.plannerInput.executionTerms,
      snapshotId: executionMarketData.snapshotId,
      snapshotContentHash: executionMarketData.contentHash,
    },
    precision: {
      quantityIncrementMicros: '1000000',
      priceIncrementMicros: intradayMomentumExecutionModel.precision.priceIncrementMicros,
      minimumBuyNotionalMicros: intradayMomentumExecutionModel.precision.minimumBuyNotionalMicros,
    },
    observedAt: compiledDecision.observedAt,
  }
  return {
    ...base,
    snapshot: {
      snapshotId: executionMarketData.snapshotId,
      contentHash: executionMarketData.contentHash,
      finalizedAt: executionMarketData.observedAt,
    },
    compiledDecision,
    executionMarketData,
    plannerInput,
    targetPlan: planTargetsSuccess(plannerInput),
  }
}

const build = (input: ObserveShadowDecisionInput): Promise<ObserveShadowDecisionDocument> =>
  Effect.runPromise(buildObserveShadowDecision(input))

describe('OBSERVE shadow decision', () => {
  test('requires v2 execution market-data evidence for intraday-momentum entries', async () => {
    const input = makeIntradayMomentumInput()
    const executionMarketData = input.executionMarketData
    if (executionMarketData?.schemaVersion !== 'bayn.execution-market-data-binding.v2') {
      throw new Error('intraday fixture must include archive execution market data v2')
    }

    const failure = await Effect.runPromise(
      Effect.flip(
        buildObserveShadowDecision({
          ...input,
          executionMarketData: {
            ...executionMarketData,
            schemaVersion: 'bayn.execution-market-data-binding.v1',
          },
        }),
      ),
    )
    expect(failure).toMatchObject({
      failure: 'binding',
      message: 'intraday-momentum entry requires execution market-data binding v2',
    })
  })

  test('requires complete decision-universe evidence for intraday-momentum entries', async () => {
    const input = makeIntradayMomentumInput()
    const binding = input.executionMarketData
    if (binding?.schemaVersion !== 'bayn.execution-market-data-binding.v2') {
      throw new Error('intraday fixture must include archive execution market data v2')
    }
    const {
      contentHash: _contentHash,
      snapshotId: _snapshotId,
      schemaVersion,
      snapshotSchemaVersion,
      ...bindingMaterial
    } = binding
    const subsetMaterial = { ...bindingMaterial, symbols: binding.symbols.slice(0, 1) }
    const snapshotMaterial = { schemaVersion: snapshotSchemaVersion, ...subsetMaterial }
    const contentHash = canonicalHashV1(snapshotMaterial)
    const subsetBinding = Result.getOrThrow(
      Schema.decodeUnknownResult(
        ExecutionMarketDataBindingSchema,
        strictParseOptions,
      )({
        schemaVersion,
        snapshotSchemaVersion,
        ...subsetMaterial,
        contentHash,
        snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash }),
      }),
    )

    const failure = await Effect.runPromise(
      Effect.flip(buildObserveShadowDecision({ ...input, executionMarketData: subsetBinding })),
    )

    expect(failure).toMatchObject({
      failure: 'binding',
      message: 'intraday entry requires complete market-data evidence for the decision universe',
    })
  })

  test('requires the canonical source universe on new execution market-data bindings', () => {
    const legacyBinding = openingDriveMarketDataBinding(makeOpeningDriveCycle())
    const currentBinding = { ...legacyBinding, schemaVersion: 'bayn.execution-market-data-binding.v2' }

    expect(
      Result.isSuccess(Schema.decodeUnknownResult(ExecutionMarketDataBindingSchema, strictParseOptions)(legacyBinding)),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ExecutionMarketDataBindingSchema, strictParseOptions)(currentBinding),
      ),
    ).toBe(true)
  })

  test('rejects a liquidation binding that omits its canonical source universe', () => {
    const binding = openingDriveMarketDataBinding(makeOpeningDriveCycle())
    const {
      contentHash: _contentHash,
      snapshotId: _snapshotId,
      schemaVersion,
      snapshotSchemaVersion,
      ...bindingMaterial
    } = binding
    const liquidationMaterial = {
      ...bindingMaterial,
      purpose: 'LIQUIDATION' as const,
      barCount: 0,
      tradeCount: 0,
    }
    const snapshotMaterial = { schemaVersion: snapshotSchemaVersion, ...liquidationMaterial }
    const contentHash = canonicalHashV1(snapshotMaterial)
    const result = Schema.decodeUnknownResult(
      ExecutionMarketDataBindingSchema,
      strictParseOptions,
    )({
      schemaVersion,
      snapshotSchemaVersion,
      ...liquidationMaterial,
      contentHash,
      snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash }),
    })

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain('universe')
  })

  test('rejects liquidation evidence encoded with the legacy v1 binding', () => {
    const binding = openingDriveMarketDataBinding(makeOpeningDriveCycle())
    const {
      contentHash: _contentHash,
      snapshotId: _snapshotId,
      schemaVersion,
      snapshotSchemaVersion,
      ...bindingMaterial
    } = binding
    const universe = [...binding.symbols]
    const liquidationMaterial = {
      ...bindingMaterial,
      universe,
      universeSymbolHash: sha256(universe.join(',')),
      purpose: 'LIQUIDATION' as const,
      barCount: 0,
      tradeCount: 0,
    }
    const snapshotMaterial = { schemaVersion: snapshotSchemaVersion, ...liquidationMaterial }
    const contentHash = canonicalHashV1(snapshotMaterial)
    const result = Schema.decodeUnknownResult(
      ExecutionMarketDataBindingSchema,
      strictParseOptions,
    )({
      schemaVersion,
      snapshotSchemaVersion,
      ...liquidationMaterial,
      contentHash,
      snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash }),
    })

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain('binding v2')
  })

  test('rejects a liquidation binding whose source universe is not canonically ordered', () => {
    const binding = openingDriveMarketDataBinding(makeOpeningDriveCycle())
    const {
      contentHash: _contentHash,
      snapshotId: _snapshotId,
      schemaVersion,
      snapshotSchemaVersion,
      ...bindingMaterial
    } = binding
    const universe = ['NVDA', 'AMD']
    const liquidationMaterial = {
      ...bindingMaterial,
      universe,
      universeSymbolHash: sha256(universe.join(',')),
      symbols: ['AMD'],
      purpose: 'LIQUIDATION' as const,
      barCount: 0,
      tradeCount: 0,
    }
    const snapshotMaterial = { schemaVersion: snapshotSchemaVersion, ...liquidationMaterial }
    const contentHash = canonicalHashV1(snapshotMaterial)
    const result = Schema.decodeUnknownResult(
      ExecutionMarketDataBindingSchema,
      strictParseOptions,
    )({
      schemaVersion,
      snapshotSchemaVersion,
      ...liquidationMaterial,
      contentHash,
      snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash }),
    })

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain('canonically ordered')
  })

  test('rejects a liquidation binding whose held-symbol subset is not canonically ordered', () => {
    const binding = openingDriveMarketDataBinding(makeOpeningDriveCycle())
    const {
      contentHash: _contentHash,
      snapshotId: _snapshotId,
      schemaVersion,
      snapshotSchemaVersion,
      ...bindingMaterial
    } = binding
    const liquidationMaterial = {
      ...bindingMaterial,
      symbols: ['NVDA', 'AMD'],
      purpose: 'LIQUIDATION' as const,
      barCount: 0,
      tradeCount: 0,
    }
    const snapshotMaterial = { schemaVersion: snapshotSchemaVersion, ...liquidationMaterial }
    const contentHash = canonicalHashV1(snapshotMaterial)
    const result = Schema.decodeUnknownResult(
      ExecutionMarketDataBindingSchema,
      strictParseOptions,
    )({
      schemaVersion,
      snapshotSchemaVersion,
      ...liquidationMaterial,
      contentHash,
      snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash }),
    })

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain('symbols')
  })

  test('binds opening-drive decisions to the immutable cycle execution calendar', async () => {
    const input = makeOpeningDriveInput()
    const accepted = await build(input)
    expect(accepted.bindings.executionMarketData?.snapshotId).toBe(input.executionMarketData?.snapshotId)
    const executionMarketData = input.executionMarketData
    if (executionMarketData === undefined) throw new Error('opening-drive fixture must include execution market data')

    const mixedBinding = await Effect.runPromise(
      Effect.flip(
        buildObserveShadowDecision({
          ...input,
          executionMarketData: { ...executionMarketData, barsContentHash: hash('b') },
        }),
      ),
    )
    expect(mixedBinding).toMatchObject({ failure: 'contract', message: 'execution market-data binding is invalid' })

    const failure = await Effect.runPromise(Effect.flip(buildObserveShadowDecision(makeOpeningDriveInput(hash('f')))))
    expect(failure).toMatchObject({
      failure: 'binding',
      message: 'intraday decision calendar must match the immutable cycle execution calendar',
    })
  })

  test('rejects liquidation-only evidence for an intraday entry decision', async () => {
    const input = makeOpeningDriveInput()
    const failure = await Effect.runPromise(
      Effect.flip(
        buildObserveShadowDecision({
          ...input,
          executionMarketData: liquidationMarketDataBinding(input.cycle),
        }),
      ),
    )

    expect(failure).toMatchObject({
      failure: 'binding',
      message: 'intraday entry requires non-liquidation market-data evidence',
    })
  })

  test('rejects rehashed liquidation evidence when durably decoding an intraday entry decision', async () => {
    const input = makeIntradayMomentumInput()
    const executionMarketData = input.executionMarketData
    if (executionMarketData === undefined) throw new Error('intraday fixture must include execution market data')
    const brokerState = makeBrokerState([])
    const executionSession = bindExecutionSessionSuccess({
      executionSessionDate: executionDate,
      planningBrokerState: { observedAt: brokerObservedAt, contentHash: brokerState.stateHash },
      calendar: executionMarketData.calendar,
      executionModel: intradayMomentumExecutionModel,
    })
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        executionSession,
      }),
    )
    const { contentHash: _contentHash, ...material } = document
    const forged = makeExecutionDecisionDocument({
      ...material,
      bindings: {
        ...material.bindings,
        executionMarketData: liquidationMarketDataBinding(input.cycle),
      },
    })

    expect(Result.isFailure(forged)).toBe(true)
    if (Result.isFailure(forged)) expect(String(forged.failure.cause)).toContain('liquidation market data')
  })

  test('binds durable intraday entry evidence to its exact full-universe snapshot', async () => {
    const input = makeIntradayMomentumInput()
    const executionMarketData = input.executionMarketData
    if (executionMarketData?.schemaVersion !== 'bayn.execution-market-data-binding.v2') {
      throw new Error('intraday fixture must include archive execution market data v2')
    }
    const executionSession = bindExecutionSessionSuccess({
      executionSessionDate: executionDate,
      planningBrokerState: {
        observedAt: brokerObservedAt,
        contentHash: makeBrokerState([]).stateHash,
      },
      calendar: executionMarketData.calendar,
      executionModel: intradayMomentumExecutionModel,
    })
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        executionSession,
      }),
    )
    const { contentHash: _contentHash, ...material } = document
    const alternateBinding = currentEntryMarketDataBinding(input.cycle, hash('b'))
    const mismatchedSnapshot = makeExecutionDecisionDocument({
      ...material,
      bindings: { ...material.bindings, executionMarketData: alternateBinding },
    })
    expect(Result.isFailure(mismatchedSnapshot)).toBe(true)
    if (Result.isFailure(mismatchedSnapshot)) {
      expect(String(mismatchedSnapshot.failure.cause)).toContain('outer decision snapshot identity')
    }

    const legacyBinding = openingDriveMarketDataBinding(input.cycle)
    const legacyEvidence = makeExecutionDecisionDocument({
      ...material,
      bindings: {
        ...material.bindings,
        snapshotId: legacyBinding.snapshotId,
        snapshotContentHash: legacyBinding.contentHash,
        executionMarketData: legacyBinding,
      },
    })
    expect(Result.isFailure(legacyEvidence)).toBe(true)
    if (Result.isFailure(legacyEvidence)) {
      expect(String(legacyEvidence.failure.cause)).toContain('entry requires execution market-data binding v2')
    }

    const {
      contentHash: _bindingContentHash,
      snapshotId: _bindingSnapshotId,
      schemaVersion,
      snapshotSchemaVersion,
      ...bindingMaterial
    } = executionMarketData
    const subsetMaterial = { ...bindingMaterial, symbols: executionMarketData.symbols.slice(0, 1) }
    const snapshotMaterial = { schemaVersion: snapshotSchemaVersion, ...subsetMaterial }
    const subsetContentHash = canonicalHashV1(snapshotMaterial)
    const subsetBinding = Result.getOrThrow(
      Schema.decodeUnknownResult(
        ExecutionMarketDataBindingSchema,
        strictParseOptions,
      )({
        schemaVersion,
        snapshotSchemaVersion,
        ...subsetMaterial,
        contentHash: subsetContentHash,
        snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash: subsetContentHash }),
      }),
    )
    const subsetEvidence = makeExecutionDecisionDocument({
      ...material,
      bindings: {
        ...material.bindings,
        snapshotId: subsetBinding.snapshotId,
        snapshotContentHash: subsetBinding.contentHash,
        executionMarketData: subsetBinding,
      },
    })
    expect(Result.isFailure(subsetEvidence)).toBe(true)
    if (Result.isFailure(subsetEvidence)) {
      expect(String(subsetEvidence.failure.cause)).toContain('complete execution universe')
    }

    const alternateSessionDate = '2026-07-23'
    const { normalizedResponseHash: _calendarHash, ...calendarMaterial } = executionMarketData.calendar
    const alternateCalendarMaterial = {
      ...calendarMaterial,
      requestedRange: { start: alternateSessionDate, end: alternateSessionDate },
      sessions: calendarMaterial.sessions.map((session) => ({ ...session, date: alternateSessionDate })),
    }
    const {
      contentHash: _alternateContentHash,
      snapshotId: _alternateSnapshotId,
      schemaVersion: alternateBindingSchemaVersion,
      snapshotSchemaVersion: alternateSnapshotSchemaVersion,
      ...alternateBindingMaterial
    } = executionMarketData
    const otherSessionMaterial = {
      ...alternateBindingMaterial,
      sessionDate: alternateSessionDate,
      calendar: {
        ...alternateCalendarMaterial,
        normalizedResponseHash: canonicalHashV1(alternateCalendarMaterial),
      },
    }
    const otherSessionSnapshotMaterial = {
      schemaVersion: alternateSnapshotSchemaVersion,
      ...otherSessionMaterial,
    }
    const otherSessionContentHash = canonicalHashV1(otherSessionSnapshotMaterial)
    const otherSessionBinding = Result.getOrThrow(
      Schema.decodeUnknownResult(
        ExecutionMarketDataBindingSchema,
        strictParseOptions,
      )({
        schemaVersion: alternateBindingSchemaVersion,
        snapshotSchemaVersion: alternateSnapshotSchemaVersion,
        ...otherSessionMaterial,
        contentHash: otherSessionContentHash,
        snapshotId: canonicalHashV1({ ...otherSessionSnapshotMaterial, contentHash: otherSessionContentHash }),
      }),
    )
    const targetExecutionTerms = material.targetPlan.executionTerms
    if (targetExecutionTerms === undefined) throw new Error('intraday fixture must persist execution terms')
    const { outputHash: _targetPlanHash, ...targetPlanMaterial } = material.targetPlan
    const otherSessionTargetPlanMaterial = {
      ...targetPlanMaterial,
      executionTerms: {
        ...targetExecutionTerms,
        snapshotId: otherSessionBinding.snapshotId,
        snapshotContentHash: otherSessionBinding.contentHash,
      },
    }
    const otherSessionEvidence = makeExecutionDecisionDocument({
      ...material,
      bindings: {
        ...material.bindings,
        snapshotId: otherSessionBinding.snapshotId,
        snapshotContentHash: otherSessionBinding.contentHash,
        executionMarketData: otherSessionBinding,
      },
      targetPlan: {
        ...otherSessionTargetPlanMaterial,
        outputHash: canonicalHashV1(otherSessionTargetPlanMaterial),
      },
    })
    expect(Result.isFailure(otherSessionEvidence)).toBe(true)
    if (Result.isFailure(otherSessionEvidence)) {
      expect(String(otherSessionEvidence.failure.cause)).toContain(
        'market-data session and calendar must match the execution session',
      )
    }
  })

  test('binds full-session intraday decisions to the exact rolling snapshot and cycle calendar', async () => {
    const input = makeIntradayMomentumInput()
    const accepted = await build(input)

    expect(accepted.bindings.executionMarketData?.snapshotId).toBe(input.executionMarketData?.snapshotId)
    const failure = await Effect.runPromise(
      Effect.flip(buildObserveShadowDecision(makeIntradayMomentumInput(hash('f')))),
    )
    expect(failure).toMatchObject({
      failure: 'binding',
      message: 'intraday decision calendar must match the immutable cycle execution calendar',
    })
  })

  test('keeps historical v2 signal lineage while binding its opening-drive decision to intraday data', async () => {
    const input = makeOpeningDriveInput(undefined, makeHistoricalOpeningDriveCycle())
    const document = await build(input)

    expect(input.plannerInput.signalDate).toBe(signalDate)
    expect(document.bindings).toMatchObject({
      snapshotId,
      snapshotContentHash,
      executionMarketData: { snapshotId: input.executionMarketData?.snapshotId },
    })
  })

  test('admits a bounded opening-drive flat target with a distinct verified close snapshot', async () => {
    const input = makeOpeningDriveInput()
    const entryMarketData = input.executionMarketData
    if (entryMarketData === undefined) throw new Error('opening-drive fixture must include entry market data')
    const closeMarketData = liquidationMarketDataBinding(input.cycle, hash('b'))
    expect(closeMarketData.snapshotId).not.toBe(entryMarketData.snapshotId)
    const compiledDecision = {
      schemaVersion: 'bayn.execution-flat-target.v1' as const,
      strategyName: 'opening-drive-momentum' as const,
      sessionDate: executionDate,
      targetWeights: { AMD: 0 as const, NVDA: 0 as const },
      symbols: ['AMD', 'NVDA'],
      reason: 'mandate-close' as const,
    }
    const closeSubmitCutoffAt = '2026-07-22T19:45:00.000Z'
    const brokerState = makeBrokerState()
    const closePriceMaterial = {
      ...input.plannerInput.referencePrices,
      snapshotId: closeMarketData.snapshotId,
      snapshotContentHash: closeMarketData.contentHash,
    }
    const { contentHash: _entryPriceHash, ...closePriceFields } = closePriceMaterial
    const plannerInput = {
      ...input.plannerInput,
      brokerState: {
        account: brokerState.account,
        positions: brokerState.positions,
        positionsObservedAt: brokerObservedAt,
        orders: brokerState.orders,
        ordersObservedAt: brokerObservedAt,
        accountingHash,
        reconciliation: brokerState.reconciliation,
        unknownOrderCount: 0,
      },
      decisionHash: canonicalHashV1(compiledDecision),
      targetWeights: compiledDecision.targetWeights,
      referencePrices: { ...closePriceFields, contentHash: canonicalHashV1(closePriceFields) },
      executionTerms: {
        orderType: OrderType.Limit as const,
        timeInForce: TimeInForce.ImmediateOrCancel as const,
        priceReference: 'verified-adverse-quote-boundary' as const,
        executionPurpose: 'forced-close' as const,
        snapshotId: closeMarketData.snapshotId,
        snapshotContentHash: closeMarketData.contentHash,
        maximumBuyQuantityMicros: { AMD: '0', NVDA: '0' },
      },
      submissionCutoffAt: closeSubmitCutoffAt,
    }
    const targetPlan = planTargetsSuccess(plannerInput)
    const executionSession = bindExecutionSessionSuccess({
      executionSessionDate: executionDate,
      planningBrokerState: { observedAt: brokerObservedAt, contentHash: brokerState.stateHash },
      calendar: closeMarketData.calendar,
      executionModel: openingDriveExecutionModel,
    })
    const riskInputs = targetPlan.intentTargets.map((target) => {
      const plannedTarget = targetPlan.targets.find(({ symbol }) => symbol === target.symbol)
      if (plannedTarget === undefined) throw new Error(`close fixture has no target price for ${target.symbol}`)
      return {
        symbol: target.symbol,
        notionalLimitMicros: (
          (BigInt(target.quantityMicros) * BigInt(plannedTarget.referencePriceMicros)) /
          1_000_000n
        ).toString(),
        state: decodeState({
          schemaVersion: 'bayn.paper-risk-state.v2',
          brokerMode: BrokerMode.Execution,
          account: brokerState.account,
          positions: brokerState.positions,
          positionsObservedAt: brokerObservedAt,
          orders: brokerState.orders,
          ordersObservedAt: brokerObservedAt,
          reconciliation: brokerState.reconciliation,
          authority: {
            schemaVersion: 'bayn.paper-authority.v1',
            generationHash: hash('6'),
            maximum: Authority.Observe,
            effective: Authority.Observe,
            kill: KillState.Clear,
            version: 1,
            updatedAt: brokerObservedAt,
          },
          authorityObservedAt: brokerObservedAt,
          unknownMutationCount: 0,
          dailyTradedNotionalMicros: '0',
          dayStartEquityMicros: '1000000000',
          peakEquityMicros: '1000000000',
          accountingHash,
          marketDataSymbol: target.symbol,
          marketDataHash: closeMarketData.contentHash,
          executionMarketDataHash: closeMarketData.contentHash,
          referencePriceMicros: plannedTarget.referencePriceMicros,
          expectedExecutionPriceMicros: plannedTarget.referencePriceMicros,
          marketDataObservedAt: closeMarketData.observedAt,
          executionSession,
          reservedBuyingPowerMicros: '0',
          evaluatedAt: plannerInput.observedAt,
          closeOnly: true,
          closeOnlyExpiresAt: closeSubmitCutoffAt,
        }),
      }
    })
    const closeInput = {
      ...input,
      compiledDecision,
      executionMarketData: closeMarketData,
      plannerInput,
      targetPlan,
      riskInputs,
      submissionCutoffAt: closeSubmitCutoffAt,
    }
    const document = await build(closeInput)

    expect(document.bindings.snapshotId).toBe(entryMarketData.snapshotId)
    expect(document.bindings.executionMarketData?.snapshotId).toBe(closeMarketData.snapshotId)
    expect(document.targetPlan.status).toBe(TargetPlanStatus.Planned)

    const executionDocument = await Effect.runPromise(
      buildExecutionDecision({
        ...closeInput,
        riskInputs: closeInput.riskInputs.map((riskInput) => ({
          ...riskInput,
          state: {
            ...riskInput.state,
            authority: {
              ...riskInput.state.authority,
              maximum: Authority.Execution,
              effective: Authority.Execution,
            },
          },
        })),
        authorityGenerationHash: hash('6'),
        executionSession,
      }),
    )
    const { contentHash: _documentContentHash, ...documentMaterial } = executionDocument
    const replacementCloseBinding = liquidationMarketDataBinding(input.cycle, hash('e'))
    const mismatchedPersistedClose = makeExecutionDecisionDocument({
      ...documentMaterial,
      bindings: { ...documentMaterial.bindings, executionMarketData: replacementCloseBinding },
    })
    expect(Result.isFailure(mismatchedPersistedClose)).toBe(true)
    if (Result.isFailure(mismatchedPersistedClose)) {
      expect(String(mismatchedPersistedClose.failure.cause)).toContain(
        'exact market-data snapshot persisted by the target plan',
      )
    }

    const subsetCloseBinding = liquidationMarketDataBinding(input.cycle, hash('d'), ['AMD'])
    const closeExecutionTerms = documentMaterial.targetPlan.executionTerms
    if (closeExecutionTerms === undefined) throw new Error('close fixture must persist execution terms')
    const { outputHash: _targetPlanOutputHash, ...targetPlanMaterial } = documentMaterial.targetPlan
    const mismatchedTargetPlanMaterial = {
      ...targetPlanMaterial,
      executionTerms: {
        ...closeExecutionTerms,
        snapshotId: subsetCloseBinding.snapshotId,
        snapshotContentHash: subsetCloseBinding.contentHash,
      },
    }
    const mismatchedPersistedSymbols = makeExecutionDecisionDocument({
      ...documentMaterial,
      bindings: { ...documentMaterial.bindings, executionMarketData: subsetCloseBinding },
      targetPlan: {
        ...mismatchedTargetPlanMaterial,
        outputHash: canonicalHashV1(mismatchedTargetPlanMaterial),
      },
    })
    expect(Result.isFailure(mismatchedPersistedSymbols)).toBe(true)
    if (Result.isFailure(mismatchedPersistedSymbols)) {
      expect(String(mismatchedPersistedSymbols.failure.cause)).toContain(
        'liquidation market-data symbols must exactly match the ordered close targets',
      )
    }

    const failure = await Effect.runPromise(
      Effect.flip(
        buildObserveShadowDecision({
          ...closeInput,
          executionMarketData: openingDriveMarketDataBinding(input.cycle, hash('c')),
        }),
      ),
    )
    expect(failure).toMatchObject({
      failure: 'binding',
      message: 'intraday close requires explicit liquidation market-data evidence',
    })

    const mismatchedSymbols = await Effect.runPromise(
      Effect.flip(
        buildObserveShadowDecision({
          ...closeInput,
          executionMarketData: liquidationMarketDataBinding(input.cycle, hash('d'), ['AMD']),
        }),
      ),
    )
    expect(mismatchedSymbols).toMatchObject({
      failure: 'binding',
      message: 'intraday close market-data symbols must match the flat execution target',
    })
  })

  test('binds each decision variant to its strategy and validates exact flat-close weights', () => {
    const decision = makeDecision({ AMD: 0.4, NVDA: 0.6 })
    expect(runtimeDecisionMatchesStrategy(decision, 'risk-balanced-trend')).toBe(true)
    expect(runtimeDecisionMatchesStrategy(decision, 'opening-drive-momentum')).toBe(false)

    const decodeFlatTarget = Schema.decodeUnknownResult(FlatExecutionTargetSchema, strictParseOptions)
    const flatTarget = {
      schemaVersion: 'bayn.execution-flat-target.v1',
      strategyName: 'opening-drive-momentum',
      sessionDate: executionDate,
      targetWeights: { AMD: 0, NVDA: 0 },
      symbols: ['AMD', 'NVDA'],
      reason: 'mandate-close',
    }
    const decoded = decodeFlatTarget(flatTarget)
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) {
      expect(runtimeDecisionMatchesStrategy(decoded.success, 'opening-drive-momentum')).toBe(true)
      expect(runtimeDecisionMatchesStrategy(decoded.success, 'risk-balanced-trend')).toBe(false)
    }
    expect(Result.isFailure(decodeFlatTarget({ ...flatTarget, targetWeights: { AMD: 0.1, NVDA: 0 } }))).toBe(true)
    expect(Result.isFailure(decodeFlatTarget({ ...flatTarget, targetWeights: { AMD: 0 } }))).toBe(true)
  })

  test('rejects a flat execution target through the ordinary entry lease', async () => {
    const input = makeInput({ AMD: 0, NVDA: 0 })
    const compiledDecision = {
      schemaVersion: 'bayn.execution-flat-target.v1' as const,
      strategyName: 'risk-balanced-trend',
      sessionDate: executionDate,
      targetWeights: { AMD: 0 as const, NVDA: 0 as const },
      symbols: ['AMD', 'NVDA'],
      reason: 'mandate-close' as const,
    }
    const plannerInput = {
      ...input.plannerInput,
      decisionHash: canonicalHashV1(compiledDecision),
      targetWeights: compiledDecision.targetWeights,
    }
    const targetPlan = planTargetsSuccess(plannerInput)
    const riskInputs =
      targetPlan.status === TargetPlanStatus.Planned
        ? targetPlan.intentTargets.map((target) => {
            const referencePrice = plannerInput.referencePrices.priceMicros[target.symbol]
            if (referencePrice === undefined) throw new Error(`missing fixture reference price for ${target.symbol}`)
            return {
              symbol: target.symbol,
              notionalLimitMicros: ((BigInt(target.quantityMicros) * BigInt(referencePrice)) / 1_000_000n).toString(),
              state: makeRiskState(input.cycle, target.symbol),
            }
          })
        : []

    const failure = await Effect.runPromise(
      Effect.flip(
        buildExecutionDecision({
          ...input,
          compiledDecision,
          plannerInput,
          targetPlan,
          riskInputs,
          authorityGenerationHash: hash('6'),
          executionSession: makeRiskState(input.cycle, 'AMD').executionSession,
        }),
      ),
    )

    expect(failure).toMatchObject({
      failure: 'binding',
      message: 'flat execution targets require the explicit bounded close-only lease',
    })
  })

  test('binds exact final target deltas and cumulative v3 risk without any dispatchable intent state', async () => {
    const input = makeInput()
    const first = await build(input)
    const replay = await build(makeInput())

    expect(replay).toEqual(first)
    expect(first.contentHash).toBe('1a09e08fa19e874ccb0f0ab426483f3b6892c24904682d6bf4ff135524e7a3d4')
    expect(first).toMatchObject({
      schemaVersion: 'bayn.observe-shadow-decision.v1',
      mode: 'OBSERVE',
      dispatchable: false,
      bindings: {
        cycleId: input.cycle.identity.cycleId,
        snapshotId,
        snapshotContentHash,
        strategyDecisionHash: canonicalHashV1(input.compiledDecision),
        policyHash: canonicalHashV1(input.policy),
        planningBrokerStateHash: input.plannerInput.brokerState.reconciliation.observedHash,
        reconciliationId: input.plannerInput.brokerState.reconciliation.reconciliationId,
        reconciliationHash: input.plannerInput.brokerState.reconciliation.contentHash,
      },
      submissionCutoffAt: input.cycle.window.submissionCutoffAt,
      expiresAt: input.cycle.window.submissionCutoffAt,
      targetPlan: {
        status: TargetPlanStatus.Planned,
        reason: null,
        requiredReferenceBuyNotionalMicros: '800000000',
        residualBuyingPowerMicros: '200000000',
      },
    })

    expect(
      first.targetPlan.targets.map(({ symbol, currentQuantityMicros, targetQuantityMicros }) => [
        symbol,
        currentQuantityMicros,
        targetQuantityMicros,
      ]),
    ).toEqual([
      ['AMD', '1000000', '4000000'],
      ['NVDA', '1000000', '6000000'],
    ])
    expect(
      first.targetPlan.intentTargets.map(({ symbol, side, quantityMicros }) => [symbol, side, quantityMicros]),
    ).toEqual([
      ['AMD', OrderSide.Buy, '3000000'],
      ['NVDA', OrderSide.Buy, '5000000'],
    ])
    expect(
      first.targetPlan.intentTargets.every((target) => target.decisionHash === first.bindings.strategyDecisionHash),
    ).toBe(true)
    expect(first.deltaRisk.map(({ evaluation }) => evaluation.metrics.aggregateBuyingPowerMicros)).toEqual([
      '300000000',
      '800000000',
    ])
    expect(first.deltaRisk.map(({ evaluation }) => evaluation.metrics.dailyTradedNotionalMicros)).toEqual([
      '300000000',
      '800000000',
    ])
    expect(first.deltaRisk.map(({ evaluation }) => evaluation.metrics.postTradeGrossExposureMicros)).toEqual([
      '500000000',
      '1000000000',
    ])
    expect(first.deltaRisk.map(({ evaluation }) => evaluation.metrics.postTradeNetExposureMicros)).toEqual([
      '500000000',
      '1000000000',
    ])
    expect(first.deltaRisk.map(({ evaluation }) => evaluation.decision.reasonCodes)).toEqual([
      [Reason.AuthorityNotGranted],
      [Reason.AuthorityNotGranted],
    ])
    expect(
      first.deltaRisk.every(
        ({ evaluation }) => evaluation.gates.find((gate) => gate.name === Gate.Reconciliation)?.passed === true,
      ),
    ).toBe(true)
    expect(first.deltaRisk[1]?.evaluation.input.positionsHash).not.toBe(
      first.deltaRisk[0]?.evaluation.input.positionsHash,
    )
    expect(first.deltaRisk[1]?.evaluation.input.inputHash).not.toBe(first.deltaRisk[0]?.evaluation.input.inputHash)
    expect(
      first.deltaRisk.every(
        ({ evaluation }) =>
          evaluation.decision.outcome === RiskOutcome.Blocked &&
          evaluation.decision.reasonCodes.includes(Reason.AuthorityNotGranted) &&
          evaluation.decision.expiresAt <= first.submissionCutoffAt,
      ),
    ).toBe(true)
    expect(
      first.targetPlan.intentTargets.every(
        (target) => !('intentId' in target) && !('clientOrderId' in target) && !('state' in target),
      ),
    ).toBe(true)
    const { contentHash, ...material } = first
    expect(contentHash).toBe(canonicalHashV1(material))
    const boundCycle = decodeCycle({
      ...input.cycle,
      bindings: {
        snapshotId,
        decisionHash: first.contentHash,
      },
      stateVersion: input.cycle.stateVersion + 1,
      updatedAt: first.createdAt,
    })
    expect(boundCycle.bindings.decisionHash).toBe(first.contentHash)
    expect(() =>
      decodeCycle({
        ...boundCycle,
        bindings: { ...boundCycle.bindings, shadowDecision: first },
      }),
    ).toThrow()
  })

  test('revalues unchanged holdings at the Signal reference basis before cumulative execution risk', async () => {
    const inflatedNvda = {
      ...position('NVDA'),
      marketPriceMicros: '300000000',
      marketValueMicros: '300000000',
      unrealizedPnlMicros: '200000000',
    }
    const input = makeInput(
      { AMD: 0.4, NVDA: 0.1 },
      [position('AMD'), inflatedNvda],
      decodePolicy({
        ...makePolicy(),
        maxGrossExposureMicros: '550000000',
        maxNetExposureMicros: '550000000',
      }),
    )
    const generationHash = hash('6')
    const paperRiskInputs = input.riskInputs.map((riskInput) => ({
      ...riskInput,
      state: decodeState({
        ...riskInput.state,
        authority: {
          ...riskInput.state.authority,
          generationHash,
          maximum: Authority.Execution,
          effective: Authority.Execution,
        },
      }),
    }))
    const executionSession = paperRiskInputs[0]?.state.executionSession
    if (executionSession === undefined) throw new Error('fixture requires one execution risk delta')

    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        riskInputs: paperRiskInputs,
        authorityGenerationHash: generationHash,
        executionSession,
      }),
    )

    expect(document.targetPlan.intentTargets.map(({ symbol }) => symbol)).toEqual(['AMD'])
    expect(document.deltaRisk).toHaveLength(1)
    expect(document.deltaRisk[0]?.evaluation.metrics.postTradeGrossExposureMicros).toBe('500000000')
    expect(document.deltaRisk[0]?.evaluation.metrics.postTradeNetExposureMicros).toBe('500000000')
    expect(document.deltaRisk[0]?.evaluation.decision.outcome).toBe(RiskOutcome.Approved)
    expect(document.dispatchable).toBe(true)
    expect(document).not.toHaveProperty('riskBlock')
  })

  test('persists deterministic NO_TRADE and pre-cutoff blocked planner results without ignored risk input', async () => {
    const noTrade = await build(makeInput({ AMD: 0.1, NVDA: 0.1 }))
    const staleInput = makeInput()
    const stalePlannerInput = {
      ...staleInput.plannerInput,
      maximumInputAgeMs: 1,
    }
    const stale = await build({
      ...staleInput,
      plannerInput: stalePlannerInput,
      targetPlan: planTargetsSuccess(stalePlannerInput),
      riskInputs: [],
    })

    expect(noTrade.targetPlan).toMatchObject({
      status: TargetPlanStatus.NoTrade,
      reason: TargetPlanReason.TargetsSatisfied,
    })
    expect(noTrade.deltaRisk).toEqual([])
    expect(stale.targetPlan).toMatchObject({
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.InputStale,
    })
    expect(stale.deltaRisk).toEqual([])
    expect(noTrade.expiresAt).toBe(noTrade.submissionCutoffAt)
    expect(stale.expiresAt).toBe(stale.submissionCutoffAt)
  })

  test('persists identity mismatch without valuing an out-of-universe held position', async () => {
    const input = makeInput({ AMD: 0.4, NVDA: 0.6 }, [position('GLD')])

    expect(input.targetPlan).toMatchObject({
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.IdentityMismatch,
    })
    const document = await build(input)

    expect(document.targetPlan).toEqual(input.targetPlan)
    expect(document.deltaRisk).toEqual([])
    expect(document.dispatchable).toBe(false)
  })

  test('clamps blocked risk evidence at the last instant before the exclusive cycle cutoff', async () => {
    const input = makeInput()
    const createdAt = utcInstantFromEpochMillis(Date.parse(input.cycle.window.submissionCutoffAt) - 1)
    const plannerInput = { ...input.plannerInput, observedAt: createdAt }
    const document = await build({
      ...input,
      plannerInput,
      targetPlan: planTargetsSuccess(plannerInput),
      riskInputs: input.riskInputs.map((riskInput) => ({
        ...riskInput,
        state: { ...riskInput.state, evaluatedAt: createdAt },
      })),
    })

    expect(document.createdAt).toBe(createdAt)
    expect(document.deltaRisk).toHaveLength(2)
    expect(document.deltaRisk.every(({ evaluation }) => evaluation.decision.expiresAt === document.expiresAt)).toBe(
      true,
    )
  })

  test('fails closed on drift in cycle, snapshot, target plan, compiled decision, risk state, or authority', async () => {
    const input = makeInput()
    const variants: ObserveShadowDecisionInput[] = [
      {
        ...input,
        snapshot: { ...input.snapshot, snapshotId: hash('f') },
      },
      {
        ...input,
        targetPlan: planTargetsSuccess({
          ...input.plannerInput,
          maximumInputAgeMs: input.plannerInput.maximumInputAgeMs + 1,
        }),
      },
      {
        ...input,
        compiledDecision: makeDecision({ AMD: 0.5, NVDA: 0.5 }),
      },
      {
        ...input,
        riskInputs: input.riskInputs.map((riskInput, index) =>
          index === 0
            ? {
                ...riskInput,
                state: {
                  ...riskInput.state,
                  reconciliation: { ...riskInput.state.reconciliation, contentHash: hash('e') },
                },
              }
            : riskInput,
        ),
      },
      {
        ...input,
        riskInputs: input.riskInputs.map((riskInput, index) =>
          index === 0
            ? {
                ...riskInput,
                state: {
                  ...riskInput.state,
                  authority: { ...riskInput.state.authority, effective: Authority.Execution },
                },
              }
            : riskInput,
        ),
      },
    ]

    for (const variant of variants) {
      const exit = await Effect.runPromiseExit(buildObserveShadowDecision(variant))
      expect(Exit.isFailure(exit)).toBe(true)
    }
  })

  test('rejects incomplete, malformed covariance and signal evidence, and excess compiled-decision fields', async () => {
    const input = makeInput()
    const compiled = input.compiledDecision
    if (compiled.schemaVersion !== 'bayn.risk-balanced-trend-decision-plan.v1') {
      throw new Error('daily shadow-decision fixture must retain the risk-balanced decision contract')
    }
    const { estimatedAnnualizedPortfolioVolatility: _missingVolatility, ...missingField } = compiled
    const malformedDecisions = [
      missingField,
      {
        ...compiled,
        covarianceWindow: {
          ...compiled.covarianceWindow,
          returnCount: 0,
        },
      },
      {
        ...compiled,
        signals: compiled.signals.map((signal, index) => (index === 0 ? { ...signal, horizons: [] } : signal)),
      },
      {
        ...compiled,
        unexpectedFutureEvidence: true,
      },
    ]

    const failures = await Promise.all(
      malformedDecisions.map((compiledDecision) =>
        Effect.runPromise(Effect.flip(buildObserveShadowDecision({ ...input, compiledDecision }))),
      ),
    )
    expect(failures.map(({ failure }) => failure)).toEqual(['contract', 'contract', 'contract', 'contract'])
    expect(failures.every(({ cause }) => cause !== undefined)).toBe(true)
  })

  test('durable schema rejects approval, coordinator fields, and content-hash rewrites', async () => {
    const document = await build(makeInput())
    const noTradeDocument = await build(makeInput({ AMD: 0.1, NVDA: 0.1 }))
    const approved = {
      ...document,
      deltaRisk: document.deltaRisk.map((risk, index) =>
        index === 0
          ? {
              ...risk,
              evaluation: {
                ...risk.evaluation,
                decision: {
                  ...risk.evaluation.decision,
                  outcome: RiskOutcome.Approved,
                  reasonCodes: [],
                },
              },
            }
          : risk,
      ),
    }
    const coordinatorMaterial = {
      ...document,
      targetPlan: {
        ...document.targetPlan,
        intentTargets: document.targetPlan.intentTargets.map((target, index) =>
          index === 0 ? { ...target, intentId: hash('f'), clientOrderId: 'broker-consumable' } : target,
        ),
      },
    }
    const rewritten = { ...document, targetPlan: { ...document.targetPlan, outputHash: hash('f') } }
    const cutoffMaterial = {
      ...noTradeDocument,
      createdAt: noTradeDocument.submissionCutoffAt,
    }
    const { contentHash: _, ...cutoffWithoutHash } = cutoffMaterial
    const exactCutoff = { ...cutoffWithoutHash, contentHash: canonicalHashV1(cutoffWithoutHash) }
    const swappedMaterial = {
      ...document,
      deltaRisk: [...document.deltaRisk].reverse(),
    }
    const { contentHash: _swappedHash, ...swappedWithoutHash } = swappedMaterial
    const swappedRisk = { ...swappedWithoutHash, contentHash: canonicalHashV1(swappedWithoutHash) }

    for (const candidate of [approved, coordinatorMaterial, rewritten, exactCutoff, swappedRisk]) {
      expect(Result.isFailure(decodeObserveShadowDecisionDocument(candidate))).toBe(true)
    }
  })

  test('rejects ill-formed Unicode at the exact shadow binding path without a hash defect', async () => {
    const document = await build(makeInput({ AMD: 0.1, NVDA: 0.1 }))
    const result = decodeObserveShadowDecisionDocument({
      ...document,
      bindings: { ...document.bindings, strategyName: '\ud800' },
    })

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'ShadowDecisionContractFailure',
        operation: 'decode',
        reason: 'contract',
      })
      expect(String(result.failure.cause)).toContain('["bindings"]["strategyName"]')
      expect(String(result.failure.cause)).toContain('well-formed Unicode')
    }
  })

  test('returns each closed shadow failure category and contract-constructor failure', async () => {
    const input = makeInput()
    const validDocument = await build(input)
    const bindingFailure = {
      ...input,
      snapshot: { ...input.snapshot, snapshotId: hash('f') },
    }
    const riskFailure = {
      ...input,
      riskInputs: input.riskInputs.map((riskInput) => ({
        ...riskInput,
        state: {
          ...riskInput.state,
          authority: {
            ...riskInput.state.authority,
            maximum: Authority.Execution,
          },
        },
      })),
    }
    const failures = await Promise.all(
      [{}, bindingFailure, riskFailure].map((candidate) =>
        Effect.runPromise(Effect.flip(buildObserveShadowDecision(candidate))),
      ),
    )
    expect(failures.map((failure) => failure.failure)).toEqual(['contract', 'binding', 'risk'])
    expect(failures.every((failure) => failure._tag === 'ShadowDecisionError')).toBe(true)

    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const constructorFailures = [
      makeObserveShadowDecisionDocument(null),
      makeObserveShadowDecisionDocument({}),
      makeObserveShadowDecisionDocument(cyclic),
      decodeObserveShadowDecisionDocument({}),
    ]
    expect(
      constructorFailures.map((result) =>
        Result.isFailure(result) ? [result.failure.operation, result.failure.reason] : null,
      ),
    ).toEqual([
      ['make', 'contract'],
      ['make', 'contract'],
      ['make', 'canonicalization'],
      ['decode', 'contract'],
    ])
    const cyclicFailure = constructorFailures[2]
    if (Result.isFailure(cyclicFailure)) {
      expect(cyclicFailure.failure.cause).toEqual({
        _tag: 'CanonicalJsonFailure',
        path: '$.self',
        reason: 'cycle',
        actualType: 'object',
      })
    }

    const { contentHash: _, ...validMaterial } = validDocument
    const reflectionCause = new Error('second ownKeys failed')
    let ownKeysCalls = 0
    const statefulMaterial = new Proxy(validMaterial, {
      ownKeys: (target) => {
        ownKeysCalls += 1
        if (ownKeysCalls === 2) throw reflectionCause
        return Reflect.ownKeys(target)
      },
    })
    const statefulFailure = makeObserveShadowDecisionDocument(statefulMaterial)
    expect(Result.isFailure(statefulFailure)).toBe(true)
    if (Result.isFailure(statefulFailure)) {
      expect(statefulFailure.failure).toMatchObject({
        _tag: 'ShadowDecisionContractFailure',
        operation: 'make',
        reason: 'canonicalization',
      })
      expect(statefulFailure.failure.cause).toBe(reflectionCause)
    }

    const contractFailures = shadowContractFailurePairs.map(
      (pair) => new ShadowDecisionContractFailure({ ...pair, message: 'failure-pair coverage' }),
    )
    expect(shadowContractFailurePairCoverage).toBe(true)
    expect(contractFailures.map(({ operation, reason }) => ({ operation, reason }))).toEqual([
      ...shadowContractFailurePairs,
    ])
  })
})
