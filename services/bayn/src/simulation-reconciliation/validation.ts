import { Result } from 'effect'

import { makeFillTerms, type FillTerms } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import type { DailyPositionMark, DecisionEvent, FillEvent, SimulatedOrder, SimulationTrace } from '../types'
import {
  type CanonicalIdentityEvidence,
  type CanonicalIdentityProblem,
  type EvidenceMismatchProblem,
  type FailedComputation,
  type IdentityEvidence,
  type InvalidEvidenceStateProblem,
  type PositiveUnsignedIntegerEvidence,
  type SignedIntegerEvidence,
  type SimulationReconciliationIssue,
  type UnsignedIntegerEvidence,
  type Validation,
} from './model'
import { Pipeable } from '../pipeable'

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

export const positiveUnsigned = (evidence: PositiveUnsignedIntegerEvidence): Validation<bigint> => {
  if (!/^\d+$/.test(evidence.value)) {
    return fail({ _tag: 'InvalidInteger', expected: 'positive-unsigned-integer', evidence })
  }
  const value = BigInt(evidence.value)
  return value > 0n
    ? Result.succeed(value)
    : fail({ _tag: 'InvalidInteger', expected: 'positive-unsigned-integer', evidence })
}

export const signed = (evidence: SignedIntegerEvidence): Validation<bigint> =>
  /^-?\d+$/.test(evidence.value)
    ? Result.succeed(BigInt(evidence.value))
    : fail({ _tag: 'InvalidInteger', expected: 'signed-integer', evidence })

type OrderIntegerField = Extract<UnsignedIntegerEvidence, { readonly kind: 'order' }>['field']
type FillIntegerField = Extract<UnsignedIntegerEvidence, { readonly kind: 'fill' }>['field']
type MarkIntegerField = Extract<UnsignedIntegerEvidence, { readonly kind: 'daily-mark' }>['field']
type PositionIntegerField = Extract<UnsignedIntegerEvidence, { readonly kind: 'position' }>['field']

const orderUnsigned = (order: SimulatedOrder, field: OrderIntegerField): Validation<bigint> =>
  unsigned({ kind: 'order', orderId: order.id, field, value: order[field] })

const fillUnsigned = (fill: FillEvent, field: FillIntegerField): Validation<bigint> =>
  unsigned({ kind: 'fill', fillId: fill.id, field, value: fill[field] })

const markUnsignedDataFirst = (mark: DailyPositionMark, field: MarkIntegerField): Validation<bigint> =>
  unsigned({ kind: 'daily-mark', sessionDate: mark.sessionDate, field, value: mark[field] })

export const markUnsigned = Pipeable.dual(2, markUnsignedDataFirst)

const positionUnsignedDataFirst = (
  mark: DailyPositionMark,
  position: DailyPositionMark['positions'][number],
  field: PositionIntegerField,
): Validation<bigint> =>
  unsigned({ kind: 'position', sessionDate: mark.sessionDate, symbol: position.symbol, field, value: position[field] })

export const positionUnsigned = Pipeable.dual(3, positionUnsignedDataFirst)

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

const validateCanonicalIdentityDataFirst = (
  evidence: CanonicalIdentityEvidence,
  material: unknown,
): Validation<void> => {
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

export const validateCanonicalIdentity = Pipeable.dual(2, validateCanonicalIdentityDataFirst)

type IndexedIdentity = CanonicalIdentityEvidence

export const indexUnique = <A extends { readonly id: string }>(
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

export const indexUniqueBy = <A>(
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

export const groupValuesBy = <A>(
  values: readonly A[],
  keyOf: (value: A) => string,
): ReadonlyMap<string, readonly A[]> => {
  const grouped = new Map<string, readonly A[]>()
  for (const value of values) {
    const key = keyOf(value)
    grouped.set(key, [...(grouped.get(key) ?? []), value])
  }
  return grouped
}

const validateDecisionIdentityDataFirst = (runId: string, decision: DecisionEvent): Validation<void> => {
  const { id: _, kind: __, ...payload } = decision
  return validateCanonicalIdentity(
    { kind: 'decision', id: decision.id, signalDate: decision.signalDate },
    { runId, kind: 'decision', ...payload },
  )
}

export const validateDecisionIdentity = Pipeable.dual(2, validateDecisionIdentityDataFirst)

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

export interface ValidatedFill {
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

const validateOrderDataFirst = (
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

export const validateOrder = Pipeable.dual(6, validateOrderDataFirst)
