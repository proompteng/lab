import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from './hash'
import { makeFillTerms } from './execution-model'
import { evaluateRiskBalancedTrend } from './risk-balanced-trend'
import {
  MARKED_EQUITY_TOLERANCE_MICROS,
  reconcileMarkedEquity,
  renderSimulationReconciliationIssue,
  type MarkedEquityReconciliationInput,
  type SimulationReconciliationIssue,
  type SimulationReconciliationResult,
} from './simulation-reconciliation'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'
import type { EvaluationEvent, Protocol, SimulationTrace } from './types'

const snapshot = makeSnapshot(800)
const evaluationResult = evaluateRiskBalancedTrend(
  snapshot.bars,
  snapshot.manifest,
  fixtureProtocol,
  makeTestProvenance(fixtureProtocol),
)
assert(Result.isSuccess(evaluationResult), 'evaluation fixture must reconcile successfully')
const evaluation = evaluationResult.success

const reconcile = (
  overrides: {
    readonly runId?: string
    readonly initialCapitalMicros?: string
    readonly events?: readonly EvaluationEvent[]
    readonly simulation?: SimulationTrace
    readonly evaluatorEndingEquityMicros?: string
    readonly evaluatorTotalFeesMicros?: string
  } = {},
): SimulationReconciliationResult =>
  reconcileMarkedEquity({
    runId: overrides.runId ?? evaluation.runId,
    initialCapitalMicros: overrides.initialCapitalMicros ?? evaluation.initialCapitalMicros,
    evaluatorTotalFeesMicros: overrides.evaluatorTotalFeesMicros ?? evaluation.strategy.totalFeesMicros,
    evaluatorEndingEquityMicros: overrides.evaluatorEndingEquityMicros ?? evaluation.strategy.endingEquityMicros,
    events: overrides.events ?? evaluation.events,
    simulation: overrides.simulation ?? evaluation.simulation,
  })

const expectIssue = (
  result: SimulationReconciliationResult,
  expected: { readonly _tag: SimulationReconciliationIssue['_tag']; readonly [key: string]: unknown },
): SimulationReconciliationIssue => {
  assert(Result.isFailure(result), 'expected reconciliation to fail')
  expect(result.failure).toContainEqual(expect.objectContaining(expected))
  const issue = result.failure.find((candidate) => candidate._tag === expected._tag)
  assert(issue !== undefined, `expected reconciliation issue ${expected._tag}`)
  expect(issue).not.toBeInstanceOf(Error)
  return issue
}

const expectExactIssues = (
  result: SimulationReconciliationResult,
  expected: readonly SimulationReconciliationIssue[],
): void => {
  assert(Result.isFailure(result), 'expected reconciliation to fail')
  expect(result.failure).toEqual(expected)
  for (const issue of result.failure) expect(issue).not.toBeInstanceOf(Error)
}

const firstEvent = <K extends EvaluationEvent['kind']>(kind: K): Extract<EvaluationEvent, { readonly kind: K }> => {
  const event = evaluation.events.find(
    (candidate): candidate is Extract<EvaluationEvent, { readonly kind: K }> => candidate.kind === kind,
  )
  assert(event !== undefined, `evaluation fixture must contain ${kind}`)
  return event
}

const makeEmptyInput = (): MarkedEquityReconciliationInput => {
  const mark = evaluation.simulation.dailyMarks[0]
  const capital = '1000000000000'
  return {
    runId: evaluation.runId,
    initialCapitalMicros: capital,
    evaluatorTotalFeesMicros: '0',
    evaluatorEndingEquityMicros: capital,
    events: [],
    simulation: {
      ...evaluation.simulation,
      orders: [],
      cashChanges: [],
      dailyMarks: [
        {
          ...mark,
          sessionDate: '2026-01-02',
          equityMicros: capital,
          turnoverMicros: '0',
          cumulativeTurnoverMicros: '0',
          feeMicros: '0',
          cumulativeFeesMicros: '0',
          spreadCostMicros: '0',
          cumulativeSpreadCostMicros: '0',
          slippageCostMicros: '0',
          cumulativeSlippageCostMicros: '0',
          cashYieldMicros: '0',
          cumulativeCashYieldMicros: '0',
          cashMicros: capital,
          positions: [],
        },
      ],
    },
  }
}

const makeRoundTripInput = (dayCount: number): MarkedEquityReconciliationInput => {
  const sessionDates = [
    '2026-02-01',
    '2026-02-02',
    '2026-02-03',
    '2026-02-04',
    '2026-02-05',
    '2026-02-06',
    '2026-02-07',
    '2026-02-08',
    '2026-02-09',
    '2026-02-10',
  ] as const
  assert(dayCount <= sessionDates.length, 'round-trip fixture day count must be bounded')
  const input = makeEmptyInput()
  const markTemplate = input.simulation.dailyMarks[0]
  const events: EvaluationEvent[] = []
  const orders: SimulationTrace['orders'][number][] = []
  const cashChanges: SimulationTrace['cashChanges'][number][] = []
  const dailyMarks: SimulationTrace['dailyMarks'][number][] = []
  const costMultiplierMicros = BigInt(input.simulation.costMultiplierMicros)
  const quantityMicros = 1_000_000n
  const referencePriceMicros = 100_000_000n
  let cashMicros = BigInt(input.initialCapitalMicros)
  let cumulativeTurnoverMicros = 0n
  let cumulativeSpreadCostMicros = 0n
  let cumulativeSlippageCostMicros = 0n

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const sessionDate = sessionDates[dayIndex]
    const signalDate = sessionDate
    const symbol = `S${String(dayIndex + 1).padStart(3, '0')}`
    const decisionPayload = { signalDate, executionDate: sessionDate, targetWeights: { [symbol]: 0 } }
    const decisionId = canonicalHashV1({ runId: input.runId, kind: 'decision', ...decisionPayload })
    events.push({ kind: 'decision', id: decisionId, ...decisionPayload })
    let dailyTurnoverMicros = 0n
    let dailySpreadCostMicros = 0n
    let dailySlippageCostMicros = 0n

    for (const side of ['buy', 'sell'] as const) {
      const orderPayload = {
        decisionId,
        sessionDate,
        symbol,
        side,
        requestedQuantityMicros: quantityMicros.toString(),
        filledQuantityMicros: quantityMicros.toString(),
        status: 'filled' as const,
        rejectionReason: null,
        unfilledRemainder: 'none' as const,
      }
      const orderId = canonicalHashV1({ runId: input.runId, kind: 'order', ...orderPayload })
      orders.push({ id: orderId, ...orderPayload })
      const terms = makeFillTerms(
        side,
        quantityMicros,
        referencePriceMicros,
        input.simulation.executionModel,
        costMultiplierMicros,
      )
      const fillPayload = {
        orderId,
        decisionId,
        sessionDate,
        symbol,
        side,
        quantityMicros: quantityMicros.toString(),
        referencePriceMicros: referencePriceMicros.toString(),
        priceMicros: terms.fillPriceMicros.toString(),
        notionalMicros: terms.notionalMicros.toString(),
        spreadCostMicros: terms.spreadCostMicros.toString(),
        slippageCostMicros: terms.slippageCostMicros.toString(),
        costBasisMicros: terms.notionalMicros.toString(),
      }
      const fillId = canonicalHashV1({ runId: input.runId, kind: 'fill', ...fillPayload })
      events.push({ kind: 'fill', id: fillId, ...fillPayload })
      const amountMicros = side === 'buy' ? -terms.notionalMicros : terms.notionalMicros
      cashMicros += amountMicros
      const cashChangePayload = {
        sourceKind: 'fill' as const,
        sourceId: fillId,
        sessionDate,
        amountMicros: amountMicros.toString(),
        cashAfterMicros: cashMicros.toString(),
      }
      cashChanges.push({
        id: canonicalHashV1({ runId: input.runId, kind: 'cash-change', ...cashChangePayload }),
        ...cashChangePayload,
      })
      cumulativeTurnoverMicros += terms.notionalMicros
      cumulativeSpreadCostMicros += terms.spreadCostMicros
      cumulativeSlippageCostMicros += terms.slippageCostMicros
      dailyTurnoverMicros += terms.notionalMicros
      dailySpreadCostMicros += terms.spreadCostMicros
      dailySlippageCostMicros += terms.slippageCostMicros
    }
    dailyMarks.push({
      ...markTemplate,
      sessionDate,
      equityMicros: cashMicros.toString(),
      turnoverMicros: dailyTurnoverMicros.toString(),
      cumulativeTurnoverMicros: cumulativeTurnoverMicros.toString(),
      feeMicros: '0',
      cumulativeFeesMicros: '0',
      spreadCostMicros: dailySpreadCostMicros.toString(),
      cumulativeSpreadCostMicros: cumulativeSpreadCostMicros.toString(),
      slippageCostMicros: dailySlippageCostMicros.toString(),
      cumulativeSlippageCostMicros: cumulativeSlippageCostMicros.toString(),
      cashYieldMicros: '0',
      cumulativeCashYieldMicros: '0',
      cashMicros: cashMicros.toString(),
      positions: [],
    })
  }

  return {
    ...input,
    evaluatorEndingEquityMicros: cashMicros.toString(),
    events,
    simulation: { ...input.simulation, orders, cashChanges, dailyMarks },
  }
}

type IssueLeaf =
  | 'InvalidInteger/unsigned-integer'
  | 'InvalidInteger/positive-unsigned-integer'
  | 'InvalidInteger/signed-integer'
  | 'InvalidIdentity/InvalidFormat'
  | 'InvalidIdentity/HashMismatch'
  | 'InvalidIdentity/CanonicalizationFailed'
  | 'MissingReference/OrderDecision'
  | 'MissingReference/FillOrder'
  | 'MissingReference/MonetaryEventCashChange'
  | 'EvidenceMismatch/OrderExecutionSession'
  | 'EvidenceMismatch/FillBinding'
  | 'EvidenceMismatch/FillQuantity'
  | 'EvidenceMismatch/FillTerms'
  | 'EvidenceMismatch/FeeComponents'
  | 'EvidenceMismatch/FeeSchedule'
  | 'EvidenceMismatch/CashChange'
  | 'EvidenceMismatch/CashYield'
  | 'EvidenceMismatch/DailyMark'
  | 'EvidenceMismatch/PositionMark'
  | 'InvalidEvidenceState/DuplicateIdentity'
  | 'InvalidEvidenceState/DuplicateFillForOrder'
  | 'InvalidEvidenceState/DuplicateCashChangeForEvent'
  | 'InvalidEvidenceState/InvalidOrder'
  | 'InvalidEvidenceState/InvalidMarkOrder'
  | 'InvalidEvidenceState/DuplicateMarkedPosition'
  | 'InvalidEvidenceState/UnsortedMarkedPositions'
  | 'InvalidEvidenceState/NegativeCash'
  | 'InvalidEvidenceState/NegativeLongPosition'
  | 'InvalidEvidenceState/DailyOutsideTolerance'
  | 'InvalidEvidenceState/FinalOutsideTolerance'
  | 'InvalidEvidenceState/NegativeTolerance'
  | 'InvalidEvidenceState/UnsupportedSimulationSchema'
  | 'IncompleteEvidence/EmptyDailyMarks'
  | 'IncompleteEvidence/CashChangeCountMismatch'
  | 'IncompleteEvidence/MissingSessionMark'
  | 'IncompleteEvidence/MissingOpenPositionMark'
  | 'IncompleteEvidence/MonetaryEventsAfterFinalMark'
  | 'ComputationFailed/FillTerms'
  | 'ComputationFailed/FeeSchedule'
  | 'ComputationFailed/CashYield'

const issueLeaf = (issue: SimulationReconciliationIssue): IssueLeaf => {
  switch (issue._tag) {
    case 'InvalidInteger':
      return `InvalidInteger/${issue.expected}`
    case 'InvalidIdentity':
      return `InvalidIdentity/${issue.problem._tag}`
    case 'MissingReference':
      return `MissingReference/${issue.problem._tag}`
    case 'EvidenceMismatch':
      return `EvidenceMismatch/${issue.problem._tag}`
    case 'InvalidEvidenceState':
      return `InvalidEvidenceState/${issue.problem._tag}`
    case 'IncompleteEvidence':
      return `IncompleteEvidence/${issue.problem._tag}`
    case 'ComputationFailed':
      return `ComputationFailed/${issue.computation._tag}`
  }
}

describe('independent marked-equity reconciliation', () => {
  test('reconstructs the byte-identical proof from complete evidence', () => {
    const result = reconcile()
    assert(Result.isSuccess(result), 'valid fixture must reconcile successfully')
    expect(result.success).toEqual({
      reconciliation: evaluation.markedEquityReconciliation,
      equitySeries: evaluation.equitySeries,
    })
    expect(result.success.reconciliation.withinTolerance).toBe(true)
    expect(result.success.equitySeries).toHaveLength(evaluation.strategy.observations)
    expect(Object.isFrozen(result.success)).toBe(true)
    expect(Object.isFrozen(result.success.reconciliation)).toBe(true)
    expect(Object.isFrozen(result.success.equitySeries)).toBe(true)
    expect(result.success.equitySeries.every(Object.isFrozen)).toBe(true)
    expect(result.success.reconciliation).not.toBe(evaluation.markedEquityReconciliation)
    expect(result.success.equitySeries).not.toBe(evaluation.equitySeries)
    expect(result.success.equitySeries[0]).not.toBe(evaluation.equitySeries[0])
    expect(Reflect.set(result.success.reconciliation, 'exact', false)).toBe(false)
    expect(Reflect.set(result.success.equitySeries[0], 'differenceMicros', '1')).toBe(false)
    expect(evaluation.simulation.cashChanges).toHaveLength(
      evaluation.events.filter((event) => event.kind !== 'decision').length,
    )
  })

  test('drops closed positions across growing same-session round trips', () => {
    const oneDay = makeRoundTripInput(1)
    const tenDays = makeRoundTripInput(10)
    const oneDayResult = reconcileMarkedEquity(oneDay)
    const tenDayResult = reconcileMarkedEquity(tenDays)

    assert(Result.isSuccess(oneDayResult), 'one-day round-trip fixture must reconcile')
    assert(Result.isSuccess(tenDayResult), 'ten-day round-trip fixture must reconcile')
    expect(oneDayResult.success.equitySeries.at(-1)?.reconstructedEquityMicros).toBe(oneDay.evaluatorEndingEquityMicros)
    expect(tenDayResult.success.equitySeries.at(-1)?.reconstructedEquityMicros).toBe(
      tenDays.evaluatorEndingEquityMicros,
    )
  })

  test('returns immutable plain issues and preserves them through Result.match', () => {
    const firstChange = evaluation.simulation.cashChanges[0]
    const simulation: SimulationTrace = {
      ...evaluation.simulation,
      cashChanges: evaluation.simulation.cashChanges.map((change, index) =>
        index === 0 ? { ...change, amountMicros: (BigInt(change.amountMicros) + 1n).toString() } : change,
      ),
    }
    const result = reconcile({ simulation })
    const issue = expectIssue(result, {
      _tag: 'EvidenceMismatch',
      problem: expect.objectContaining({
        _tag: 'CashChange',
        cashChangeId: firstChange.id,
        field: 'amountMicros',
        actual: (BigInt(firstChange.amountMicros) + 1n).toString(),
        expected: firstChange.amountMicros,
      }),
    })
    expect(Object.isFrozen(issue)).toBe(true)
    assert(issue._tag === 'EvidenceMismatch', 'cash change must produce an evidence mismatch')
    expect(Object.isFrozen(issue.problem)).toBe(true)
    expect(Reflect.set(issue.problem, 'field', 'cashAfterMicros')).toBe(false)
    expect(issue.problem).toEqual(expect.objectContaining({ _tag: 'CashChange', field: 'amountMicros' }))
    const propagated = Result.match(result, { onFailure: (failure) => failure, onSuccess: () => undefined })
    assert(Result.isFailure(result), 'expected reconciliation to fail')
    expect(Object.isFrozen(result.failure)).toBe(true)
    expect(propagated).toBe(result.failure)
  })

  test('freezes every known nested issue payload without freezing the original unknown cause', () => {
    const markIndex = evaluation.simulation.dailyMarks.findIndex((mark) => mark.positions.length > 0)
    assert(markIndex >= 0, 'evaluation fixture must contain a position mark')
    const mark = evaluation.simulation.dailyMarks[markIndex]
    const firstPosition = mark.positions[0]
    const simulation: SimulationTrace = {
      ...evaluation.simulation,
      dailyMarks: evaluation.simulation.dailyMarks.map((candidate, index) =>
        index === markIndex ? { ...candidate, positions: [firstPosition, firstPosition] } : candidate,
      ),
    }
    const issue = expectIssue(reconcile({ simulation }), {
      _tag: 'InvalidEvidenceState',
      problem: expect.objectContaining({ _tag: 'DuplicateMarkedPosition' }),
    })
    assert(issue._tag === 'InvalidEvidenceState', 'duplicate mark must produce invalid evidence state')
    assert(issue.problem._tag === 'DuplicateMarkedPosition', 'duplicate mark must retain its symbols')
    expect(Object.isFrozen(issue.problem)).toBe(true)
    expect(Object.isFrozen(issue.problem.symbols)).toBe(true)
    expect(Reflect.set(issue.problem.symbols, 0, 'MUTATED')).toBe(false)
    expect(issue.problem.symbols[0]).toBe(firstPosition.symbol)
  })

  test('returns closed integer, identity, and reference failures', () => {
    const integerIssue = expectIssue(reconcile({ initialCapitalMicros: 'not-an-integer' }), {
      _tag: 'InvalidInteger',
      expected: 'unsigned-integer',
      evidence: {
        kind: 'input',
        field: 'initialCapitalMicros',
        value: 'not-an-integer',
      },
    })
    assert(integerIssue._tag === 'InvalidInteger', 'malformed capital must produce an integer issue')
    expect(Object.isFrozen(integerIssue.evidence)).toBe(true)
    expect(Reflect.set(integerIssue.evidence, 'value', '0')).toBe(false)
    expect(integerIssue.evidence.value).toBe('not-an-integer')

    const identityIssue = expectIssue(reconcile({ runId: 'not-a-run-id' }), {
      _tag: 'InvalidIdentity',
      evidence: { kind: 'run', id: 'not-a-run-id' },
      problem: { _tag: 'InvalidFormat', expected: 'lowercase-sha256' },
    })
    assert(identityIssue._tag === 'InvalidIdentity', 'malformed run ID must produce an identity issue')
    expect(Object.isFrozen(identityIssue.evidence)).toBe(true)
    expect(Object.isFrozen(identityIssue.problem)).toBe(true)
    expect(Reflect.set(identityIssue.evidence, 'id', evaluation.runId)).toBe(false)
    expect(identityIssue.evidence.id).toBe('not-a-run-id')

    const firstOrder = evaluation.simulation.orders[0]
    const simulation: SimulationTrace = {
      ...evaluation.simulation,
      orders: [{ ...firstOrder, decisionId: 'f'.repeat(64) }, ...evaluation.simulation.orders.slice(1)],
    }
    expectIssue(reconcile({ simulation }), {
      _tag: 'MissingReference',
      problem: { _tag: 'OrderDecision', orderId: firstOrder.id, decisionId: 'f'.repeat(64) },
    })

    const zeroCostMultiplier: SimulationTrace = { ...evaluation.simulation, costMultiplierMicros: '0' }
    expectExactIssues(reconcile({ simulation: zeroCostMultiplier }), [
      {
        _tag: 'InvalidInteger',
        expected: 'positive-unsigned-integer',
        evidence: { kind: 'simulation', field: 'costMultiplierMicros', value: '0' },
      },
    ])

    const firstChange = evaluation.simulation.cashChanges[0]
    const malformedCash: SimulationTrace = {
      ...evaluation.simulation,
      cashChanges: evaluation.simulation.cashChanges.map((change, index) =>
        index === 0 ? { ...change, amountMicros: '1.5' } : change,
      ),
    }
    expectExactIssues(reconcile({ simulation: malformedCash }), [
      {
        _tag: 'InvalidInteger',
        expected: 'signed-integer',
        evidence: {
          kind: 'cash-change',
          cashChangeId: firstChange.id,
          field: 'amountMicros',
          value: '1.5',
        },
      },
    ])
  })

  test('retains canonicalization facts and the original cause without throwing', () => {
    const decisionIndex = evaluation.events.findIndex((event) => event.kind === 'decision')
    const decision = evaluation.events[decisionIndex]
    assert(decision?.kind === 'decision', 'evaluation fixture must contain a decision')
    const events = evaluation.events.map((event, index) =>
      index === decisionIndex ? { ...decision, targetWeights: { ...decision.targetWeights, ['\ud800']: 0 } } : event,
    )
    const run = () => reconcile({ events })
    expect(run).not.toThrow()
    const issue = expectIssue(run(), {
      _tag: 'InvalidIdentity',
      evidence: expect.objectContaining({ kind: 'decision', id: decision.id }),
      problem: expect.objectContaining({ _tag: 'CanonicalizationFailed' }),
    })
    assert(issue._tag === 'InvalidIdentity', 'canonicalization must produce an identity issue')
    assert(issue.problem._tag === 'CanonicalizationFailed', 'identity issue must retain its cause')
    expect(issue.problem.cause).toBeInstanceOf(TypeError)
    expect(Object.isFrozen(issue.problem)).toBe(true)
    expect(Object.isFrozen(issue.problem.cause as object)).toBe(false)

    const hostileCause = Object.create(null)
    Object.defineProperty(hostileCause, Symbol.toPrimitive, {
      value: () => {
        throw new TypeError('cause cannot be rendered')
      },
    })
    const render = () =>
      renderSimulationReconciliationIssue({
        _tag: 'InvalidIdentity',
        evidence: { kind: 'decision', id: evaluation.runId, signalDate: '2026-01-30' },
        problem: { _tag: 'CanonicalizationFailed', cause: hostileCause },
      })
    expect(render).not.toThrow()
    expect(render()).toEndWith('unrenderable cause')
  })

  test('captures canonical calculation failures without duplicating execution-model validation', () => {
    const zeroPriceIncrement: SimulationTrace = {
      ...evaluation.simulation,
      executionModel: {
        ...evaluation.simulation.executionModel,
        precision: { ...evaluation.simulation.executionModel.precision, priceIncrementMicros: '0' },
      },
    }
    const priceRun = () => reconcile({ simulation: zeroPriceIncrement })
    expect(priceRun).not.toThrow()
    const fillIssue = expectIssue(priceRun(), {
      _tag: 'ComputationFailed',
      computation: expect.objectContaining({ _tag: 'FillTerms' }),
    })
    assert(fillIssue._tag === 'ComputationFailed', 'fill calculation must retain its failure')
    expect(Object.isFrozen(fillIssue.computation)).toBe(true)
    expect(Reflect.set(fillIssue.computation, 'costMultiplierMicros', '0')).toBe(false)
    expect(fillIssue.cause).toEqual(expect.objectContaining({ message: 'price increment must be positive' }))
    expect(Object.isFrozen(fillIssue.cause as object)).toBe(false)

    const zeroFeeIncrement: SimulationTrace = {
      ...evaluation.simulation,
      executionModel: {
        ...evaluation.simulation.executionModel,
        fees: { ...evaluation.simulation.executionModel.fees, roundingIncrementMicros: '0' },
      },
    }
    const feeRun = () => reconcile({ simulation: zeroFeeIncrement })
    expect(feeRun).not.toThrow()
    expectIssue(feeRun(), {
      _tag: 'ComputationFailed',
      computation: expect.objectContaining({ _tag: 'FeeSchedule' }),
    })
  })

  test('preserves fail-fast baseline precedence for multiply malformed fill and fee evidence', () => {
    const fillIndex = evaluation.events.findIndex((event) => event.kind === 'fill')
    const fill = evaluation.events[fillIndex]
    assert(fill?.kind === 'fill', 'evaluation fixture must contain a fill')
    const order = evaluation.simulation.orders.find((candidate) => candidate.id === fill.orderId)
    assert(order !== undefined, 'fill must retain its order')

    const badBindingEvents = evaluation.events.map((event, index) =>
      index === fillIndex ? { ...fill, decisionId: 'f'.repeat(64), referencePriceMicros: 'bad' } : event,
    )
    expectExactIssues(reconcile({ events: badBindingEvents }), [
      {
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'FillBinding',
          fillId: fill.id,
          orderId: order.id,
          field: 'decisionId',
          actual: 'f'.repeat(64),
          expected: order.decisionId,
        },
      },
    ])

    const badQuantityEvents = evaluation.events.map((event, index) =>
      index === fillIndex ? { ...fill, quantityMicros: (BigInt(fill.quantityMicros) + 1n).toString() } : event,
    )
    const badQuantitySimulation: SimulationTrace = {
      ...evaluation.simulation,
      executionModel: {
        ...evaluation.simulation.executionModel,
        precision: { ...evaluation.simulation.executionModel.precision, priceIncrementMicros: '0' },
      },
    }
    expectExactIssues(reconcile({ events: badQuantityEvents, simulation: badQuantitySimulation }), [
      {
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'FillQuantity',
          fillId: fill.id,
          orderId: order.id,
          actualQuantityMicros: (BigInt(fill.quantityMicros) + 1n).toString(),
          expectedQuantityMicros: order.filledQuantityMicros,
        },
      },
    ])

    const feeIndex = evaluation.events.findIndex((event) => event.kind === 'fee')
    const fee = evaluation.events[feeIndex]
    assert(fee?.kind === 'fee', 'evaluation fixture must contain a fee')
    const badFeeEvents = evaluation.events.map((event, index) =>
      index === feeIndex ? { ...fee, totalMicros: (BigInt(fee.totalMicros) + 1n).toString() } : event,
    )
    const badFeeSimulation: SimulationTrace = {
      ...evaluation.simulation,
      executionModel: {
        ...evaluation.simulation.executionModel,
        fees: { ...evaluation.simulation.executionModel.fees, roundingIncrementMicros: '0' },
      },
    }
    const expectedFeeTotal = (
      BigInt(fee.commissionMicros) +
      BigInt(fee.secMicros) +
      BigInt(fee.tafMicros) +
      BigInt(fee.catMicros)
    ).toString()
    expectExactIssues(reconcile({ events: badFeeEvents, simulation: badFeeSimulation }), [
      {
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'FeeComponents',
          feeId: fee.id,
          actualTotalMicros: (BigInt(fee.totalMicros) + 1n).toString(),
          expectedTotalMicros: expectedFeeTotal,
        },
      },
    ])
  })

  test('preserves fail-fast baseline precedence for cash, yield, and position evidence', () => {
    const firstChange = evaluation.simulation.cashChanges[0]
    const wrongKind = firstChange.sourceKind === 'fill' ? 'fee' : 'fill'
    const badCash: SimulationTrace = {
      ...evaluation.simulation,
      cashChanges: evaluation.simulation.cashChanges.map((change, index) =>
        index === 0 ? { ...change, sourceKind: wrongKind, amountMicros: 'bad' } : change,
      ),
    }
    const firstSource = evaluation.events.find((event) => event.id === firstChange.sourceId)
    assert(firstSource !== undefined && firstSource.kind !== 'decision', 'cash change must retain its monetary source')
    expectExactIssues(reconcile({ simulation: badCash }), [
      {
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'CashChange',
          cashChangeId: firstChange.id,
          sourceId: firstSource.id,
          field: 'sourceKind',
          actual: wrongKind,
          expected: firstSource.kind,
        },
      },
    ])

    const yieldProtocol: Protocol = {
      ...fixtureProtocol,
      executionModel: {
        ...fixtureProtocol.executionModel,
        cash: { ...fixtureProtocol.executionModel.cash, annualYieldBps: 50 },
      },
    }
    const yieldResult = evaluateRiskBalancedTrend(
      snapshot.bars,
      snapshot.manifest,
      yieldProtocol,
      makeTestProvenance(yieldProtocol),
    )
    assert(Result.isSuccess(yieldResult), 'cash-yield evaluation fixture must succeed')
    const yieldEventIndex = yieldResult.success.events.findIndex((event) => event.kind === 'cash-yield')
    const yieldEvent = yieldResult.success.events[yieldEventIndex]
    assert(yieldEvent?.kind === 'cash-yield', 'cash-yield fixture must contain a yield event')
    const malformedYieldEvents = yieldResult.success.events.map((event, index) =>
      index === yieldEventIndex
        ? { ...yieldEvent, annualYieldBps: yieldEvent.annualYieldBps + 1, elapsedDays: -1 }
        : event,
    )
    const yieldReconciliation = reconcileMarkedEquity({
      runId: yieldResult.success.runId,
      initialCapitalMicros: yieldResult.success.initialCapitalMicros,
      evaluatorTotalFeesMicros: yieldResult.success.strategy.totalFeesMicros,
      evaluatorEndingEquityMicros: yieldResult.success.strategy.endingEquityMicros,
      events: malformedYieldEvents,
      simulation: yieldResult.success.simulation,
    })
    expectExactIssues(yieldReconciliation, [
      {
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'CashYield',
          cashYieldId: yieldEvent.id,
          field: 'annualYieldBps',
          actual: String(yieldEvent.annualYieldBps + 1),
          expected: String(yieldResult.success.simulation.executionModel.cash.annualYieldBps),
        },
      },
    ])
    const invalidElapsedEvents = yieldResult.success.events.map((event, index) =>
      index === yieldEventIndex ? { ...yieldEvent, elapsedDays: -1 } : event,
    )
    const invalidElapsed = () =>
      reconcileMarkedEquity({
        runId: yieldResult.success.runId,
        initialCapitalMicros: yieldResult.success.initialCapitalMicros,
        evaluatorTotalFeesMicros: yieldResult.success.strategy.totalFeesMicros,
        evaluatorEndingEquityMicros: yieldResult.success.strategy.endingEquityMicros,
        events: invalidElapsedEvents,
        simulation: yieldResult.success.simulation,
      })
    expect(invalidElapsed).not.toThrow()
    expectIssue(invalidElapsed(), {
      _tag: 'ComputationFailed',
      computation: expect.objectContaining({ _tag: 'CashYield', cashYieldId: yieldEvent.id }),
    })

    const markIndex = evaluation.simulation.dailyMarks.findIndex((mark) =>
      mark.positions.some((position) => position.quantityMicros !== '0'),
    )
    assert(markIndex >= 0, 'evaluation fixture must contain a marked position')
    const positionIndex = evaluation.simulation.dailyMarks[markIndex].positions.findIndex(
      (position) => position.quantityMicros !== '0',
    )
    const position = evaluation.simulation.dailyMarks[markIndex].positions[positionIndex]
    const badPosition: SimulationTrace = {
      ...evaluation.simulation,
      dailyMarks: evaluation.simulation.dailyMarks.map((mark, index) =>
        index === markIndex
          ? {
              ...mark,
              positions: mark.positions.map((candidate, candidateIndex) =>
                candidateIndex === positionIndex
                  ? {
                      ...candidate,
                      quantityMicros: (BigInt(candidate.quantityMicros) + 1n).toString(),
                      costBasisMicros: 'bad',
                      marketValueMicros: 'bad',
                    }
                  : candidate,
              ),
            }
          : mark,
      ),
    }
    const positionMark = evaluation.simulation.dailyMarks[markIndex]
    expectExactIssues(reconcile({ simulation: badPosition }), [
      {
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'PositionMark',
          sessionDate: positionMark.sessionDate,
          field: 'quantityMicros',
          symbol: position.symbol,
          actualMicros: (BigInt(position.quantityMicros) + 1n).toString(),
          expectedMicros: position.quantityMicros,
        },
      },
    ])
  })

  test('accumulates independent quantity and market-value comparisons for one position', () => {
    const markIndex = evaluation.simulation.dailyMarks.findIndex((mark) =>
      mark.positions.some((position) => position.quantityMicros !== '0'),
    )
    assert(markIndex >= 0, 'evaluation fixture must contain a marked position')
    const positionIndex = evaluation.simulation.dailyMarks[markIndex].positions.findIndex(
      (position) => position.quantityMicros !== '0',
    )
    const position = evaluation.simulation.dailyMarks[markIndex].positions[positionIndex]
    const simulation: SimulationTrace = {
      ...evaluation.simulation,
      dailyMarks: evaluation.simulation.dailyMarks.map((mark, index) =>
        index === markIndex
          ? {
              ...mark,
              positions: mark.positions.map((candidate, candidateIndex) =>
                candidateIndex === positionIndex
                  ? {
                      ...candidate,
                      quantityMicros: (BigInt(candidate.quantityMicros) + 1n).toString(),
                      marketValueMicros: (BigInt(candidate.marketValueMicros) + 1n).toString(),
                    }
                  : candidate,
              ),
            }
          : mark,
      ),
    }
    const mark = evaluation.simulation.dailyMarks[markIndex]
    expectExactIssues(reconcile({ simulation }), [
      {
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'PositionMark',
          sessionDate: mark.sessionDate,
          field: 'quantityMicros',
          symbol: position.symbol,
          actualMicros: (BigInt(position.quantityMicros) + 1n).toString(),
          expectedMicros: position.quantityMicros,
        },
      },
      {
        _tag: 'EvidenceMismatch',
        problem: {
          _tag: 'PositionMark',
          sessionDate: mark.sessionDate,
          field: 'marketValueMicros',
          symbol: position.symbol,
          actualMicros: (BigInt(position.marketValueMicros) + 1n).toString(),
          expectedMicros: position.marketValueMicros,
        },
      },
    ])
  })

  test('reaches every structural leaf in the public issue algebra', () => {
    const observed = new Set<IssueLeaf>()
    const capture = (expected: IssueLeaf, result: SimulationReconciliationResult): void => {
      assert(Result.isFailure(result), `expected ${expected} fixture to fail`)
      const actual = result.failure.map(issueLeaf)
      expect(actual).toContain(expected)
      const issue = result.failure.find((candidate) => issueLeaf(candidate) === expected)
      assert(issue !== undefined, `expected ${expected} issue`)
      expect(Object.isFrozen(issue)).toBe(true)
      if (issue._tag === 'InvalidInteger' || issue._tag === 'InvalidIdentity') {
        expect(Object.isFrozen(issue.evidence)).toBe(true)
      }
      if (issue._tag === 'InvalidIdentity') expect(Object.isFrozen(issue.problem)).toBe(true)
      if (
        issue._tag === 'MissingReference' ||
        issue._tag === 'EvidenceMismatch' ||
        issue._tag === 'InvalidEvidenceState' ||
        issue._tag === 'IncompleteEvidence'
      ) {
        expect(Object.isFrozen(issue.problem)).toBe(true)
      }
      if (
        issue._tag === 'InvalidEvidenceState' &&
        (issue.problem._tag === 'DuplicateMarkedPosition' || issue.problem._tag === 'UnsortedMarkedPositions')
      ) {
        expect(Object.isFrozen(issue.problem.symbols)).toBe(true)
      }
      if (issue._tag === 'ComputationFailed') expect(Object.isFrozen(issue.computation)).toBe(true)
      observed.add(expected)
    }

    const empty = makeEmptyInput()
    const roundTrip = makeRoundTripInput(1)
    const roundTripDecision = roundTrip.events.find((event) => event.kind === 'decision')
    const roundTripFills = roundTrip.events.filter((event) => event.kind === 'fill')
    const buyFill = roundTripFills.find((event) => event.side === 'buy')
    const sellFill = roundTripFills.find((event) => event.side === 'sell')
    assert(roundTripDecision?.kind === 'decision', 'round-trip fixture must contain a decision')
    assert(buyFill !== undefined && sellFill !== undefined, 'round-trip fixture must contain buy and sell fills')
    const firstOrder = roundTrip.simulation.orders[0]
    const firstChange = roundTrip.simulation.cashChanges[0]

    capture('InvalidInteger/unsigned-integer', reconcileMarkedEquity({ ...empty, initialCapitalMicros: 'bad' }))
    capture(
      'InvalidInteger/positive-unsigned-integer',
      reconcileMarkedEquity({
        ...empty,
        simulation: { ...empty.simulation, costMultiplierMicros: '0' },
      }),
    )
    capture(
      'InvalidInteger/signed-integer',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: {
          ...roundTrip.simulation,
          cashChanges: [{ ...firstChange, amountMicros: 'bad' }, ...roundTrip.simulation.cashChanges.slice(1)],
        },
      }),
    )
    capture('InvalidIdentity/InvalidFormat', reconcileMarkedEquity({ ...empty, runId: 'bad' }))
    capture(
      'InvalidIdentity/HashMismatch',
      reconcileMarkedEquity({
        ...roundTrip,
        events: roundTrip.events.map((event) =>
          event.id === roundTripDecision.id
            ? { ...roundTripDecision, targetWeights: { ...roundTripDecision.targetWeights, EXTRA: 1 } }
            : event,
        ),
      }),
    )
    capture(
      'InvalidIdentity/CanonicalizationFailed',
      reconcileMarkedEquity({
        ...roundTrip,
        events: roundTrip.events.map((event) =>
          event.id === roundTripDecision.id
            ? { ...roundTripDecision, targetWeights: { ...roundTripDecision.targetWeights, ['\ud800']: 0 } }
            : event,
        ),
      }),
    )

    capture(
      'MissingReference/OrderDecision',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: {
          ...roundTrip.simulation,
          orders: [{ ...firstOrder, decisionId: 'f'.repeat(64) }, ...roundTrip.simulation.orders.slice(1)],
        },
      }),
    )
    capture(
      'MissingReference/FillOrder',
      reconcileMarkedEquity({
        ...roundTrip,
        events: [...roundTrip.events, { ...buyFill, id: 'e'.repeat(64), orderId: 'd'.repeat(64) }],
      }),
    )
    capture(
      'MissingReference/MonetaryEventCashChange',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: {
          ...roundTrip.simulation,
          cashChanges: [{ ...firstChange, sourceId: 'f'.repeat(64) }, ...roundTrip.simulation.cashChanges.slice(1)],
        },
      }),
    )

    capture(
      'EvidenceMismatch/OrderExecutionSession',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: {
          ...roundTrip.simulation,
          orders: [{ ...firstOrder, sessionDate: '2026-02-02' }, ...roundTrip.simulation.orders.slice(1)],
        },
      }),
    )
    capture(
      'EvidenceMismatch/FillBinding',
      reconcileMarkedEquity({
        ...roundTrip,
        events: roundTrip.events.map((event) =>
          event.id === buyFill.id ? { ...buyFill, decisionId: 'f'.repeat(64) } : event,
        ),
      }),
    )
    capture(
      'EvidenceMismatch/FillQuantity',
      reconcileMarkedEquity({
        ...roundTrip,
        events: roundTrip.events.map((event) =>
          event.id === buyFill.id
            ? { ...buyFill, quantityMicros: (BigInt(buyFill.quantityMicros) + 1n).toString() }
            : event,
        ),
      }),
    )
    capture(
      'EvidenceMismatch/FillTerms',
      reconcileMarkedEquity({
        ...roundTrip,
        events: roundTrip.events.map((event) =>
          event.id === buyFill.id
            ? { ...buyFill, notionalMicros: (BigInt(buyFill.notionalMicros) + 1n).toString() }
            : event,
        ),
      }),
    )

    const fee = firstEvent('fee')
    const feeIndex = evaluation.events.findIndex((event) => event.id === fee.id)
    capture(
      'EvidenceMismatch/FeeComponents',
      reconcile({
        events: evaluation.events.map((event, index) =>
          index === feeIndex ? { ...fee, totalMicros: (BigInt(fee.totalMicros) + 1n).toString() } : event,
        ),
      }),
    )
    capture(
      'EvidenceMismatch/FeeSchedule',
      reconcile({
        events: evaluation.events.map((event, index) =>
          index === feeIndex
            ? {
                ...fee,
                commissionMicros: (BigInt(fee.commissionMicros) + 1n).toString(),
                totalMicros: (BigInt(fee.totalMicros) + 1n).toString(),
              }
            : event,
        ),
      }),
    )
    capture(
      'EvidenceMismatch/CashChange',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: {
          ...roundTrip.simulation,
          cashChanges: [{ ...firstChange, sourceKind: 'fee' }, ...roundTrip.simulation.cashChanges.slice(1)],
        },
      }),
    )

    const yieldProtocol: Protocol = {
      ...fixtureProtocol,
      executionModel: {
        ...fixtureProtocol.executionModel,
        cash: { ...fixtureProtocol.executionModel.cash, annualYieldBps: 50 },
      },
    }
    const yieldResult = evaluateRiskBalancedTrend(
      snapshot.bars,
      snapshot.manifest,
      yieldProtocol,
      makeTestProvenance(yieldProtocol),
    )
    assert(Result.isSuccess(yieldResult), 'cash-yield leaf fixture must evaluate')
    const yieldEvent = yieldResult.success.events.find((event) => event.kind === 'cash-yield')
    assert(yieldEvent?.kind === 'cash-yield', 'cash-yield leaf fixture must contain a yield event')
    const reconcileYield = (replacement: EvaluationEvent): SimulationReconciliationResult =>
      reconcileMarkedEquity({
        runId: yieldResult.success.runId,
        initialCapitalMicros: yieldResult.success.initialCapitalMicros,
        evaluatorTotalFeesMicros: yieldResult.success.strategy.totalFeesMicros,
        evaluatorEndingEquityMicros: yieldResult.success.strategy.endingEquityMicros,
        events: yieldResult.success.events.map((event) => (event.id === yieldEvent.id ? replacement : event)),
        simulation: yieldResult.success.simulation,
      })
    capture(
      'EvidenceMismatch/CashYield',
      reconcileYield({ ...yieldEvent, annualYieldBps: yieldEvent.annualYieldBps + 1 }),
    )
    capture(
      'EvidenceMismatch/DailyMark',
      reconcileMarkedEquity({
        ...empty,
        simulation: {
          ...empty.simulation,
          dailyMarks: [{ ...empty.simulation.dailyMarks[0], turnoverMicros: '1' }],
        },
      }),
    )
    const positionMarkIndex = evaluation.simulation.dailyMarks.findIndex((mark) => mark.positions.length > 0)
    const positionMark = evaluation.simulation.dailyMarks[positionMarkIndex]
    const markedPosition = positionMark.positions[0]
    capture(
      'EvidenceMismatch/PositionMark',
      reconcile({
        simulation: {
          ...evaluation.simulation,
          dailyMarks: evaluation.simulation.dailyMarks.map((mark, index) =>
            index === positionMarkIndex
              ? {
                  ...mark,
                  positions: [
                    {
                      ...markedPosition,
                      marketValueMicros: (BigInt(markedPosition.marketValueMicros) + 1n).toString(),
                    },
                    ...mark.positions.slice(1),
                  ],
                }
              : mark,
          ),
        },
      }),
    )

    capture(
      'InvalidEvidenceState/DuplicateIdentity',
      reconcileMarkedEquity({ ...roundTrip, events: [...roundTrip.events, roundTripDecision] }),
    )
    capture(
      'InvalidEvidenceState/DuplicateFillForOrder',
      reconcileMarkedEquity({
        ...roundTrip,
        events: [...roundTrip.events, { ...buyFill, id: 'f'.repeat(64) }],
      }),
    )
    capture(
      'InvalidEvidenceState/DuplicateCashChangeForEvent',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: {
          ...roundTrip.simulation,
          cashChanges: [...roundTrip.simulation.cashChanges, { ...firstChange, id: 'f'.repeat(64) }],
        },
      }),
    )
    capture(
      'InvalidEvidenceState/InvalidOrder',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: {
          ...roundTrip.simulation,
          orders: [
            {
              ...firstOrder,
              status: 'rejected',
              rejectionReason: 'zero-after-rounding',
              unfilledRemainder: 'canceled',
            },
            ...roundTrip.simulation.orders.slice(1),
          ],
        },
      }),
    )
    capture(
      'InvalidEvidenceState/InvalidMarkOrder',
      reconcileMarkedEquity({
        ...empty,
        simulation: {
          ...empty.simulation,
          dailyMarks: [empty.simulation.dailyMarks[0], { ...empty.simulation.dailyMarks[0] }],
        },
      }),
    )
    capture(
      'InvalidEvidenceState/DuplicateMarkedPosition',
      reconcile({
        simulation: {
          ...evaluation.simulation,
          dailyMarks: evaluation.simulation.dailyMarks.map((mark, index) =>
            index === positionMarkIndex ? { ...mark, positions: [markedPosition, markedPosition] } : mark,
          ),
        },
      }),
    )
    capture(
      'InvalidEvidenceState/UnsortedMarkedPositions',
      reconcile({
        simulation: {
          ...evaluation.simulation,
          dailyMarks: evaluation.simulation.dailyMarks.map((mark, index) =>
            index === positionMarkIndex ? { ...mark, positions: [...mark.positions].reverse() } : mark,
          ),
        },
      }),
    )
    capture('InvalidEvidenceState/NegativeCash', reconcileMarkedEquity({ ...roundTrip, initialCapitalMicros: '0' }))
    capture(
      'InvalidEvidenceState/NegativeLongPosition',
      reconcileMarkedEquity({
        ...roundTrip,
        events: [roundTripDecision, sellFill, buyFill],
      }),
    )
    capture(
      'InvalidEvidenceState/DailyOutsideTolerance',
      reconcileMarkedEquity({
        ...empty,
        simulation: {
          ...empty.simulation,
          dailyMarks: [
            {
              ...empty.simulation.dailyMarks[0],
              cashMicros: (BigInt(empty.initialCapitalMicros) + 1n).toString(),
            },
          ],
        },
      }),
    )
    capture(
      'InvalidEvidenceState/FinalOutsideTolerance',
      reconcileMarkedEquity({
        ...empty,
        evaluatorEndingEquityMicros: (BigInt(empty.evaluatorEndingEquityMicros) + 1n).toString(),
      }),
    )
    capture('InvalidEvidenceState/NegativeTolerance', reconcileMarkedEquity({ ...empty, toleranceMicros: -1n }))
    const unsupportedSimulation = { ...empty.simulation }
    expect(Reflect.set(unsupportedSimulation, 'schemaVersion', 'bayn.simulation-trace.v2')).toBe(true)
    capture(
      'InvalidEvidenceState/UnsupportedSimulationSchema',
      reconcileMarkedEquity({ ...empty, simulation: unsupportedSimulation }),
    )

    capture(
      'IncompleteEvidence/EmptyDailyMarks',
      reconcileMarkedEquity({ ...empty, simulation: { ...empty.simulation, dailyMarks: [] } }),
    )
    capture(
      'IncompleteEvidence/CashChangeCountMismatch',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: { ...roundTrip.simulation, cashChanges: roundTrip.simulation.cashChanges.slice(1) },
      }),
    )
    capture(
      'IncompleteEvidence/MissingSessionMark',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: {
          ...roundTrip.simulation,
          dailyMarks: [{ ...roundTrip.simulation.dailyMarks[0], sessionDate: '2026-02-02' }],
        },
      }),
    )
    const nonzeroPositionIndex = positionMark.positions.findIndex((position) => position.quantityMicros !== '0')
    assert(nonzeroPositionIndex >= 0, 'position leaf fixture must contain an open position')
    capture(
      'IncompleteEvidence/MissingOpenPositionMark',
      reconcile({
        simulation: {
          ...evaluation.simulation,
          dailyMarks: evaluation.simulation.dailyMarks.map((mark, index) =>
            index === positionMarkIndex
              ? {
                  ...mark,
                  positions: mark.positions.filter((_, positionIndex) => positionIndex !== nonzeroPositionIndex),
                }
              : mark,
          ),
        },
      }),
    )
    capture(
      'IncompleteEvidence/MonetaryEventsAfterFinalMark',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: {
          ...roundTrip.simulation,
          dailyMarks: [{ ...empty.simulation.dailyMarks[0], sessionDate: '2026-01-30' }],
        },
      }),
    )

    capture(
      'ComputationFailed/FillTerms',
      reconcileMarkedEquity({
        ...roundTrip,
        simulation: {
          ...roundTrip.simulation,
          executionModel: {
            ...roundTrip.simulation.executionModel,
            precision: { ...roundTrip.simulation.executionModel.precision, priceIncrementMicros: '0' },
          },
        },
      }),
    )
    capture(
      'ComputationFailed/FeeSchedule',
      reconcile({
        simulation: {
          ...evaluation.simulation,
          executionModel: {
            ...evaluation.simulation.executionModel,
            fees: { ...evaluation.simulation.executionModel.fees, roundingIncrementMicros: '0' },
          },
        },
      }),
    )
    capture('ComputationFailed/CashYield', reconcileYield({ ...yieldEvent, elapsedDays: -1 }))

    const everyLeaf = [
      'InvalidInteger/unsigned-integer',
      'InvalidInteger/positive-unsigned-integer',
      'InvalidInteger/signed-integer',
      'InvalidIdentity/InvalidFormat',
      'InvalidIdentity/HashMismatch',
      'InvalidIdentity/CanonicalizationFailed',
      'MissingReference/OrderDecision',
      'MissingReference/FillOrder',
      'MissingReference/MonetaryEventCashChange',
      'EvidenceMismatch/OrderExecutionSession',
      'EvidenceMismatch/FillBinding',
      'EvidenceMismatch/FillQuantity',
      'EvidenceMismatch/FillTerms',
      'EvidenceMismatch/FeeComponents',
      'EvidenceMismatch/FeeSchedule',
      'EvidenceMismatch/CashChange',
      'EvidenceMismatch/CashYield',
      'EvidenceMismatch/DailyMark',
      'EvidenceMismatch/PositionMark',
      'InvalidEvidenceState/DuplicateIdentity',
      'InvalidEvidenceState/DuplicateFillForOrder',
      'InvalidEvidenceState/DuplicateCashChangeForEvent',
      'InvalidEvidenceState/InvalidOrder',
      'InvalidEvidenceState/InvalidMarkOrder',
      'InvalidEvidenceState/DuplicateMarkedPosition',
      'InvalidEvidenceState/UnsortedMarkedPositions',
      'InvalidEvidenceState/NegativeCash',
      'InvalidEvidenceState/NegativeLongPosition',
      'InvalidEvidenceState/DailyOutsideTolerance',
      'InvalidEvidenceState/FinalOutsideTolerance',
      'InvalidEvidenceState/NegativeTolerance',
      'InvalidEvidenceState/UnsupportedSimulationSchema',
      'IncompleteEvidence/EmptyDailyMarks',
      'IncompleteEvidence/CashChangeCountMismatch',
      'IncompleteEvidence/MissingSessionMark',
      'IncompleteEvidence/MissingOpenPositionMark',
      'IncompleteEvidence/MonetaryEventsAfterFinalMark',
      'ComputationFailed/FillTerms',
      'ComputationFailed/FeeSchedule',
      'ComputationFailed/CashYield',
    ] as const satisfies readonly IssueLeaf[]
    expect(everyLeaf).toHaveLength(40)
    expect(new Set(everyLeaf).size).toBe(everyLeaf.length)
    expect([...observed].sort()).toEqual([...everyLeaf].sort())
  })

  test('classifies lineage, schedule, completeness, and tolerance failures', () => {
    const fill = firstEvent('fill')
    const changedNotional = { ...fill, notionalMicros: (BigInt(fill.notionalMicros) + 20_000n).toString() }
    const { id: _, kind: __, ...fillPayload } = changedNotional
    const events = evaluation.events.map((event) =>
      event.id === fill.id
        ? { ...changedNotional, id: canonicalHashV1({ runId: evaluation.runId, kind: 'fill', ...fillPayload }) }
        : event,
    )
    expectIssue(reconcile({ events }), {
      _tag: 'EvidenceMismatch',
      problem: expect.objectContaining({ _tag: 'FillTerms', field: 'notionalMicros' }),
    })

    const duplicateOrder: SimulationTrace = {
      ...evaluation.simulation,
      orders: [...evaluation.simulation.orders, evaluation.simulation.orders[0]],
    }
    expectIssue(reconcile({ simulation: duplicateOrder }), {
      _tag: 'InvalidEvidenceState',
      problem: expect.objectContaining({ _tag: 'DuplicateIdentity', entity: 'order' }),
    })

    const missingMark: SimulationTrace = {
      ...evaluation.simulation,
      dailyMarks: evaluation.simulation.dailyMarks.filter((mark) => mark.sessionDate !== fill.sessionDate),
    }
    expectIssue(reconcile({ simulation: missingMark }), {
      _tag: 'IncompleteEvidence',
      problem: expect.objectContaining({ _tag: 'MissingSessionMark' }),
    })

    const baseline = reconcile()
    assert(Result.isSuccess(baseline), 'baseline must reconcile successfully')
    const reconstructed = BigInt(baseline.success.reconciliation.reconstructedEndingEquityMicros)
    const atBoundary = reconcile({
      evaluatorEndingEquityMicros: (reconstructed + MARKED_EQUITY_TOLERANCE_MICROS).toString(),
    })
    assert(Result.isSuccess(atBoundary), 'declared tolerance boundary must succeed')
    expectIssue(
      reconcile({
        evaluatorEndingEquityMicros: (reconstructed + MARKED_EQUITY_TOLERANCE_MICROS + 1n).toString(),
      }),
      {
        _tag: 'InvalidEvidenceState',
        problem: expect.objectContaining({ _tag: 'FinalOutsideTolerance', measure: 'final-equity' }),
      },
    )
  })
})
