import { describe, expect, test } from 'bun:test'

import { MARKED_EQUITY_TOLERANCE_MICROS, reconcileMarkedEquity } from './simulation-reconciliation'
import { canonicalHashV1 } from './hash'
import { evaluateRiskBalancedTrend } from './risk-balanced-trend'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'
import type { EvaluationEvent, SimulationTrace } from './types'

const evaluation = (() => {
  const snapshot = makeSnapshot(800)
  return evaluateRiskBalancedTrend(
    snapshot.bars,
    snapshot.manifest,
    fixtureProtocol,
    makeTestProvenance(fixtureProtocol),
  )
})()

const reconcile = (
  overrides: {
    readonly events?: readonly EvaluationEvent[]
    readonly simulation?: SimulationTrace
    readonly evaluatorEndingEquityMicros?: string
    readonly evaluatorTotalFeesMicros?: string
  } = {},
) =>
  reconcileMarkedEquity({
    runId: evaluation.runId,
    initialCapitalMicros: evaluation.initialCapitalMicros,
    evaluatorTotalFeesMicros: overrides.evaluatorTotalFeesMicros ?? evaluation.strategy.totalFeesMicros,
    evaluatorEndingEquityMicros: overrides.evaluatorEndingEquityMicros ?? evaluation.strategy.endingEquityMicros,
    events: overrides.events ?? evaluation.events,
    simulation: overrides.simulation ?? evaluation.simulation,
  })

describe('independent marked-equity reconciliation', () => {
  test('reconstructs every daily point from orders, fills, cash, positions, and close marks', () => {
    const proof = reconcile()
    const fills = evaluation.events.filter((event) => event.kind === 'fill')

    expect(proof).toEqual({
      reconciliation: evaluation.markedEquityReconciliation,
      equitySeries: evaluation.equitySeries,
    })
    expect(proof.equitySeries).toHaveLength(evaluation.strategy.observations)
    expect(evaluation.simulation.orders.length).toBeGreaterThanOrEqual(fills.length)
    expect(evaluation.simulation.cashChanges).toHaveLength(
      evaluation.events.filter((event) => event.kind !== 'decision').length,
    )
    expect(evaluation.simulation.dailyMarks).toHaveLength(evaluation.strategy.observations)
    expect(proof.reconciliation.withinTolerance).toBe(true)
    expect(BigInt(proof.reconciliation.maximumDailyDifferenceMicros)).toBeLessThanOrEqual(
      MARKED_EQUITY_TOLERANCE_MICROS,
    )
  })

  test('rejects cash, fill, mark, lineage, and completeness tampering', () => {
    const firstChange = evaluation.simulation.cashChanges[0]
    const badCash: SimulationTrace = {
      ...evaluation.simulation,
      cashChanges: evaluation.simulation.cashChanges.map((change, index) =>
        index === 0 ? { ...change, amountMicros: (BigInt(firstChange.amountMicros) + 1n).toString() } : change,
      ),
    }
    expect(() => reconcile({ simulation: badCash })).toThrow('cash change')

    const firstFillIndex = evaluation.events.findIndex((event) => event.kind === 'fill')
    const firstFill = evaluation.events[firstFillIndex]
    if (firstFill.kind !== 'fill') throw new Error('fixture has no fill')
    const badFill = evaluation.events.map((event, index) =>
      index === firstFillIndex
        ? { ...firstFill, quantityMicros: (BigInt(firstFill.quantityMicros) + 1n).toString() }
        : event,
    )
    expect(() => reconcile({ events: badFill })).toThrow('order')

    const secondFillIndex = evaluation.events.findIndex(
      (event, index) => index > firstFillIndex && event.kind === 'fill',
    )
    const secondFill = evaluation.events[secondFillIndex]
    if (secondFill.kind !== 'fill') throw new Error('fixture has only one fill')
    const duplicateFillForOrder = evaluation.events.map((event, index) =>
      index === secondFillIndex ? { ...secondFill, orderId: firstFill.orderId } : event,
    )
    expect(() => reconcile({ events: duplicateFillForOrder })).toThrow('multiple fills')

    const changedNotionalPayload = {
      ...firstFill,
      notionalMicros: (BigInt(firstFill.notionalMicros) + 20_000n).toString(),
    }
    const { id: _, kind: __, ...fillIdentityPayload } = changedNotionalPayload
    const badNotional = evaluation.events.map((event, index) =>
      index === firstFillIndex
        ? {
            ...changedNotionalPayload,
            id: canonicalHashV1({ runId: evaluation.runId, kind: 'fill', ...fillIdentityPayload }),
          }
        : event,
    )
    expect(() => reconcile({ events: badNotional })).toThrow('notional diverges')

    const firstFeeIndex = evaluation.events.findIndex((event) => event.kind === 'fee')
    const firstFee = evaluation.events[firstFeeIndex]
    if (firstFee.kind !== 'fee') throw new Error('fixture has no fee event')
    const changedFeePayload = {
      ...firstFee,
      secMicros: (BigInt(firstFee.secMicros) + 10_000n).toString(),
      totalMicros: (BigInt(firstFee.totalMicros) + 10_000n).toString(),
    }
    const { id: ___, kind: ____, ...feeIdentityPayload } = changedFeePayload
    const badFee = evaluation.events.map((event, index) =>
      index === firstFeeIndex
        ? {
            ...changedFeePayload,
            id: canonicalHashV1({ runId: evaluation.runId, kind: 'fee', ...feeIdentityPayload }),
          }
        : event,
    )
    expect(() => reconcile({ events: badFee })).toThrow('SEC component diverges')

    expect(() =>
      reconcile({
        evaluatorTotalFeesMicros: (
          BigInt(evaluation.strategy.totalFeesMicros) +
          MARKED_EQUITY_TOLERANCE_MICROS +
          1n
        ).toString(),
      }),
    ).toThrow('reconstructed fees exceed')

    const duplicateOrder: SimulationTrace = {
      ...evaluation.simulation,
      orders: [...evaluation.simulation.orders, evaluation.simulation.orders[0]],
    }
    expect(() => reconcile({ simulation: duplicateOrder })).toThrow('duplicate ID')

    const firstMarkedPosition = evaluation.simulation.dailyMarks.findIndex((mark) =>
      mark.positions.some((position) => position.quantityMicros !== '0'),
    )
    const badMark: SimulationTrace = {
      ...evaluation.simulation,
      dailyMarks: evaluation.simulation.dailyMarks.map((mark, index) =>
        index === firstMarkedPosition
          ? {
              ...mark,
              positions: mark.positions.map((position, positionIndex) =>
                positionIndex === 0
                  ? { ...position, marketValueMicros: (BigInt(position.marketValueMicros) + 20_000n).toString() }
                  : position,
              ),
            }
          : mark,
      ),
    }
    expect(() => reconcile({ simulation: badMark })).toThrow('position value')

    const badQuantity: SimulationTrace = {
      ...evaluation.simulation,
      dailyMarks: evaluation.simulation.dailyMarks.map((mark, index) =>
        index === firstMarkedPosition
          ? {
              ...mark,
              positions: mark.positions.map((position, positionIndex) =>
                positionIndex === 0
                  ? { ...position, quantityMicros: (BigInt(position.quantityMicros) + 1_000n).toString() }
                  : position,
              ),
            }
          : mark,
      ),
    }
    expect(() => reconcile({ simulation: badQuantity })).toThrow('position quantity')

    const fillSession = firstFill.sessionDate
    const missingMark: SimulationTrace = {
      ...evaluation.simulation,
      dailyMarks: evaluation.simulation.dailyMarks.filter((mark) => mark.sessionDate !== fillSession),
    }
    expect(() => reconcile({ simulation: missingMark })).toThrow('has no mark for its session')
  })

  test('enforces the declared final-equity tolerance at the micro boundary', () => {
    const baseline = reconcile()
    const reconstructed = BigInt(baseline.reconciliation.reconstructedEndingEquityMicros)
    const atBoundary = reconcile({
      evaluatorEndingEquityMicros: (reconstructed + MARKED_EQUITY_TOLERANCE_MICROS).toString(),
    })
    expect(atBoundary.reconciliation.differenceMicros).toBe(MARKED_EQUITY_TOLERANCE_MICROS.toString())
    expect(() =>
      reconcile({
        evaluatorEndingEquityMicros: (reconstructed + MARKED_EQUITY_TOLERANCE_MICROS + 1n).toString(),
      }),
    ).toThrow('final marked equity exceeds')
  })
})
