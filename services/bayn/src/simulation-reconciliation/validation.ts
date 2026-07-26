import { Chunk, pipe, Result } from 'effect'

import {
  calculateSessionFees,
  makeFillTerms,
  type FeeBreakdown,
  type FeeInput,
  type FillTerms,
} from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import type {
  CashChange,
  CashYieldEvent,
  DailyPositionMark,
  DecisionEvent,
  EvaluationEvent,
  FeeEvent,
  FillEvent,
  SimulatedOrder,
  SimulationTrace,
} from '../types'
import {
  MARKED_EQUITY_TOLERANCE_MICROS,
  type CanonicalIdentityEvidence,
  type CanonicalIdentityProblem,
  type EvidenceMismatchProblem,
  type FailedComputation,
  type IdentityEvidence,
  type InvalidEvidenceStateProblem,
  type MarkedEquityReconciliationInput,
  type PositiveUnsignedIntegerEvidence,
  type SignedIntegerEvidence,
  type SimulationReconciliationIssue,
  type UnsignedIntegerEvidence,
  type Validation,
} from './model'

export const failIssues = <A = never>(issues: readonly SimulationReconciliationIssue[]): Validation<A> =>
  Result.fail(issues)

export const fail = <A = never>(
  issueOrIssues: SimulationReconciliationIssue | readonly SimulationReconciliationIssue[],
): Validation<A> =>
  failIssues(
    Array.isArray(issueOrIssues)
      ? (issueOrIssues as readonly SimulationReconciliationIssue[])
      : [issueOrIssues as SimulationReconciliationIssue],
  )

export const unsigned = (evidence: UnsignedIntegerEvidence): Validation<bigint> =>
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

export const markUnsigned = (mark: DailyPositionMark, field: MarkIntegerField): Validation<bigint> =>
  unsigned({ kind: 'daily-mark', sessionDate: mark.sessionDate, field, value: mark[field] })

export const positionUnsigned = (
  mark: DailyPositionMark,
  position: DailyPositionMark['positions'][number],
  field: PositionIntegerField,
): Validation<bigint> =>
  unsigned({ kind: 'position', sessionDate: mark.sessionDate, symbol: position.symbol, field, value: position[field] })

export const absolute = (value: bigint): bigint => (value < 0n ? -value : value)

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

export const validateCanonicalIdentity = (evidence: CanonicalIdentityEvidence, material: unknown): Validation<void> => {
  const expectedResult = Result.mapError(
    canonicalHashV1Result(material),
    (cause): readonly SimulationReconciliationIssue[] => [
      {
        _tag: 'InvalidIdentity',
        evidence,
        problem: { _tag: 'CanonicalizationFailed', cause },
      },
    ],
  )
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

const indexUniqueBy = <A>(
  values: readonly A[],
  keyOf: (value: A) => string,
  duplicate: (value: A) => SimulationReconciliationIssue,
): Validation<ReadonlyMap<string, A>> => {
  const indexed = new Map<string, A>()
  for (const value of values) {
    const key = keyOf(value)
    if (indexed.has(key)) return fail(duplicate(value))
    indexed.set(key, value)
  }
  return Result.succeed(indexed)
}

const groupValuesBy = <A>(values: readonly A[], keyOf: (value: A) => string): ReadonlyMap<string, readonly A[]> => {
  const grouped = new Map<string, readonly A[]>()
  for (const value of values) {
    const key = keyOf(value)
    grouped.set(key, [...(grouped.get(key) ?? []), value])
  }
  return grouped
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
): Validation<FillTerms> => {
  const computation: FailedComputation = {
    _tag: 'FillTerms',
    fillId: fill.id,
    side: fill.side,
    quantityMicros: quantityMicros.toString(),
    referencePriceMicros: referencePriceMicros.toString(),
    costMultiplierMicros: costMultiplierMicros.toString(),
  }
  return Result.mapError(
    makeFillTerms(fill.side, quantityMicros, referencePriceMicros, simulation.executionModel, costMultiplierMicros),
    (cause): readonly SimulationReconciliationIssue[] => [{ _tag: 'ComputationFailed', computation, cause }],
  )
}

const validateFill = (
  runId: string,
  fill: FillEvent,
  order: SimulatedOrder,
  orderQuantityMicros: bigint,
  simulation: SimulationTrace,
  costMultiplierMicros: bigint,
): Validation<ValidatedFill> => {
  const bindingIssues: readonly SimulationReconciliationIssue[] = [
    ...(fill.decisionId === order.decisionId
      ? []
      : [fillBindingIssue(fill, order, 'decisionId', fill.decisionId, order.decisionId)]),
    ...(fill.sessionDate === order.sessionDate
      ? []
      : [fillBindingIssue(fill, order, 'sessionDate', fill.sessionDate, order.sessionDate)]),
    ...(fill.symbol === order.symbol ? [] : [fillBindingIssue(fill, order, 'symbol', fill.symbol, order.symbol)]),
    ...(fill.side === order.side ? [] : [fillBindingIssue(fill, order, 'side', fill.side, order.side)]),
  ]
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

  const withTermIssue = (
    issues: readonly SimulationReconciliationIssue[],
    field: Extract<EvidenceMismatchProblem, { readonly _tag: 'FillTerms' }>['field'],
    actualMicros: bigint,
    expectedMicros: bigint,
  ): readonly SimulationReconciliationIssue[] =>
    actualMicros === expectedMicros
      ? issues
      : [
          ...issues,
          {
            _tag: 'EvidenceMismatch',
            problem: {
              _tag: 'FillTerms',
              fillId: fill.id,
              field,
              actualMicros: actualMicros.toString(),
              expectedMicros: expectedMicros.toString(),
            },
          },
        ]
  const price = fillUnsigned(fill, 'priceMicros')
  if (Result.isFailure(price)) return failIssues(price.failure)
  const priceIssues = withTermIssue([], 'priceMicros', price.success, terms.success.fillPriceMicros)
  const notional = fillUnsigned(fill, 'notionalMicros')
  if (Result.isFailure(notional)) return priceIssues.length > 0 ? failIssues(priceIssues) : failIssues(notional.failure)
  const notionalIssues = withTermIssue(priceIssues, 'notionalMicros', notional.success, terms.success.notionalMicros)
  const spread = fillUnsigned(fill, 'spreadCostMicros')
  if (Result.isFailure(spread))
    return notionalIssues.length > 0 ? failIssues(notionalIssues) : failIssues(spread.failure)
  const spreadIssues = withTermIssue(notionalIssues, 'spreadCostMicros', spread.success, terms.success.spreadCostMicros)
  const slippage = fillUnsigned(fill, 'slippageCostMicros')
  if (Result.isFailure(slippage))
    return spreadIssues.length > 0 ? failIssues(spreadIssues) : failIssues(slippage.failure)
  const termIssues = withTermIssue(
    spreadIssues,
    'slippageCostMicros',
    slippage.success,
    terms.success.slippageCostMicros,
  )
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
): Validation<FeeBreakdown> => {
  const computation: FailedComputation = {
    _tag: 'FeeSchedule',
    feeId: fee.id,
    fillCount: inputs.length,
    costMultiplierMicros: costMultiplierMicros.toString(),
  }
  return Result.mapError(
    calculateSessionFees(inputs, simulation.executionModel, costMultiplierMicros),
    (cause): readonly SimulationReconciliationIssue[] => [{ _tag: 'ComputationFailed', computation, cause }],
  )
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
  const scheduleIssues: readonly SimulationReconciliationIssue[] = comparisons.flatMap(([field, actual, calculated]) =>
    actual === calculated
      ? []
      : [
          {
            _tag: 'EvidenceMismatch',
            problem: {
              _tag: 'FeeSchedule',
              feeId: fee.id,
              field,
              actualMicros: actual.toString(),
              expectedMicros: calculated.toString(),
            },
          },
        ],
  )
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

export const validateCashChange = (
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
  const bindingIssues: readonly SimulationReconciliationIssue[] = [
    ...(change.sourceKind === event.kind ? [] : [mismatch('sourceKind', change.sourceKind, event.kind)]),
    ...(change.sessionDate === event.sessionDate
      ? []
      : [mismatch('sessionDate', change.sessionDate, event.sessionDate)]),
  ]
  if (bindingIssues.length > 0) return failIssues(bindingIssues)
  const amount = signed({
    kind: 'cash-change',
    cashChangeId: change.id,
    field: 'amountMicros',
    value: change.amountMicros,
  })
  if (Result.isFailure(amount)) return failIssues(amount.failure)
  const amountIssues: readonly SimulationReconciliationIssue[] =
    amount.success === amountMicros
      ? []
      : [mismatch('amountMicros', amount.success.toString(), amountMicros.toString())]
  const cashAfter = signed({
    kind: 'cash-change',
    cashChangeId: change.id,
    field: 'cashAfterMicros',
    value: change.cashAfterMicros,
  })
  if (Result.isFailure(cashAfter)) {
    return amountIssues.length > 0 ? failIssues(amountIssues) : Result.fail(cashAfter.failure)
  }
  const valueIssues: readonly SimulationReconciliationIssue[] =
    cashAfter.success === cashAfterMicros
      ? amountIssues
      : [...amountIssues, mismatch('cashAfterMicros', cashAfter.success.toString(), cashAfterMicros.toString())]
  if (valueIssues.length > 0) return failIssues(valueIssues)
  const { id: _, ...payload } = change
  return validateCanonicalIdentity(
    { kind: 'cash-change', id: change.id, sourceId: change.sourceId, sessionDate: change.sessionDate },
    { runId, kind: 'cash-change', ...payload },
  )
}

const validateMark = (mark: DailyPositionMark, previous: DailyPositionMark | undefined): Validation<void> => {
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
  return symbols.some((symbol, symbolIndex) => symbolIndex > 0 && symbols[symbolIndex - 1] >= symbol)
    ? fail({
        _tag: 'InvalidEvidenceState',
        problem: { _tag: 'UnsortedMarkedPositions', sessionDate: mark.sessionDate, symbols },
      })
    : Result.succeed(undefined)
}

const validateMarks = (marks: readonly DailyPositionMark[]): Validation<void> =>
  marks.length === 0
    ? fail({ _tag: 'IncompleteEvidence', problem: { _tag: 'EmptyDailyMarks' } })
    : marks.reduce<Validation<void>>(
        (validated, mark, index) =>
          pipe(
            validated,
            Result.flatMap(() => validateMark(mark, marks[index - 1])),
          ),
        Result.succeed(undefined),
      )

export interface PreparedReconciliation {
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
  return pipe(
    [...decisions.success.values()].reduce<Validation<void>>(
      (validated, decision) =>
        pipe(
          validated,
          Result.flatMap(() => validateDecisionIdentity(runId, decision)),
        ),
      Result.succeed(undefined),
    ),
    Result.map(() => decisions.success),
  )
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
  const fillsByOrder = indexUniqueBy(
    fills.map((event, eventIndex) => ({ event, eventIndex })),
    ({ event }) => event.orderId,
    ({ event }) => ({
      _tag: 'InvalidEvidenceState',
      problem: { _tag: 'DuplicateFillForOrder', orderId: event.orderId, secondFillId: event.id },
    }),
  )
  if (Result.isFailure(fillsByOrder)) return failIssues(fillsByOrder.failure)

  const orders = indexUnique(simulation.orders, 'order', (order) => ({
    kind: 'order',
    id: order.id,
    sessionDate: order.sessionDate,
  }))
  if (Result.isFailure(orders)) return failIssues(orders.failure)
  const preparedFills = [...orders.success.values()].reduce<
    Validation<Chunk.Chunk<{ readonly eventIndex: number; readonly fill: ValidatedFill }>>
  >(
    (prepared, order) =>
      pipe(
        prepared,
        Result.flatMap((items) => {
          const indexedFill = fillsByOrder.success.get(order.id)
          return pipe(
            validateOrder(runId, order, indexedFill?.event, decisions, simulation, costMultiplierMicros),
            Result.map((fill) =>
              fill === undefined || indexedFill === undefined
                ? items
                : Chunk.prepend(items, { eventIndex: indexedFill.eventIndex, fill }),
            ),
          )
        }),
      ),
    Result.succeed(Chunk.empty()),
  )
  if (Result.isFailure(preparedFills)) return failIssues(preparedFills.failure)
  const orphan = fills.find((fill) => !orders.success.has(fill.orderId))
  return orphan === undefined
    ? Result.succeed(
        Chunk.toReadonlyArray(preparedFills.success)
          .toSorted((left, right) => left.eventIndex - right.eventIndex)
          .map(({ fill }) => fill),
      )
    : fail({
        _tag: 'MissingReference',
        problem: { _tag: 'FillOrder', fillId: orphan.id, orderId: orphan.orderId },
      })
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
  const fillsBySession = groupValuesBy(fills, (fill) => fill.event.sessionDate)
  return pipe(
    fees.reduce<Validation<Chunk.Chunk<ValidatedFee>>>(
      (prepared, fee) =>
        pipe(
          prepared,
          Result.flatMap((items) =>
            pipe(
              validateFee(runId, fee, fillsBySession.get(fee.sessionDate) ?? [], simulation, costMultiplierMicros),
              Result.map((valid) => Chunk.prepend(items, valid)),
            ),
          ),
        ),
      Result.succeed(Chunk.empty()),
    ),
    Result.map((reversed) => Chunk.toReadonlyArray(Chunk.reverse(reversed))),
  )
}

export interface PreparedFill extends ValidatedFill {
  readonly cashChange: CashChange
}

export interface PreparedFee extends ValidatedFee {
  readonly cashChange: CashChange
}

export interface PreparedCashYield {
  readonly kind: 'cash-yield'
  readonly event: CashYieldEvent
  readonly cashChange: CashChange
}

export type PreparedMonetaryEvent = PreparedFill | PreparedFee | PreparedCashYield

interface MonetaryEvidence {
  readonly events: readonly PreparedMonetaryEvent[]
}

interface MonetaryAccumulator {
  readonly reversedEvents: Chunk.Chunk<PreparedMonetaryEvent>
  readonly fillIndex: number
  readonly feeIndex: number
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
  const cashChangesBySource = indexUniqueBy(
    [...changes.success.values()],
    (change) => change.sourceId,
    (change) => ({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'DuplicateCashChangeForEvent',
        eventId: change.sourceId,
        secondCashChangeId: change.id,
      },
    }),
  )
  if (Result.isFailure(cashChangesBySource)) return failIssues(cashChangesBySource.failure)
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
  return pipe(
    sourceEvents.reduce<Validation<MonetaryAccumulator>>(
      (prepared, event) =>
        pipe(
          prepared,
          Result.flatMap((accumulator) => {
            const cashChange = cashChangesBySource.success.get(event.id)
            if (cashChange === undefined) {
              return fail({
                _tag: 'MissingReference',
                problem: { _tag: 'MonetaryEventCashChange', eventId: event.id, eventKind: event.kind },
              })
            }
            if (event.kind === 'cash-yield') {
              return Result.succeed({
                ...accumulator,
                reversedEvents: Chunk.prepend(accumulator.reversedEvents, {
                  kind: 'cash-yield',
                  event,
                  cashChange,
                }),
              })
            }
            return event.kind === 'fill'
              ? Result.succeed({
                  reversedEvents: Chunk.prepend(accumulator.reversedEvents, {
                    ...fills[accumulator.fillIndex],
                    cashChange,
                  }),
                  fillIndex: accumulator.fillIndex + 1,
                  feeIndex: accumulator.feeIndex,
                })
              : Result.succeed({
                  reversedEvents: Chunk.prepend(accumulator.reversedEvents, {
                    ...fees[accumulator.feeIndex],
                    cashChange,
                  }),
                  fillIndex: accumulator.fillIndex,
                  feeIndex: accumulator.feeIndex + 1,
                })
          }),
        ),
      Result.succeed({ reversedEvents: Chunk.empty(), fillIndex: 0, feeIndex: 0 }),
    ),
    Result.map(({ reversedEvents }) => ({
      events: Chunk.toReadonlyArray(Chunk.reverse(reversedEvents)),
    })),
  )
}

export const prepareReconciliation = (input: MarkedEquityReconciliationInput): Validation<PreparedReconciliation> => {
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
