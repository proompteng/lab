import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Result, Schema } from 'effect'

import {
  AutonomousCycleSchema,
  CycleState,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  type AutonomousCycle,
} from './cycle'
import { defaultExecutionModel } from './execution-model'
import { bindExecutionSession, type BindExecutionSessionInput } from './execution-session'
import { canonicalHashV1 } from './hash'
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
} from './paper'
import { reconciledStateHash } from './reconciliation'
import { BrokerMode, Gate, PolicySchema, Reason, StateSchema, type Policy, type State } from './risk'
import { strictParseOptions } from './schemas'
import {
  decodeObserveShadowDecisionDocument,
  makeObserveShadowDecisionDocument,
  ShadowDecisionContractFailure,
  type ObserveShadowDecisionDocument,
} from './shadow-decision-contract'
import {
  buildObserveShadowDecision,
  type ObserveShadowDecisionInput,
  type ShadowDeltaRiskInput,
} from './shadow-decision'
import { TargetPlanReason, TargetPlanStatus, planTargets, type TargetPlannerInput } from './target-planner'
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

const makeBrokerState = () => {
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
  const positions = [position('AMD'), position('NVDA')]
  const orders = [] as const
  const stateHash = reconciledStateHash({
    account,
    positions,
    positionsObservedAt: brokerObservedAt,
    orders,
    ordersObservedAt: brokerObservedAt,
    accountingHash,
  })
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
    schemaVersion: 'bayn.paper-risk-policy.v1',
    accountId,
    brokerMode: BrokerMode.Paper,
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
    maxUnresolvedOrders: 0,
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
): TargetPlannerInput => {
  const brokerState = makeBrokerState()
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

const makeRiskState = (cycle: AutonomousCycle, symbol: string): State => {
  const brokerState = makeBrokerState()
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
    brokerMode: BrokerMode.Paper,
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
): ObserveShadowDecisionInput => {
  const cycle = makeCycle()
  const compiledDecision = makeDecision(targetWeights)
  const policy = makePolicy()
  const plannerInput = makePlannerInput(cycle, compiledDecision, policy)
  const quantities: Readonly<Record<string, string>> = {
    AMD: '3000000',
    NVDA: '5000000',
  }
  const riskInputs: ShadowDeltaRiskInput[] =
    targetWeights.AMD === 0.4 && targetWeights.NVDA === 0.6
      ? ['AMD', 'NVDA'].map((symbol) => ({
          symbol,
          notionalLimitMicros: (
            (BigInt(quantities[symbol]) * BigInt(plannerInput.referencePrices.priceMicros[symbol])) /
            1_000_000n
          ).toString(),
          state: makeRiskState(cycle, symbol),
        }))
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
    targetPlan: planTargetsSuccess(plannerInput),
    policy,
    riskInputs,
  }
}

const build = (input: ObserveShadowDecisionInput): Promise<ObserveShadowDecisionDocument> =>
  Effect.runPromise(buildObserveShadowDecision(input))

describe('OBSERVE shadow decision', () => {
  test('binds exact final target deltas and cumulative v3 risk without any dispatchable intent state', async () => {
    const input = makeInput()
    const first = await build(input)
    const replay = await build(makeInput())

    expect(replay).toEqual(first)
    expect(first.contentHash).toBe('9690389d06537db6d479ef7c1c690d6f5edb21dcd8b4e483baba1e9d372998b3')
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
      [Reason.AuthorityNotPaper],
      [Reason.AuthorityNotPaper],
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
          evaluation.decision.reasonCodes.includes(Reason.AuthorityNotPaper) &&
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

  test('clamps blocked risk evidence at the last instant before the exclusive cycle cutoff', async () => {
    const input = makeInput()
    const createdAt = new Date(Date.parse(input.cycle.window.submissionCutoffAt) - 1).toISOString()
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
                  authority: { ...riskInput.state.authority, effective: Authority.Paper },
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
    const { estimatedAnnualizedPortfolioVolatility: _missingVolatility, ...missingField } = input.compiledDecision
    const malformedDecisions = [
      missingField,
      {
        ...input.compiledDecision,
        covarianceWindow: {
          ...input.compiledDecision.covarianceWindow,
          returnCount: 0,
        },
      },
      {
        ...input.compiledDecision,
        signals: input.compiledDecision.signals.map((signal, index) =>
          index === 0 ? { ...signal, horizons: [] } : signal,
        ),
      },
      {
        ...input.compiledDecision,
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
            maximum: Authority.Paper,
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
    cyclic.self = cyclic
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

    const contractFailures = shadowContractFailurePairs.map(
      (pair) => new ShadowDecisionContractFailure({ ...pair, message: 'failure-pair coverage' }),
    )
    expect(shadowContractFailurePairCoverage).toBe(true)
    expect(contractFailures.map(({ operation, reason }) => ({ operation, reason }))).toEqual([
      ...shadowContractFailurePairs,
    ])
  })
})
