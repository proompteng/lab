import { Result } from 'effect'

import { accrueCashYield, calculateSessionFees, makeFillTerms, notionalMicros, type FeeInput } from './execution-model'
import { canonicalHashV1 } from './hash'
import type {
  CashChange,
  CashYieldEvent,
  DailyPositionMark,
  DecisionEvent,
  EquityPoint,
  EvaluationEvent,
  FeeEvent,
  FillEvent,
  MarkedEquityReconciliation,
  SimulatedOrder,
  SimulationTrace,
} from './types'

export const MARKED_EQUITY_TOLERANCE_MICROS = 0n

type UnsignedIntegerEvidence =
  | {
      readonly kind: 'input'
      readonly field: 'evaluatorEndingEquityMicros' | 'evaluatorTotalFeesMicros' | 'initialCapitalMicros'
      readonly value: string
    }
  | {
      readonly kind: 'order'
      readonly orderId: string
      readonly field: 'filledQuantityMicros' | 'requestedQuantityMicros'
      readonly value: string
    }
  | {
      readonly kind: 'fill'
      readonly fillId: string
      readonly field:
        | 'costBasisMicros'
        | 'notionalMicros'
        | 'priceMicros'
        | 'quantityMicros'
        | 'referencePriceMicros'
        | 'slippageCostMicros'
        | 'spreadCostMicros'
      readonly value: string
    }
  | {
      readonly kind: 'fee'
      readonly feeId: string
      readonly field: 'catMicros' | 'commissionMicros' | 'secMicros' | 'tafMicros' | 'totalMicros'
      readonly value: string
    }
  | {
      readonly kind: 'cash-yield'
      readonly cashYieldId: string
      readonly field: 'amountMicros'
      readonly value: string
    }
  | {
      readonly kind: 'daily-mark'
      readonly sessionDate: string
      readonly field:
        | 'cashMicros'
        | 'cashYieldMicros'
        | 'cumulativeCashYieldMicros'
        | 'cumulativeFeesMicros'
        | 'cumulativeSlippageCostMicros'
        | 'cumulativeSpreadCostMicros'
        | 'cumulativeTurnoverMicros'
        | 'equityMicros'
        | 'feeMicros'
        | 'slippageCostMicros'
        | 'spreadCostMicros'
        | 'turnoverMicros'
      readonly value: string
    }
  | {
      readonly kind: 'position'
      readonly sessionDate: string
      readonly symbol: string
      readonly field: 'costBasisMicros' | 'marketValueMicros' | 'priceMicros' | 'quantityMicros'
      readonly value: string
    }

type PositiveUnsignedIntegerEvidence = {
  readonly kind: 'simulation'
  readonly field: 'costMultiplierMicros'
  readonly value: string
}

type SignedIntegerEvidence = {
  readonly kind: 'cash-change'
  readonly cashChangeId: string
  readonly field: 'amountMicros' | 'cashAfterMicros'
  readonly value: string
}

type RunIdentityEvidence = { readonly kind: 'run'; readonly id: string }

type CanonicalIdentityEvidence =
  | { readonly kind: 'decision'; readonly id: string; readonly signalDate: string }
  | { readonly kind: 'order'; readonly id: string; readonly sessionDate: string }
  | { readonly kind: 'fill'; readonly id: string; readonly sessionDate: string }
  | { readonly kind: 'fee'; readonly id: string; readonly sessionDate: string }
  | { readonly kind: 'cash-yield'; readonly id: string; readonly sessionDate: string }
  | { readonly kind: 'cash-change'; readonly id: string; readonly sourceId: string; readonly sessionDate: string }

type IdentityEvidence = RunIdentityEvidence | CanonicalIdentityEvidence

type InvalidIdentityIssue =
  | {
      readonly _tag: 'InvalidIdentity'
      readonly evidence: RunIdentityEvidence
      readonly problem: { readonly _tag: 'InvalidFormat'; readonly expected: 'lowercase-sha256' }
    }
  | {
      readonly _tag: 'InvalidIdentity'
      readonly evidence: CanonicalIdentityEvidence
      readonly problem:
        | { readonly _tag: 'InvalidFormat'; readonly expected: 'lowercase-sha256' }
        | { readonly _tag: 'HashMismatch'; readonly expected: string }
        | { readonly _tag: 'CanonicalizationFailed'; readonly cause: unknown }
    }

type CanonicalIdentityProblem =
  | { readonly _tag: 'HashMismatch'; readonly expected: string }
  | { readonly _tag: 'CanonicalizationFailed'; readonly cause: unknown }

type MissingReferenceProblem =
  | { readonly _tag: 'OrderDecision'; readonly orderId: string; readonly decisionId: string }
  | { readonly _tag: 'FillOrder'; readonly fillId: string; readonly orderId: string }
  | {
      readonly _tag: 'MonetaryEventCashChange'
      readonly eventId: string
      readonly eventKind: FillEvent['kind'] | FeeEvent['kind'] | CashYieldEvent['kind']
    }

type EvidenceMismatchProblem =
  | {
      readonly _tag: 'OrderExecutionSession'
      readonly orderId: string
      readonly decisionId: string
      readonly actualSessionDate: string
      readonly expectedSessionDate: string
    }
  | {
      readonly _tag: 'FillBinding'
      readonly fillId: string
      readonly orderId: string
      readonly field: 'decisionId' | 'sessionDate' | 'side' | 'symbol'
      readonly actual: string
      readonly expected: string
    }
  | {
      readonly _tag: 'FillQuantity'
      readonly fillId: string
      readonly orderId: string
      readonly actualQuantityMicros: string
      readonly expectedQuantityMicros: string
    }
  | {
      readonly _tag: 'FillTerms'
      readonly fillId: string
      readonly field: 'notionalMicros' | 'priceMicros' | 'slippageCostMicros' | 'spreadCostMicros'
      readonly actualMicros: string
      readonly expectedMicros: string
    }
  | {
      readonly _tag: 'FeeComponents'
      readonly feeId: string
      readonly actualTotalMicros: string
      readonly expectedTotalMicros: string
    }
  | {
      readonly _tag: 'FeeSchedule'
      readonly feeId: string
      readonly field: 'catMicros' | 'commissionMicros' | 'secMicros' | 'tafMicros' | 'totalMicros'
      readonly actualMicros: string
      readonly expectedMicros: string
    }
  | {
      readonly _tag: 'CashChange'
      readonly cashChangeId: string
      readonly sourceId: string
      readonly field: 'amountMicros' | 'cashAfterMicros' | 'sessionDate' | 'sourceKind'
      readonly actual: string
      readonly expected: string
    }
  | {
      readonly _tag: 'CashYield'
      readonly cashYieldId: string
      readonly field: 'amountMicros' | 'annualYieldBps'
      readonly actual: string
      readonly expected: string
    }
  | {
      readonly _tag: 'DailyMark'
      readonly sessionDate: string
      readonly field:
        | 'cashYieldMicros'
        | 'cumulativeCashYieldMicros'
        | 'cumulativeFeesMicros'
        | 'cumulativeSlippageCostMicros'
        | 'cumulativeSpreadCostMicros'
        | 'cumulativeTurnoverMicros'
        | 'feeMicros'
        | 'slippageCostMicros'
        | 'spreadCostMicros'
        | 'turnoverMicros'
      readonly actualMicros: string
      readonly expectedMicros: string
    }
  | {
      readonly _tag: 'PositionMark'
      readonly sessionDate: string
      readonly symbol: string
      readonly field: 'marketValueMicros' | 'quantityMicros'
      readonly actualMicros: string
      readonly expectedMicros: string
    }

type InvalidEvidenceStateProblem =
  | {
      readonly _tag: 'DuplicateIdentity'
      readonly entity: 'cash-change' | 'cash-yield' | 'decision' | 'fee' | 'fill' | 'order'
      readonly id: string
    }
  | { readonly _tag: 'DuplicateFillForOrder'; readonly orderId: string; readonly secondFillId: string }
  | { readonly _tag: 'DuplicateCashChangeForEvent'; readonly eventId: string; readonly secondCashChangeId: string }
  | {
      readonly _tag: 'InvalidOrder'
      readonly rule: 'fill-presence' | 'filled-not-over-requested' | 'status-consistency'
      readonly orderId: string
      readonly status: SimulatedOrder['status']
      readonly requestedQuantityMicros: string
      readonly filledQuantityMicros: string
      readonly rejectionReason: SimulatedOrder['rejectionReason']
      readonly unfilledRemainder: SimulatedOrder['unfilledRemainder']
      readonly fillPresent: boolean
    }
  | {
      readonly _tag: 'InvalidMarkOrder'
      readonly previousSessionDate: string
      readonly sessionDate: string
    }
  | { readonly _tag: 'DuplicateMarkedPosition'; readonly sessionDate: string; readonly symbols: readonly string[] }
  | { readonly _tag: 'UnsortedMarkedPositions'; readonly sessionDate: string; readonly symbols: readonly string[] }
  | {
      readonly _tag: 'NegativeCash'
      readonly eventId: string
      readonly actualMicros: string
      readonly minimumMicros: string
    }
  | {
      readonly _tag: 'NegativeLongPosition'
      readonly fillId: string
      readonly symbol: string
      readonly actualQuantityMicros: string
    }
  | {
      readonly _tag: 'DailyOutsideTolerance'
      readonly measure: 'daily-cash' | 'daily-equity'
      readonly sessionDate: string
      readonly differenceMicros: string
      readonly toleranceMicros: string
    }
  | {
      readonly _tag: 'FinalOutsideTolerance'
      readonly measure: 'final-equity' | 'final-fees'
      readonly differenceMicros: string
      readonly toleranceMicros: string
    }
  | { readonly _tag: 'NegativeTolerance'; readonly toleranceMicros: string }
  | {
      readonly _tag: 'UnsupportedSimulationSchema'
      readonly actual: string
      readonly expected: 'bayn.simulation-trace.v3'
    }

type IncompleteEvidenceProblem =
  | { readonly _tag: 'EmptyDailyMarks' }
  | {
      readonly _tag: 'CashChangeCountMismatch'
      readonly cashChangeCount: number
      readonly monetaryEventCount: number
    }
  | {
      readonly _tag: 'MissingSessionMark'
      readonly eventId: string
      readonly eventSessionDate: string
      readonly nextMarkSessionDate: string
    }
  | {
      readonly _tag: 'MissingOpenPositionMark'
      readonly sessionDate: string
      readonly symbol: string
      readonly quantityMicros: string
    }
  | {
      readonly _tag: 'MonetaryEventsAfterFinalMark'
      readonly firstEventId: string
      readonly firstEventSessionDate: string
    }

type FailedComputation =
  | {
      readonly _tag: 'FillTerms'
      readonly fillId: string
      readonly side: FillEvent['side']
      readonly quantityMicros: string
      readonly referencePriceMicros: string
      readonly costMultiplierMicros: string
    }
  | {
      readonly _tag: 'FeeSchedule'
      readonly feeId: string
      readonly fillCount: number
      readonly costMultiplierMicros: string
    }
  | {
      readonly _tag: 'CashYield'
      readonly cashYieldId: string
      readonly cashMicros: string
      readonly elapsedDays: number
      readonly annualYieldBps: number
    }

type InvalidIntegerIssue =
  | {
      readonly _tag: 'InvalidInteger'
      readonly expected: 'unsigned-integer'
      readonly evidence: UnsignedIntegerEvidence
    }
  | {
      readonly _tag: 'InvalidInteger'
      readonly expected: 'positive-unsigned-integer'
      readonly evidence: PositiveUnsignedIntegerEvidence
    }
  | {
      readonly _tag: 'InvalidInteger'
      readonly expected: 'signed-integer'
      readonly evidence: SignedIntegerEvidence
    }

export type SimulationReconciliationIssue =
  | InvalidIntegerIssue
  | InvalidIdentityIssue
  | { readonly _tag: 'MissingReference'; readonly problem: MissingReferenceProblem }
  | { readonly _tag: 'EvidenceMismatch'; readonly problem: EvidenceMismatchProblem }
  | { readonly _tag: 'InvalidEvidenceState'; readonly problem: InvalidEvidenceStateProblem }
  | { readonly _tag: 'IncompleteEvidence'; readonly problem: IncompleteEvidenceProblem }
  | { readonly _tag: 'ComputationFailed'; readonly computation: FailedComputation; readonly cause: unknown }

const renderUnknownCause = (cause: unknown): string => {
  const rendered = Result.try({
    try: () => (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)),
    catch: () => 'unrenderable cause',
  })
  return Result.isSuccess(rendered) ? rendered.success : rendered.failure
}

export const renderSimulationReconciliationIssue = (issue: SimulationReconciliationIssue): string => {
  switch (issue._tag) {
    case 'InvalidInteger':
      return `invalid integer (${issue.expected}): ${JSON.stringify(issue.evidence)}`
    case 'InvalidIdentity': {
      if (issue.problem._tag !== 'CanonicalizationFailed') {
        return `invalid identity: ${JSON.stringify({ evidence: issue.evidence, problem: issue.problem }, null, 0)}`
      }
      return `identity canonicalization failed for ${JSON.stringify(issue.evidence)}: ${renderUnknownCause(issue.problem.cause)}`
    }
    case 'MissingReference':
      return `missing reference: ${JSON.stringify(issue.problem)}`
    case 'EvidenceMismatch':
      return `evidence mismatch: ${JSON.stringify(issue.problem)}`
    case 'InvalidEvidenceState':
      return `invalid evidence state: ${JSON.stringify(issue.problem)}`
    case 'IncompleteEvidence':
      return `incomplete evidence: ${JSON.stringify(issue.problem)}`
    case 'ComputationFailed':
      return `${issue.computation._tag} calculation failed for ${JSON.stringify(issue.computation)}: ${renderUnknownCause(issue.cause)}`
  }
}

export const renderSimulationReconciliationIssues = (issues: readonly SimulationReconciliationIssue[]): string =>
  issues.map(renderSimulationReconciliationIssue).join('; ')

export interface MarkedEquityReconciliationInput {
  readonly runId: string
  readonly initialCapitalMicros: string
  readonly evaluatorTotalFeesMicros: string
  readonly evaluatorEndingEquityMicros: string
  readonly events: readonly EvaluationEvent[]
  readonly simulation: SimulationTrace
  readonly toleranceMicros?: bigint
}

export interface MarkedEquityProof {
  readonly reconciliation: MarkedEquityReconciliation
  readonly equitySeries: readonly EquityPoint[]
}

export type SimulationReconciliationResult = Result.Result<MarkedEquityProof, readonly SimulationReconciliationIssue[]>

type Validation<A> = Result.Result<A, readonly SimulationReconciliationIssue[]>

const freezePublicIssue = (issue: SimulationReconciliationIssue): SimulationReconciliationIssue => {
  switch (issue._tag) {
    case 'InvalidInteger': {
      switch (issue.expected) {
        case 'unsigned-integer':
        case 'positive-unsigned-integer':
        case 'signed-integer':
          return Object.freeze(Object.assign({}, issue, { evidence: Object.freeze({ ...issue.evidence }) }))
      }
    }
    case 'InvalidIdentity': {
      switch (issue.problem._tag) {
        case 'InvalidFormat':
        case 'HashMismatch':
        case 'CanonicalizationFailed':
          return Object.freeze(
            Object.assign({}, issue, {
              evidence: Object.freeze({ ...issue.evidence }),
              problem: Object.freeze({ ...issue.problem }),
            }),
          )
      }
    }
    case 'MissingReference': {
      switch (issue.problem._tag) {
        case 'OrderDecision':
        case 'FillOrder':
        case 'MonetaryEventCashChange':
          return Object.freeze(Object.assign({}, issue, { problem: Object.freeze({ ...issue.problem }) }))
      }
    }
    case 'EvidenceMismatch': {
      switch (issue.problem._tag) {
        case 'OrderExecutionSession':
        case 'FillBinding':
        case 'FillQuantity':
        case 'FillTerms':
        case 'FeeComponents':
        case 'FeeSchedule':
        case 'CashChange':
        case 'CashYield':
        case 'DailyMark':
        case 'PositionMark':
          return Object.freeze(Object.assign({}, issue, { problem: Object.freeze({ ...issue.problem }) }))
      }
    }
    case 'InvalidEvidenceState': {
      switch (issue.problem._tag) {
        case 'DuplicateMarkedPosition':
        case 'UnsortedMarkedPositions':
          return Object.freeze(
            Object.assign({}, issue, {
              problem: Object.freeze({ ...issue.problem, symbols: Object.freeze([...issue.problem.symbols]) }),
            }),
          )
        case 'DuplicateIdentity':
        case 'DuplicateFillForOrder':
        case 'DuplicateCashChangeForEvent':
        case 'InvalidOrder':
        case 'InvalidMarkOrder':
        case 'NegativeCash':
        case 'NegativeLongPosition':
        case 'DailyOutsideTolerance':
        case 'FinalOutsideTolerance':
        case 'NegativeTolerance':
        case 'UnsupportedSimulationSchema':
          return Object.freeze(Object.assign({}, issue, { problem: Object.freeze({ ...issue.problem }) }))
      }
    }
    case 'IncompleteEvidence': {
      switch (issue.problem._tag) {
        case 'EmptyDailyMarks':
        case 'CashChangeCountMismatch':
        case 'MissingSessionMark':
        case 'MissingOpenPositionMark':
        case 'MonetaryEventsAfterFinalMark':
          return Object.freeze(Object.assign({}, issue, { problem: Object.freeze({ ...issue.problem }) }))
      }
    }
    case 'ComputationFailed': {
      switch (issue.computation._tag) {
        case 'FillTerms':
        case 'FeeSchedule':
        case 'CashYield':
          return Object.freeze(Object.assign({}, issue, { computation: Object.freeze({ ...issue.computation }) }))
      }
    }
  }
}

const freezePublicIssues = (
  issues: readonly SimulationReconciliationIssue[],
): readonly SimulationReconciliationIssue[] => Object.freeze(issues.map(freezePublicIssue))

const freezePublicProof = (proof: MarkedEquityProof): MarkedEquityProof =>
  Object.freeze({
    reconciliation: Object.freeze({ ...proof.reconciliation }),
    equitySeries: Object.freeze(proof.equitySeries.map((point) => Object.freeze({ ...point }))),
  })

const failIssues = <A = never>(issues: readonly SimulationReconciliationIssue[]): Validation<A> => Result.fail(issues)

const fail = <A = never>(
  issueOrIssues: SimulationReconciliationIssue | readonly SimulationReconciliationIssue[],
): Validation<A> =>
  failIssues(
    Array.isArray(issueOrIssues)
      ? (issueOrIssues as readonly SimulationReconciliationIssue[])
      : [issueOrIssues as SimulationReconciliationIssue],
  )

const unsigned = (evidence: UnsignedIntegerEvidence): Validation<bigint> =>
  /^\d+$/.test(evidence.value)
    ? Result.succeed(BigInt(evidence.value))
    : fail({ _tag: 'InvalidInteger', expected: 'unsigned-integer', evidence })

const positiveUnsigned = (evidence: PositiveUnsignedIntegerEvidence): Validation<bigint> => {
  if (!/^\d+$/.test(evidence.value)) {
    return fail({ _tag: 'InvalidInteger', expected: 'positive-unsigned-integer', evidence })
  }
  const value = BigInt(evidence.value)
  return value > 0n
    ? Result.succeed(value)
    : fail({ _tag: 'InvalidInteger', expected: 'positive-unsigned-integer', evidence })
}

const signed = (evidence: SignedIntegerEvidence): Validation<bigint> =>
  /^-?\d+$/.test(evidence.value)
    ? Result.succeed(BigInt(evidence.value))
    : fail({ _tag: 'InvalidInteger', expected: 'signed-integer', evidence })

type OrderIntegerField = Extract<UnsignedIntegerEvidence, { readonly kind: 'order' }>['field']
type FillIntegerField = Extract<UnsignedIntegerEvidence, { readonly kind: 'fill' }>['field']
type FeeIntegerField = Extract<UnsignedIntegerEvidence, { readonly kind: 'fee' }>['field']
type MarkIntegerField = Extract<UnsignedIntegerEvidence, { readonly kind: 'daily-mark' }>['field']
type PositionIntegerField = Extract<UnsignedIntegerEvidence, { readonly kind: 'position' }>['field']

const orderUnsigned = (order: SimulatedOrder, field: OrderIntegerField): Validation<bigint> =>
  unsigned({ kind: 'order', orderId: order.id, field, value: order[field] })

const fillUnsigned = (fill: FillEvent, field: FillIntegerField): Validation<bigint> =>
  unsigned({ kind: 'fill', fillId: fill.id, field, value: fill[field] })

const feeUnsigned = (fee: FeeEvent, field: FeeIntegerField): Validation<bigint> =>
  unsigned({ kind: 'fee', feeId: fee.id, field, value: fee[field] })

const markUnsigned = (mark: DailyPositionMark, field: MarkIntegerField): Validation<bigint> =>
  unsigned({ kind: 'daily-mark', sessionDate: mark.sessionDate, field, value: mark[field] })

const positionUnsigned = (
  mark: DailyPositionMark,
  position: DailyPositionMark['positions'][number],
  field: PositionIntegerField,
): Validation<bigint> =>
  unsigned({ kind: 'position', sessionDate: mark.sessionDate, symbol: position.symbol, field, value: position[field] })

const absolute = (value: bigint): bigint => (value < 0n ? -value : value)

const invalidIdentityFormat = (evidence: IdentityEvidence): Validation<never> => {
  if (evidence.kind === 'run') {
    return fail({
      _tag: 'InvalidIdentity',
      evidence,
      problem: { _tag: 'InvalidFormat', expected: 'lowercase-sha256' },
    })
  }
  return fail({
    _tag: 'InvalidIdentity',
    evidence,
    problem: { _tag: 'InvalidFormat', expected: 'lowercase-sha256' },
  })
}

const invalidCanonicalIdentity = (
  evidence: CanonicalIdentityEvidence,
  problem: CanonicalIdentityProblem,
): Validation<never> =>
  fail({
    _tag: 'InvalidIdentity',
    evidence,
    problem,
  })

const validateIdentityFormat = (evidence: IdentityEvidence): Validation<void> =>
  /^[0-9a-f]{64}$/.test(evidence.id) ? Result.succeed(undefined) : invalidIdentityFormat(evidence)

const validateCanonicalIdentity = (evidence: CanonicalIdentityEvidence, material: unknown): Validation<void> => {
  const expectedResult = Result.try({
    try: () => canonicalHashV1(material),
    catch: (cause): readonly SimulationReconciliationIssue[] => [
      {
        _tag: 'InvalidIdentity',
        evidence,
        problem: { _tag: 'CanonicalizationFailed', cause },
      },
    ],
  })
  if (Result.isFailure(expectedResult)) return failIssues(expectedResult.failure)
  return evidence.id === expectedResult.success
    ? Result.succeed(undefined)
    : invalidCanonicalIdentity(evidence, {
        _tag: 'HashMismatch',
        expected: expectedResult.success,
      })
}

type IndexedIdentity = CanonicalIdentityEvidence

const indexUnique = <A extends { readonly id: string }>(
  values: readonly A[],
  entity: Extract<InvalidEvidenceStateProblem, { readonly _tag: 'DuplicateIdentity' }>['entity'],
  evidenceFor: (value: A) => IndexedIdentity,
): Validation<ReadonlyMap<string, A>> => {
  const byId = new Map<string, A>()
  for (const value of values) {
    const identity = evidenceFor(value)
    const format = validateIdentityFormat(identity)
    if (Result.isFailure(format)) return failIssues(format.failure)
    if (byId.has(value.id)) {
      return fail({ _tag: 'InvalidEvidenceState', problem: { _tag: 'DuplicateIdentity', entity, id: value.id } })
    }
    byId.set(value.id, value)
  }
  return Result.succeed(byId)
}

const validateDecisionIdentity = (runId: string, decision: DecisionEvent): Validation<void> => {
  const { id: _, kind: __, ...payload } = decision
  return validateCanonicalIdentity(
    { kind: 'decision', id: decision.id, signalDate: decision.signalDate },
    { runId, kind: 'decision', ...payload },
  )
}

const fillBindingIssue = (
  fill: FillEvent,
  order: SimulatedOrder,
  field: Extract<EvidenceMismatchProblem, { readonly _tag: 'FillBinding' }>['field'],
  actual: string,
  expected: string,
): SimulationReconciliationIssue => ({
  _tag: 'EvidenceMismatch',
  problem: { _tag: 'FillBinding', fillId: fill.id, orderId: order.id, field, actual, expected },
})

interface ValidatedFill {
  readonly kind: 'fill'
  readonly event: FillEvent
  readonly quantityMicros: bigint
  readonly notionalMicros: bigint
  readonly spreadCostMicros: bigint
  readonly slippageCostMicros: bigint
}

const computeFillTerms = (
  fill: FillEvent,
  quantityMicros: bigint,
  referencePriceMicros: bigint,
  simulation: SimulationTrace,
  costMultiplierMicros: bigint,
): Validation<ReturnType<typeof makeFillTerms>> => {
  const computation: FailedComputation = {
    _tag: 'FillTerms',
    fillId: fill.id,
    side: fill.side,
    quantityMicros: quantityMicros.toString(),
    referencePriceMicros: referencePriceMicros.toString(),
    costMultiplierMicros: costMultiplierMicros.toString(),
  }
  return Result.try({
    try: () =>
      makeFillTerms(fill.side, quantityMicros, referencePriceMicros, simulation.executionModel, costMultiplierMicros),
    catch: (cause): readonly SimulationReconciliationIssue[] => [{ _tag: 'ComputationFailed', computation, cause }],
  })
}

const validateFill = (
  runId: string,
  fill: FillEvent,
  order: SimulatedOrder,
  orderQuantityMicros: bigint,
  simulation: SimulationTrace,
  costMultiplierMicros: bigint,
): Validation<ValidatedFill> => {
  const bindingIssues: SimulationReconciliationIssue[] = []
  if (fill.decisionId !== order.decisionId) {
    bindingIssues.push(fillBindingIssue(fill, order, 'decisionId', fill.decisionId, order.decisionId))
  }
  if (fill.sessionDate !== order.sessionDate) {
    bindingIssues.push(fillBindingIssue(fill, order, 'sessionDate', fill.sessionDate, order.sessionDate))
  }
  if (fill.symbol !== order.symbol) {
    bindingIssues.push(fillBindingIssue(fill, order, 'symbol', fill.symbol, order.symbol))
  }
  if (fill.side !== order.side) {
    bindingIssues.push(fillBindingIssue(fill, order, 'side', fill.side, order.side))
  }
  if (bindingIssues.length > 0) return failIssues(bindingIssues)

  const quantity = fillUnsigned(fill, 'quantityMicros')
  if (Result.isFailure(quantity)) return failIssues(quantity.failure)
  if (quantity.success !== orderQuantityMicros) {
    return fail({
      _tag: 'EvidenceMismatch',
      problem: {
        _tag: 'FillQuantity',
        fillId: fill.id,
        orderId: order.id,
        actualQuantityMicros: quantity.success.toString(),
        expectedQuantityMicros: orderQuantityMicros.toString(),
      },
    })
  }

  const referencePrice = fillUnsigned(fill, 'referencePriceMicros')
  if (Result.isFailure(referencePrice)) return failIssues(referencePrice.failure)
  const terms = computeFillTerms(fill, quantity.success, referencePrice.success, simulation, costMultiplierMicros)
  if (Result.isFailure(terms)) return failIssues(terms.failure)

  const termIssues: SimulationReconciliationIssue[] = []
  const termIssue = (
    field: Extract<EvidenceMismatchProblem, { readonly _tag: 'FillTerms' }>['field'],
    actualMicros: bigint,
    expectedMicros: bigint,
  ): void => {
    if (actualMicros !== expectedMicros) {
      termIssues.push({
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'FillTerms',
          fillId: fill.id,
          field,
          actualMicros: actualMicros.toString(),
          expectedMicros: expectedMicros.toString(),
        },
      })
    }
  }
  const price = fillUnsigned(fill, 'priceMicros')
  if (Result.isFailure(price)) return failIssues(price.failure)
  termIssue('priceMicros', price.success, terms.success.fillPriceMicros)
  const notional = fillUnsigned(fill, 'notionalMicros')
  if (Result.isFailure(notional)) return termIssues.length > 0 ? failIssues(termIssues) : failIssues(notional.failure)
  termIssue('notionalMicros', notional.success, terms.success.notionalMicros)
  const spread = fillUnsigned(fill, 'spreadCostMicros')
  if (Result.isFailure(spread)) return termIssues.length > 0 ? failIssues(termIssues) : failIssues(spread.failure)
  termIssue('spreadCostMicros', spread.success, terms.success.spreadCostMicros)
  const slippage = fillUnsigned(fill, 'slippageCostMicros')
  if (Result.isFailure(slippage)) return termIssues.length > 0 ? failIssues(termIssues) : failIssues(slippage.failure)
  termIssue('slippageCostMicros', slippage.success, terms.success.slippageCostMicros)
  if (termIssues.length > 0) return failIssues(termIssues)

  const costBasis = fillUnsigned(fill, 'costBasisMicros')
  if (Result.isFailure(costBasis)) return failIssues(costBasis.failure)
  const { id: _, kind: __, ...payload } = fill
  const identity = validateCanonicalIdentity(
    { kind: 'fill', id: fill.id, sessionDate: fill.sessionDate },
    { runId, kind: 'fill', ...payload },
  )
  if (Result.isFailure(identity)) return failIssues(identity.failure)
  return Result.succeed({
    kind: 'fill',
    event: fill,
    quantityMicros: quantity.success,
    notionalMicros: notional.success,
    spreadCostMicros: spread.success,
    slippageCostMicros: slippage.success,
  })
}

const invalidOrder = (
  order: SimulatedOrder,
  fill: FillEvent | undefined,
  rule: Extract<InvalidEvidenceStateProblem, { readonly _tag: 'InvalidOrder' }>['rule'],
): Validation<never> =>
  fail({
    _tag: 'InvalidEvidenceState',
    problem: {
      _tag: 'InvalidOrder',
      rule,
      orderId: order.id,
      status: order.status,
      requestedQuantityMicros: order.requestedQuantityMicros,
      filledQuantityMicros: order.filledQuantityMicros,
      rejectionReason: order.rejectionReason,
      unfilledRemainder: order.unfilledRemainder,
      fillPresent: fill !== undefined,
    },
  })

const validateOrder = (
  runId: string,
  order: SimulatedOrder,
  fill: FillEvent | undefined,
  decisions: ReadonlyMap<string, DecisionEvent>,
  simulation: SimulationTrace,
  costMultiplierMicros: bigint,
): Validation<ValidatedFill | undefined> => {
  const decision = decisions.get(order.decisionId)
  if (decision === undefined) {
    return fail({
      _tag: 'MissingReference',
      problem: { _tag: 'OrderDecision', orderId: order.id, decisionId: order.decisionId },
    })
  }
  if (decision.executionDate !== order.sessionDate) {
    return fail({
      _tag: 'EvidenceMismatch',
      problem: {
        _tag: 'OrderExecutionSession',
        orderId: order.id,
        decisionId: decision.id,
        actualSessionDate: order.sessionDate,
        expectedSessionDate: decision.executionDate,
      },
    })
  }

  const requested = orderUnsigned(order, 'requestedQuantityMicros')
  if (Result.isFailure(requested)) return failIssues(requested.failure)
  const filled = orderUnsigned(order, 'filledQuantityMicros')
  if (Result.isFailure(filled)) return failIssues(filled.failure)
  if (filled.success > requested.success) return invalidOrder(order, fill, 'filled-not-over-requested')
  if (order.status === 'filled') {
    if (
      requested.success <= 0n ||
      filled.success !== requested.success ||
      order.rejectionReason !== null ||
      order.unfilledRemainder !== 'none'
    ) {
      return invalidOrder(order, fill, 'status-consistency')
    }
  } else if (order.status === 'partially-filled') {
    if (
      filled.success <= 0n ||
      filled.success >= requested.success ||
      order.rejectionReason !== null ||
      order.unfilledRemainder !== 'canceled'
    ) {
      return invalidOrder(order, fill, 'status-consistency')
    }
  } else if (filled.success !== 0n || order.rejectionReason === null || order.unfilledRemainder !== 'canceled') {
    return invalidOrder(order, fill, 'status-consistency')
  }
  if ((fill === undefined) !== (filled.success === 0n)) return invalidOrder(order, fill, 'fill-presence')

  const { id: _, ...payload } = order
  const identity = validateCanonicalIdentity(
    { kind: 'order', id: order.id, sessionDate: order.sessionDate },
    { runId, kind: 'order', ...payload },
  )
  if (Result.isFailure(identity)) return failIssues(identity.failure)
  return fill === undefined
    ? Result.succeed(undefined)
    : validateFill(runId, fill, order, filled.success, simulation, costMultiplierMicros)
}

interface ValidatedFee {
  readonly kind: 'fee'
  readonly event: FeeEvent
  readonly totalMicros: bigint
}

const feeSchedule = (
  fee: FeeEvent,
  inputs: readonly FeeInput[],
  simulation: SimulationTrace,
  costMultiplierMicros: bigint,
): Validation<ReturnType<typeof calculateSessionFees>> => {
  const computation: FailedComputation = {
    _tag: 'FeeSchedule',
    feeId: fee.id,
    fillCount: inputs.length,
    costMultiplierMicros: costMultiplierMicros.toString(),
  }
  return Result.try({
    try: () => calculateSessionFees(inputs, simulation.executionModel, costMultiplierMicros),
    catch: (cause): readonly SimulationReconciliationIssue[] => [{ _tag: 'ComputationFailed', computation, cause }],
  })
}

const validateFee = (
  runId: string,
  fee: FeeEvent,
  sessionFills: readonly ValidatedFill[],
  simulation: SimulationTrace,
  costMultiplierMicros: bigint,
): Validation<ValidatedFee> => {
  const commission = feeUnsigned(fee, 'commissionMicros')
  if (Result.isFailure(commission)) return failIssues(commission.failure)
  const sec = feeUnsigned(fee, 'secMicros')
  if (Result.isFailure(sec)) return failIssues(sec.failure)
  const taf = feeUnsigned(fee, 'tafMicros')
  if (Result.isFailure(taf)) return failIssues(taf.failure)
  const cat = feeUnsigned(fee, 'catMicros')
  if (Result.isFailure(cat)) return failIssues(cat.failure)
  const total = feeUnsigned(fee, 'totalMicros')
  if (Result.isFailure(total)) return failIssues(total.failure)
  const componentTotal = commission.success + sec.success + taf.success + cat.success
  if (componentTotal !== total.success) {
    return fail({
      _tag: 'EvidenceMismatch',
      problem: {
        _tag: 'FeeComponents',
        feeId: fee.id,
        actualTotalMicros: total.success.toString(),
        expectedTotalMicros: componentTotal.toString(),
      },
    })
  }

  const inputs: FeeInput[] = sessionFills.map((fill) => ({
    side: fill.event.side,
    quantityMicros: fill.quantityMicros,
    notionalMicros: fill.notionalMicros,
  }))
  const expected = feeSchedule(fee, inputs, simulation, costMultiplierMicros)
  if (Result.isFailure(expected)) return failIssues(expected.failure)

  const comparisons: readonly [
    Extract<EvidenceMismatchProblem, { readonly _tag: 'FeeSchedule' }>['field'],
    bigint,
    bigint,
  ][] = [
    ['commissionMicros', commission.success, expected.success.commissionMicros],
    ['secMicros', sec.success, expected.success.secMicros],
    ['tafMicros', taf.success, expected.success.tafMicros],
    ['catMicros', cat.success, expected.success.catMicros],
    ['totalMicros', total.success, expected.success.totalMicros],
  ]
  const scheduleIssues: SimulationReconciliationIssue[] = []
  for (const [field, actual, calculated] of comparisons) {
    if (actual !== calculated) {
      scheduleIssues.push({
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'FeeSchedule',
          feeId: fee.id,
          field,
          actualMicros: actual.toString(),
          expectedMicros: calculated.toString(),
        },
      })
    }
  }
  if (scheduleIssues.length > 0) return failIssues(scheduleIssues)
  const { id: _, kind: __, ...payload } = fee
  const identity = validateCanonicalIdentity(
    { kind: 'fee', id: fee.id, sessionDate: fee.sessionDate },
    { runId, kind: 'fee', ...payload },
  )
  if (Result.isFailure(identity)) return failIssues(identity.failure)
  return Result.succeed({
    kind: 'fee',
    event: fee,
    totalMicros: total.success,
  })
}

const validateCashChange = (
  runId: string,
  change: CashChange,
  event: FillEvent | FeeEvent | CashYieldEvent,
  amountMicros: bigint,
  cashAfterMicros: bigint,
): Validation<void> => {
  const mismatch = (
    field: Extract<EvidenceMismatchProblem, { readonly _tag: 'CashChange' }>['field'],
    actual: string,
    expected: string,
  ): SimulationReconciliationIssue => ({
    _tag: 'EvidenceMismatch',
    problem: {
      _tag: 'CashChange',
      cashChangeId: change.id,
      sourceId: event.id,
      field,
      actual,
      expected,
    },
  })
  const bindingIssues: SimulationReconciliationIssue[] = []
  if (change.sourceKind !== event.kind) bindingIssues.push(mismatch('sourceKind', change.sourceKind, event.kind))
  if (change.sessionDate !== event.sessionDate) {
    bindingIssues.push(mismatch('sessionDate', change.sessionDate, event.sessionDate))
  }
  if (bindingIssues.length > 0) return failIssues(bindingIssues)
  const amount = signed({
    kind: 'cash-change',
    cashChangeId: change.id,
    field: 'amountMicros',
    value: change.amountMicros,
  })
  if (Result.isFailure(amount)) return failIssues(amount.failure)
  const valueIssues: SimulationReconciliationIssue[] = []
  if (amount.success !== amountMicros) {
    valueIssues.push(mismatch('amountMicros', amount.success.toString(), amountMicros.toString()))
  }
  const cashAfter = signed({
    kind: 'cash-change',
    cashChangeId: change.id,
    field: 'cashAfterMicros',
    value: change.cashAfterMicros,
  })
  if (Result.isFailure(cashAfter)) {
    return valueIssues.length > 0 ? failIssues(valueIssues) : Result.fail(cashAfter.failure)
  }
  if (cashAfter.success !== cashAfterMicros) {
    valueIssues.push(mismatch('cashAfterMicros', cashAfter.success.toString(), cashAfterMicros.toString()))
  }
  if (valueIssues.length > 0) return failIssues(valueIssues)
  const { id: _, ...payload } = change
  return validateCanonicalIdentity(
    { kind: 'cash-change', id: change.id, sourceId: change.sourceId, sessionDate: change.sessionDate },
    { runId, kind: 'cash-change', ...payload },
  )
}

const validateMarks = (marks: readonly DailyPositionMark[]): Validation<void> => {
  if (marks.length === 0) return fail({ _tag: 'IncompleteEvidence', problem: { _tag: 'EmptyDailyMarks' } })
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index]
    const previous = marks[index - 1]
    if (previous !== undefined && previous.sessionDate >= mark.sessionDate) {
      return fail({
        _tag: 'InvalidEvidenceState',
        problem: {
          _tag: 'InvalidMarkOrder',
          previousSessionDate: previous.sessionDate,
          sessionDate: mark.sessionDate,
        },
      })
    }
    const symbols = mark.positions.map((position) => position.symbol)
    if (new Set(symbols).size !== symbols.length) {
      return fail({
        _tag: 'InvalidEvidenceState',
        problem: { _tag: 'DuplicateMarkedPosition', sessionDate: mark.sessionDate, symbols },
      })
    }
    if (symbols.some((symbol, symbolIndex) => symbolIndex > 0 && symbols[symbolIndex - 1] >= symbol)) {
      return fail({
        _tag: 'InvalidEvidenceState',
        problem: { _tag: 'UnsortedMarkedPositions', sessionDate: mark.sessionDate, symbols },
      })
    }
  }
  return Result.succeed(undefined)
}

interface PreparedReconciliation {
  readonly input: MarkedEquityReconciliationInput
  readonly toleranceMicros: bigint
  readonly monetaryEvents: readonly PreparedMonetaryEvent[]
}

const validateDecisions = (
  runId: string,
  events: readonly EvaluationEvent[],
): Validation<ReadonlyMap<string, DecisionEvent>> => {
  const decisionValues = events.filter((event): event is DecisionEvent => event.kind === 'decision')
  const decisions = indexUnique(decisionValues, 'decision', (decision) => ({
    kind: 'decision',
    id: decision.id,
    signalDate: decision.signalDate,
  }))
  if (Result.isFailure(decisions)) return failIssues(decisions.failure)
  for (const decision of decisions.success.values()) {
    const identity = validateDecisionIdentity(runId, decision)
    if (Result.isFailure(identity)) return failIssues(identity.failure)
  }
  return decisions
}

const validateOrdersAndFills = (
  runId: string,
  events: readonly EvaluationEvent[],
  simulation: SimulationTrace,
  decisions: ReadonlyMap<string, DecisionEvent>,
  costMultiplierMicros: bigint,
): Validation<readonly ValidatedFill[]> => {
  const fills = events.filter((event): event is FillEvent => event.kind === 'fill')
  const indexedFills = indexUnique(fills, 'fill', (fill) => ({
    kind: 'fill',
    id: fill.id,
    sessionDate: fill.sessionDate,
  }))
  if (Result.isFailure(indexedFills)) return failIssues(indexedFills.failure)
  const fillsByOrder = new Map<string, { readonly event: FillEvent; readonly eventIndex: number }>()
  for (let eventIndex = 0; eventIndex < fills.length; eventIndex += 1) {
    const fill = fills[eventIndex]
    if (fillsByOrder.has(fill.orderId)) {
      return fail({
        _tag: 'InvalidEvidenceState',
        problem: { _tag: 'DuplicateFillForOrder', orderId: fill.orderId, secondFillId: fill.id },
      })
    }
    fillsByOrder.set(fill.orderId, { event: fill, eventIndex })
  }

  const orders = indexUnique(simulation.orders, 'order', (order) => ({
    kind: 'order',
    id: order.id,
    sessionDate: order.sessionDate,
  }))
  if (Result.isFailure(orders)) return failIssues(orders.failure)
  const preparedFills: { readonly eventIndex: number; readonly fill: ValidatedFill }[] = []
  for (const order of orders.success.values()) {
    const indexedFill = fillsByOrder.get(order.id)
    const valid = validateOrder(runId, order, indexedFill?.event, decisions, simulation, costMultiplierMicros)
    if (Result.isFailure(valid)) return failIssues(valid.failure)
    if (valid.success !== undefined && indexedFill !== undefined) {
      preparedFills.push({ eventIndex: indexedFill.eventIndex, fill: valid.success })
    }
  }
  for (const fill of fills) {
    if (!orders.success.has(fill.orderId)) {
      return fail({
        _tag: 'MissingReference',
        problem: { _tag: 'FillOrder', fillId: fill.id, orderId: fill.orderId },
      })
    }
  }
  preparedFills.sort((left, right) => left.eventIndex - right.eventIndex)
  return Result.succeed(preparedFills.map(({ fill }) => fill))
}

const validateFeesAndYields = (
  runId: string,
  events: readonly EvaluationEvent[],
  fills: readonly ValidatedFill[],
  simulation: SimulationTrace,
  costMultiplierMicros: bigint,
): Validation<readonly ValidatedFee[]> => {
  const fees = events.filter((event): event is FeeEvent => event.kind === 'fee')
  const indexedFees = indexUnique(fees, 'fee', (fee) => ({
    kind: 'fee',
    id: fee.id,
    sessionDate: fee.sessionDate,
  }))
  if (Result.isFailure(indexedFees)) return failIssues(indexedFees.failure)
  const cashYields = events.filter((event): event is CashYieldEvent => event.kind === 'cash-yield')
  const indexedCashYields = indexUnique(cashYields, 'cash-yield', (event) => ({
    kind: 'cash-yield',
    id: event.id,
    sessionDate: event.sessionDate,
  }))
  if (Result.isFailure(indexedCashYields)) return failIssues(indexedCashYields.failure)
  const fillsBySession = new Map<string, ValidatedFill[]>()
  for (const fill of fills) {
    const sessionFills = fillsBySession.get(fill.event.sessionDate)
    if (sessionFills === undefined) {
      fillsBySession.set(fill.event.sessionDate, [fill])
    } else {
      sessionFills.push(fill)
    }
  }
  const preparedFees: ValidatedFee[] = []
  for (const fee of fees) {
    const valid = validateFee(runId, fee, fillsBySession.get(fee.sessionDate) ?? [], simulation, costMultiplierMicros)
    if (Result.isFailure(valid)) return failIssues(valid.failure)
    preparedFees.push(valid.success)
  }
  return Result.succeed(preparedFees)
}

interface PreparedFill extends ValidatedFill {
  readonly cashChange: CashChange
}

interface PreparedFee extends ValidatedFee {
  readonly cashChange: CashChange
}

interface PreparedCashYield {
  readonly kind: 'cash-yield'
  readonly event: CashYieldEvent
  readonly cashChange: CashChange
}

type PreparedMonetaryEvent = PreparedFill | PreparedFee | PreparedCashYield

interface MonetaryEvidence {
  readonly events: readonly PreparedMonetaryEvent[]
}

const validateMonetaryEvidence = (
  events: readonly EvaluationEvent[],
  cashChanges: readonly CashChange[],
  fills: readonly ValidatedFill[],
  fees: readonly ValidatedFee[],
): Validation<MonetaryEvidence> => {
  const sourceEvents = events.filter(
    (event): event is FillEvent | FeeEvent | CashYieldEvent => event.kind !== 'decision',
  )
  const changes = indexUnique(cashChanges, 'cash-change', (change) => ({
    kind: 'cash-change',
    id: change.id,
    sourceId: change.sourceId,
    sessionDate: change.sessionDate,
  }))
  if (Result.isFailure(changes)) return failIssues(changes.failure)
  const cashChangesBySource = new Map<string, CashChange>()
  for (const change of changes.success.values()) {
    if (cashChangesBySource.has(change.sourceId)) {
      return fail({
        _tag: 'InvalidEvidenceState',
        problem: {
          _tag: 'DuplicateCashChangeForEvent',
          eventId: change.sourceId,
          secondCashChangeId: change.id,
        },
      })
    }
    cashChangesBySource.set(change.sourceId, change)
  }
  if (changes.success.size !== sourceEvents.length) {
    return fail({
      _tag: 'IncompleteEvidence',
      problem: {
        _tag: 'CashChangeCountMismatch',
        cashChangeCount: changes.success.size,
        monetaryEventCount: sourceEvents.length,
      },
    })
  }
  const monetaryEvents: PreparedMonetaryEvent[] = []
  let fillIndex = 0
  let feeIndex = 0
  for (const event of sourceEvents) {
    const cashChange = cashChangesBySource.get(event.id)
    if (cashChange === undefined) {
      return fail({
        _tag: 'MissingReference',
        problem: { _tag: 'MonetaryEventCashChange', eventId: event.id, eventKind: event.kind },
      })
    }
    if (event.kind === 'cash-yield') {
      monetaryEvents.push({ kind: 'cash-yield', event, cashChange })
      continue
    }
    if (event.kind === 'fill') {
      monetaryEvents.push({ ...fills[fillIndex], cashChange })
      fillIndex += 1
    } else {
      monetaryEvents.push({ ...fees[feeIndex], cashChange })
      feeIndex += 1
    }
  }
  return Result.succeed({ events: monetaryEvents })
}

const prepareReconciliation = (input: MarkedEquityReconciliationInput): Validation<PreparedReconciliation> => {
  const toleranceMicros = input.toleranceMicros ?? MARKED_EQUITY_TOLERANCE_MICROS
  if (toleranceMicros < 0n) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: { _tag: 'NegativeTolerance', toleranceMicros: toleranceMicros.toString() },
    })
  }
  const runIdentity = validateIdentityFormat({ kind: 'run', id: input.runId })
  if (Result.isFailure(runIdentity)) return failIssues(runIdentity.failure)
  if (input.simulation.schemaVersion !== 'bayn.simulation-trace.v3') {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'UnsupportedSimulationSchema',
        actual: input.simulation.schemaVersion,
        expected: 'bayn.simulation-trace.v3',
      },
    })
  }
  const costMultiplierMicros = positiveUnsigned({
    kind: 'simulation',
    field: 'costMultiplierMicros',
    value: input.simulation.costMultiplierMicros,
  })
  if (Result.isFailure(costMultiplierMicros)) return failIssues(costMultiplierMicros.failure)
  const decisions = validateDecisions(input.runId, input.events)
  if (Result.isFailure(decisions)) return failIssues(decisions.failure)
  const fills = validateOrdersAndFills(
    input.runId,
    input.events,
    input.simulation,
    decisions.success,
    costMultiplierMicros.success,
  )
  if (Result.isFailure(fills)) return failIssues(fills.failure)
  const fees = validateFeesAndYields(
    input.runId,
    input.events,
    fills.success,
    input.simulation,
    costMultiplierMicros.success,
  )
  if (Result.isFailure(fees)) return failIssues(fees.failure)
  const monetaryEvidence = validateMonetaryEvidence(
    input.events,
    input.simulation.cashChanges,
    fills.success,
    fees.success,
  )
  if (Result.isFailure(monetaryEvidence)) return failIssues(monetaryEvidence.failure)
  const marks = validateMarks(input.simulation.dailyMarks)
  if (Result.isFailure(marks)) return failIssues(marks.failure)

  return Result.succeed({
    input,
    toleranceMicros,
    monetaryEvents: monetaryEvidence.success.events,
  })
}

interface MutableReconstructionState {
  cashMicros: bigint
  readonly quantities: Map<string, bigint>
  eventIndex: number
  reconstructedTotalFeesMicros: bigint
  cumulativeTurnoverMicros: bigint
  cumulativeSpreadMicros: bigint
  cumulativeSlippageMicros: bigint
  cumulativeCashYieldMicros: bigint
  maximumDifferenceMicros: bigint
  finalPositionValueMicros: bigint
  readonly equitySeries: EquityPoint[]
}

interface EventTransition {
  readonly amountMicros: bigint
  readonly quantityChange?: { readonly symbol: string; readonly quantityMicros: bigint }
  readonly feeMicros: bigint
  readonly turnoverMicros: bigint
  readonly spreadMicros: bigint
  readonly slippageMicros: bigint
  readonly cashYieldMicros: bigint
}

const fillTransition = (state: MutableReconstructionState, fill: PreparedFill): Validation<EventTransition> => {
  const event = fill.event
  const current = state.quantities.get(event.symbol) ?? 0n
  const next = event.side === 'buy' ? current + fill.quantityMicros : current - fill.quantityMicros
  if (next < 0n) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'NegativeLongPosition',
        fillId: event.id,
        symbol: event.symbol,
        actualQuantityMicros: next.toString(),
      },
    })
  }
  return Result.succeed({
    amountMicros: event.side === 'buy' ? -fill.notionalMicros : fill.notionalMicros,
    quantityChange: { symbol: event.symbol, quantityMicros: next },
    feeMicros: 0n,
    turnoverMicros: fill.notionalMicros,
    spreadMicros: fill.spreadCostMicros,
    slippageMicros: fill.slippageCostMicros,
    cashYieldMicros: 0n,
  })
}

const feeTransition = (fee: PreparedFee): EventTransition => ({
  amountMicros: -fee.totalMicros,
  feeMicros: fee.totalMicros,
  turnoverMicros: 0n,
  spreadMicros: 0n,
  slippageMicros: 0n,
  cashYieldMicros: 0n,
})

const cashYieldTransition = (
  runId: string,
  cashMicros: bigint,
  event: CashYieldEvent,
  simulation: SimulationTrace,
): Validation<EventTransition> => {
  if (event.annualYieldBps !== simulation.executionModel.cash.annualYieldBps) {
    return fail({
      _tag: 'EvidenceMismatch',
      problem: {
        _tag: 'CashYield',
        cashYieldId: event.id,
        field: 'annualYieldBps',
        actual: String(event.annualYieldBps),
        expected: String(simulation.executionModel.cash.annualYieldBps),
      },
    })
  }
  const computation: FailedComputation = {
    _tag: 'CashYield',
    cashYieldId: event.id,
    cashMicros: cashMicros.toString(),
    elapsedDays: event.elapsedDays,
    annualYieldBps: simulation.executionModel.cash.annualYieldBps,
  }
  const expected = Result.try({
    try: () => accrueCashYield(cashMicros, event.elapsedDays, simulation.executionModel),
    catch: (cause): readonly SimulationReconciliationIssue[] => [{ _tag: 'ComputationFailed', computation, cause }],
  })
  if (Result.isFailure(expected)) return failIssues(expected.failure)
  const amount = unsigned({
    kind: 'cash-yield',
    cashYieldId: event.id,
    field: 'amountMicros',
    value: event.amountMicros,
  })
  if (Result.isFailure(amount)) return failIssues(amount.failure)
  if (amount.success !== expected.success) {
    return fail({
      _tag: 'EvidenceMismatch',
      problem: {
        _tag: 'CashYield',
        cashYieldId: event.id,
        field: 'amountMicros',
        actual: amount.success.toString(),
        expected: expected.success.toString(),
      },
    })
  }
  const { id: _, kind: __, ...payload } = event
  const identity = validateCanonicalIdentity(
    { kind: 'cash-yield', id: event.id, sessionDate: event.sessionDate },
    { runId, kind: 'cash-yield', ...payload },
  )
  if (Result.isFailure(identity)) return failIssues(identity.failure)
  return Result.succeed({
    amountMicros: expected.success,
    feeMicros: 0n,
    turnoverMicros: 0n,
    spreadMicros: 0n,
    slippageMicros: 0n,
    cashYieldMicros: expected.success,
  })
}

const eventTransition = (
  prepared: PreparedReconciliation,
  state: MutableReconstructionState,
  preparedEvent: PreparedMonetaryEvent,
): Validation<EventTransition> => {
  switch (preparedEvent.kind) {
    case 'fill':
      return fillTransition(state, preparedEvent)
    case 'fee':
      return Result.succeed(feeTransition(preparedEvent))
    case 'cash-yield':
      return cashYieldTransition(prepared.input.runId, state.cashMicros, preparedEvent.event, prepared.input.simulation)
  }
}

const applyEvent = (
  prepared: PreparedReconciliation,
  state: MutableReconstructionState,
  preparedEvent: PreparedMonetaryEvent,
): Validation<void> => {
  const event = preparedEvent.event
  const transition = eventTransition(prepared, state, preparedEvent)
  if (Result.isFailure(transition)) return failIssues(transition.failure)
  const cashMicros = state.cashMicros + transition.success.amountMicros
  if (cashMicros < -prepared.toleranceMicros) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'NegativeCash',
        eventId: event.id,
        actualMicros: cashMicros.toString(),
        minimumMicros: (-prepared.toleranceMicros).toString(),
      },
    })
  }
  const validChange = validateCashChange(
    prepared.input.runId,
    preparedEvent.cashChange,
    event,
    transition.success.amountMicros,
    cashMicros,
  )
  if (Result.isFailure(validChange)) return failIssues(validChange.failure)
  const quantityChange = transition.success.quantityChange
  if (quantityChange !== undefined) {
    if (quantityChange.quantityMicros === 0n) {
      state.quantities.delete(quantityChange.symbol)
    } else {
      state.quantities.set(quantityChange.symbol, quantityChange.quantityMicros)
    }
  }
  state.cashMicros = cashMicros
  state.eventIndex += 1
  state.reconstructedTotalFeesMicros += transition.success.feeMicros
  state.cumulativeTurnoverMicros += transition.success.turnoverMicros
  state.cumulativeSpreadMicros += transition.success.spreadMicros
  state.cumulativeSlippageMicros += transition.success.slippageMicros
  state.cumulativeCashYieldMicros += transition.success.cashYieldMicros
  return Result.succeed(undefined)
}

interface MarkBaselines {
  readonly turnoverMicros: bigint
  readonly feeMicros: bigint
  readonly spreadMicros: bigint
  readonly slippageMicros: bigint
  readonly cashYieldMicros: bigint
}

const validateDailyMarkCounters = (
  mark: DailyPositionMark,
  state: MutableReconstructionState,
  baselines: MarkBaselines,
): Validation<void> => {
  const checks: readonly [Extract<EvidenceMismatchProblem, { readonly _tag: 'DailyMark' }>['field'], bigint][] = [
    ['turnoverMicros', state.cumulativeTurnoverMicros - baselines.turnoverMicros],
    ['cumulativeTurnoverMicros', state.cumulativeTurnoverMicros],
    ['feeMicros', state.reconstructedTotalFeesMicros - baselines.feeMicros],
    ['cumulativeFeesMicros', state.reconstructedTotalFeesMicros],
    ['spreadCostMicros', state.cumulativeSpreadMicros - baselines.spreadMicros],
    ['cumulativeSpreadCostMicros', state.cumulativeSpreadMicros],
    ['slippageCostMicros', state.cumulativeSlippageMicros - baselines.slippageMicros],
    ['cumulativeSlippageCostMicros', state.cumulativeSlippageMicros],
    ['cashYieldMicros', state.cumulativeCashYieldMicros - baselines.cashYieldMicros],
    ['cumulativeCashYieldMicros', state.cumulativeCashYieldMicros],
  ]
  const counterIssues: SimulationReconciliationIssue[] = []
  for (const [field, expected] of checks) {
    const actual = markUnsigned(mark, field)
    if (Result.isFailure(actual)) {
      return counterIssues.length > 0 ? failIssues(counterIssues) : Result.fail(actual.failure)
    }
    if (actual.success !== expected) {
      counterIssues.push({
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'DailyMark',
          sessionDate: mark.sessionDate,
          field,
          actualMicros: actual.success.toString(),
          expectedMicros: expected.toString(),
        },
      })
    }
  }
  return counterIssues.length > 0 ? failIssues(counterIssues) : Result.succeed(undefined)
}

const valueMarkedPositions = (state: MutableReconstructionState, mark: DailyPositionMark): Validation<bigint> => {
  let reconstructedPositionValueMicros = 0n
  const markedSymbols = new Set<string>()
  for (const position of mark.positions) {
    markedSymbols.add(position.symbol)
    const price = positionUnsigned(mark, position, 'priceMicros')
    if (Result.isFailure(price)) return failIssues(price.failure)
    const quantity = state.quantities.get(position.symbol) ?? 0n
    const markedQuantity = positionUnsigned(mark, position, 'quantityMicros')
    if (Result.isFailure(markedQuantity)) return failIssues(markedQuantity.failure)
    const positionIssues: SimulationReconciliationIssue[] = []
    if (markedQuantity.success !== quantity) {
      positionIssues.push({
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'PositionMark',
          sessionDate: mark.sessionDate,
          symbol: position.symbol,
          field: 'quantityMicros',
          actualMicros: markedQuantity.success.toString(),
          expectedMicros: quantity.toString(),
        },
      })
    }
    const costBasis = positionUnsigned(mark, position, 'costBasisMicros')
    if (Result.isFailure(costBasis)) {
      return positionIssues.length > 0 ? failIssues(positionIssues) : Result.fail(costBasis.failure)
    }
    // Both operands are parsed unsigned integers and notionalMicros divides by the fixed non-zero MICROS constant.
    const reconstructedValue = notionalMicros(quantity, price.success)
    reconstructedPositionValueMicros += reconstructedValue
    const marketValue = positionUnsigned(mark, position, 'marketValueMicros')
    if (Result.isFailure(marketValue)) {
      return positionIssues.length > 0 ? failIssues(positionIssues) : Result.fail(marketValue.failure)
    }
    if (marketValue.success !== reconstructedValue) {
      positionIssues.push({
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'PositionMark',
          sessionDate: mark.sessionDate,
          symbol: position.symbol,
          field: 'marketValueMicros',
          actualMicros: marketValue.success.toString(),
          expectedMicros: reconstructedValue.toString(),
        },
      })
    }
    if (positionIssues.length > 0) return failIssues(positionIssues)
  }
  for (const [symbol, quantityMicros] of state.quantities) {
    if (!markedSymbols.has(symbol)) {
      return fail({
        _tag: 'IncompleteEvidence',
        problem: {
          _tag: 'MissingOpenPositionMark',
          sessionDate: mark.sessionDate,
          symbol,
          quantityMicros: quantityMicros.toString(),
        },
      })
    }
  }
  return Result.succeed(reconstructedPositionValueMicros)
}

const reconcileDailyMark = (
  prepared: PreparedReconciliation,
  state: MutableReconstructionState,
  mark: DailyPositionMark,
): Validation<void> => {
  const baselines: MarkBaselines = {
    turnoverMicros: state.cumulativeTurnoverMicros,
    feeMicros: state.reconstructedTotalFeesMicros,
    spreadMicros: state.cumulativeSpreadMicros,
    slippageMicros: state.cumulativeSlippageMicros,
    cashYieldMicros: state.cumulativeCashYieldMicros,
  }
  while (
    state.eventIndex < prepared.monetaryEvents.length &&
    prepared.monetaryEvents[state.eventIndex].event.sessionDate <= mark.sessionDate
  ) {
    const preparedEvent = prepared.monetaryEvents[state.eventIndex]
    const event = preparedEvent.event
    if (event.sessionDate !== mark.sessionDate) {
      return fail({
        _tag: 'IncompleteEvidence',
        problem: {
          _tag: 'MissingSessionMark',
          eventId: event.id,
          eventSessionDate: event.sessionDate,
          nextMarkSessionDate: mark.sessionDate,
        },
      })
    }
    const applied = applyEvent(prepared, state, preparedEvent)
    if (Result.isFailure(applied)) return failIssues(applied.failure)
  }

  const counters = validateDailyMarkCounters(mark, state, baselines)
  if (Result.isFailure(counters)) return failIssues(counters.failure)
  const markCash = markUnsigned(mark, 'cashMicros')
  if (Result.isFailure(markCash)) return failIssues(markCash.failure)
  const cashDifference = absolute(markCash.success - state.cashMicros)
  if (cashDifference > prepared.toleranceMicros) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'DailyOutsideTolerance',
        measure: 'daily-cash',
        sessionDate: mark.sessionDate,
        differenceMicros: cashDifference.toString(),
        toleranceMicros: prepared.toleranceMicros.toString(),
      },
    })
  }
  const positionValue = valueMarkedPositions(state, mark)
  if (Result.isFailure(positionValue)) return failIssues(positionValue.failure)
  const reconstructedEquityMicros = state.cashMicros + positionValue.success
  const evaluatorEquity = markUnsigned(mark, 'equityMicros')
  if (Result.isFailure(evaluatorEquity)) return failIssues(evaluatorEquity.failure)
  const equityDifference = absolute(reconstructedEquityMicros - evaluatorEquity.success)
  if (equityDifference > prepared.toleranceMicros) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'DailyOutsideTolerance',
        measure: 'daily-equity',
        sessionDate: mark.sessionDate,
        differenceMicros: equityDifference.toString(),
        toleranceMicros: prepared.toleranceMicros.toString(),
      },
    })
  }
  state.maximumDifferenceMicros =
    state.maximumDifferenceMicros > equityDifference ? state.maximumDifferenceMicros : equityDifference
  state.finalPositionValueMicros = positionValue.success
  state.equitySeries.push({
    sessionDate: mark.sessionDate,
    evaluatorEquityMicros: evaluatorEquity.success.toString(),
    reconstructedEquityMicros: reconstructedEquityMicros.toString(),
    differenceMicros: equityDifference.toString(),
  })
  return Result.succeed(undefined)
}

const reconstructMarkedEquity = (prepared: PreparedReconciliation): Validation<MarkedEquityProof> => {
  const initialCapital = unsigned({
    kind: 'input',
    field: 'initialCapitalMicros',
    value: prepared.input.initialCapitalMicros,
  })
  if (Result.isFailure(initialCapital)) return failIssues(initialCapital.failure)
  const state: MutableReconstructionState = {
    cashMicros: initialCapital.success,
    quantities: new Map(),
    eventIndex: 0,
    reconstructedTotalFeesMicros: 0n,
    cumulativeTurnoverMicros: 0n,
    cumulativeSpreadMicros: 0n,
    cumulativeSlippageMicros: 0n,
    cumulativeCashYieldMicros: 0n,
    maximumDifferenceMicros: 0n,
    finalPositionValueMicros: 0n,
    equitySeries: [],
  }
  for (const mark of prepared.input.simulation.dailyMarks) {
    const reconciled = reconcileDailyMark(prepared, state, mark)
    if (Result.isFailure(reconciled)) return failIssues(reconciled.failure)
  }
  if (state.eventIndex !== prepared.monetaryEvents.length) {
    const firstEvent = prepared.monetaryEvents[state.eventIndex].event
    return fail({
      _tag: 'IncompleteEvidence',
      problem: {
        _tag: 'MonetaryEventsAfterFinalMark',
        firstEventId: firstEvent.id,
        firstEventSessionDate: firstEvent.sessionDate,
      },
    })
  }

  const evaluatorEnding = unsigned({
    kind: 'input',
    field: 'evaluatorEndingEquityMicros',
    value: prepared.input.evaluatorEndingEquityMicros,
  })
  if (Result.isFailure(evaluatorEnding)) return failIssues(evaluatorEnding.failure)
  const evaluatorTotalFees = unsigned({
    kind: 'input',
    field: 'evaluatorTotalFeesMicros',
    value: prepared.input.evaluatorTotalFeesMicros,
  })
  if (Result.isFailure(evaluatorTotalFees)) return failIssues(evaluatorTotalFees.failure)
  const feeDifferenceMicros = absolute(state.reconstructedTotalFeesMicros - evaluatorTotalFees.success)
  if (feeDifferenceMicros > prepared.toleranceMicros) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'FinalOutsideTolerance',
        measure: 'final-fees',
        differenceMicros: feeDifferenceMicros.toString(),
        toleranceMicros: prepared.toleranceMicros.toString(),
      },
    })
  }
  const reconstructedEndingEquityMicros = state.cashMicros + state.finalPositionValueMicros
  const finalDifferenceMicros = absolute(reconstructedEndingEquityMicros - evaluatorEnding.success)
  if (finalDifferenceMicros > prepared.toleranceMicros) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'FinalOutsideTolerance',
        measure: 'final-equity',
        differenceMicros: finalDifferenceMicros.toString(),
        toleranceMicros: prepared.toleranceMicros.toString(),
      },
    })
  }
  const maximumDifferenceMicros =
    state.maximumDifferenceMicros > finalDifferenceMicros ? state.maximumDifferenceMicros : finalDifferenceMicros
  return Result.succeed({
    reconciliation: {
      schemaVersion: 'bayn.marked-equity-reconciliation.v2',
      runId: prepared.input.runId,
      toleranceMicros: prepared.toleranceMicros.toString(),
      maximumDailyDifferenceMicros: maximumDifferenceMicros.toString(),
      reconstructedCashMicros: state.cashMicros.toString(),
      reconstructedPositionValueMicros: state.finalPositionValueMicros.toString(),
      evaluatorTotalFeesMicros: evaluatorTotalFees.success.toString(),
      reconstructedTotalFeesMicros: state.reconstructedTotalFeesMicros.toString(),
      feeDifferenceMicros: feeDifferenceMicros.toString(),
      evaluatorEndingEquityMicros: evaluatorEnding.success.toString(),
      reconstructedEndingEquityMicros: reconstructedEndingEquityMicros.toString(),
      differenceMicros: finalDifferenceMicros.toString(),
      exact: maximumDifferenceMicros === 0n && feeDifferenceMicros === 0n,
      withinTolerance: true,
    },
    equitySeries: state.equitySeries,
  })
}

const runReconciliation = (input: MarkedEquityReconciliationInput): Validation<MarkedEquityProof> => {
  const prepared = prepareReconciliation(input)
  return Result.isFailure(prepared) ? failIssues(prepared.failure) : reconstructMarkedEquity(prepared.success)
}

export const reconcileMarkedEquity = (input: MarkedEquityReconciliationInput): SimulationReconciliationResult => {
  const result = runReconciliation(input)
  return Result.isFailure(result)
    ? Result.fail(freezePublicIssues(result.failure))
    : Result.succeed(freezePublicProof(result.success))
}
