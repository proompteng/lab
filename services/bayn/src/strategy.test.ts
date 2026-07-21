import { describe, expect, test } from 'bun:test'

import { makeStrategyProtocolHash } from './contracts'
import { calculatePerformanceMetrics, evaluateTsmom, makeTsmomDecision, prepareTsmomQualification } from './strategy'
import { canonicalHashV1 } from './hash'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'
import type { FillEvent } from './types'

describe('TSMOM economic evaluator', () => {
  test('uses one pure content-addressed decision function', () => {
    const protocol = { ...fixtureProtocol, lookbacks: [1, 2] }
    const closes = Object.fromEntries(
      protocol.universe.map((symbol, index) => [
        symbol,
        index === 0 ? [100, 90, 110] : index === 1 ? [100, 120, 110] : [120, 110, 100],
      ]),
    )
    const decision = makeTsmomDecision('2026-07-17', closes, protocol)

    expect(decision.signals[0]).toMatchObject({ symbol: 'DBC', score: 2, active: true, targetWeight: 1 })
    expect(decision.signals[1]).toMatchObject({ symbol: 'EEM', score: 0, active: false, targetWeight: 0 })
    expect(Object.values(decision.targetWeights).reduce((sum, weight) => sum + weight, 0)).toBe(1)
    expect(canonicalHashV1(decision)).toBe('3f2a2f3484e66ee13e96fed0b88d9b03b4f1de3084a93a841bfa1a160db587b7')
  })

  test('includes the initial trading session in return statistics', () => {
    const result = calculatePerformanceMetrics([90, 99], 0, 0, 100)
    expect(result.totalReturn).toBeCloseTo(-0.01)
    expect(result.annualizedVolatility).toBeCloseTo(Math.sqrt(0.02) * Math.sqrt(252))
    expect(result.sharpe).toBeCloseTo(0)
  })

  test('is deterministic, costed, and executes after the signal session', () => {
    const snapshot = makeSnapshot()
    const provenance = makeTestProvenance()
    const first = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
    const second = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
    expect(first).toEqual(second)
    expect(canonicalHashV1(first)).toBe('7c223f7d02215f5b2982bee51a0ae9107d319014a52634a772814672fde2ccd3')
    expect(canonicalHashV1(first.signalDecisions)).toBe(canonicalHashV1(second.signalDecisions))
    expect(canonicalHashV1(first.simulation.dailyMarks)).toBe(canonicalHashV1(second.simulation.dailyMarks))
    expect(canonicalHashV1(first.benchmarkSeries)).toBe(canonicalHashV1(second.benchmarkSeries))
    expect(first.codeRevision).toBe(provenance.sourceRevision)
    expect(first.protocolHash).toBe(makeStrategyProtocolHash(provenance.strategy))
    expect(first.strategy.observations).toBeGreaterThanOrEqual(fixtureProtocol.thresholds.minimumObservations)
    expect(BigInt(first.strategy.totalFeesMicros)).toBeGreaterThan(0n)
    expect(BigInt(first.strategy.totalSpreadCostMicros)).toBeGreaterThan(0n)
    expect(BigInt(first.strategy.totalSlippageCostMicros)).toBeGreaterThan(0n)
    expect(first.doubleCostStrategy.endingEquityMicros).not.toBe(first.strategy.endingEquityMicros)
    const firstDecision = first.events.find((event) => event.kind === 'decision')
    expect(firstDecision?.kind).toBe('decision')
    if (firstDecision?.kind === 'decision') {
      expect(firstDecision.executionDate > firstDecision.signalDate).toBe(true)
      const fills = first.events.filter(
        (event): event is FillEvent => event.kind === 'fill' && event.decisionId === firstDecision.id,
      )
      expect(fills.length).toBeGreaterThan(0)
      expect(fills.every((fill) => fill.sessionDate === firstDecision.executionDate)).toBe(true)
      expect(first.signalDecisions.find((decision) => decision.decisionId === firstDecision.id)).toMatchObject({
        signalDate: firstDecision.signalDate,
        executionDate: firstDecision.executionDate,
        targetWeights: firstDecision.targetWeights,
      })
    }
  })

  test('precommits the exact evaluation window from calendar dates without price access', () => {
    const snapshot = makeSnapshot()
    const provenance = makeTestProvenance()
    const sessionDates = [...new Set(snapshot.bars.map((bar) => bar.sessionDate))].sort()
    const precommit = prepareTsmomQualification(sessionDates, snapshot.manifest, fixtureProtocol, provenance)
    const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)

    expect(precommit.candidateRunId).toBe(evaluation.runId)
    expect(precommit.protocolHash).toBe(evaluation.protocolHash)
    expect(precommit.selectedSessionCount).toBe(evaluation.simulation.dailyMarks.length)
    expect(precommit.selectedRebalanceCount).toBe(evaluation.signalDecisions.length)
    expect(precommit.signalDates).toEqual(evaluation.signalDecisions.map((decision) => decision.signalDate))
    expect(precommit.executionDates).toEqual(evaluation.signalDecisions.map((decision) => decision.executionDate))
  })

  test('changes run identity when source, image, behavior, input, or parameters change', () => {
    const snapshot = makeSnapshot()
    const baseline = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance())
    const sourceChanged = evaluateTsmom(
      snapshot.bars,
      snapshot.manifest,
      fixtureProtocol,
      makeTestProvenance(fixtureProtocol, { sourceRevision: 'd'.repeat(40) }),
    )
    const imageChanged = evaluateTsmom(
      snapshot.bars,
      snapshot.manifest,
      fixtureProtocol,
      makeTestProvenance(fixtureProtocol, { imageDigest: `sha256:${'e'.repeat(64)}` }),
    )
    const behaviorChanged = evaluateTsmom(
      snapshot.bars,
      snapshot.manifest,
      fixtureProtocol,
      makeTestProvenance(fixtureProtocol, { behaviorHash: 'f'.repeat(64) }),
    )
    const changedProtocol = {
      ...fixtureProtocol,
      executionModel: {
        ...fixtureProtocol.executionModel,
        priceImpact: {
          ...fixtureProtocol.executionModel.priceImpact,
          slippageBps: fixtureProtocol.executionModel.priceImpact.slippageBps + 1,
        },
      },
    }
    const protocolChanged = evaluateTsmom(
      snapshot.bars,
      snapshot.manifest,
      changedProtocol,
      makeTestProvenance(changedProtocol),
    )
    const { hash: _, ...changedInputMaterial } = {
      ...snapshot.manifest,
      finalizedSnapshot: {
        ...snapshot.manifest.finalizedSnapshot,
        contentHash: '9'.repeat(64),
      },
    }
    const inputChanged = evaluateTsmom(
      snapshot.bars,
      { ...changedInputMaterial, hash: canonicalHashV1(changedInputMaterial) },
      fixtureProtocol,
      makeTestProvenance(),
    )
    expect(sourceChanged.runId).not.toBe(baseline.runId)
    expect(imageChanged.runId).not.toBe(baseline.runId)
    expect(behaviorChanged.runId).not.toBe(baseline.runId)
    expect(behaviorChanged.protocolHash).not.toBe(baseline.protocolHash)
    expect(protocolChanged.runId).not.toBe(baseline.runId)
    expect(protocolChanged.protocolHash).not.toBe(baseline.protocolHash)
    expect(inputChanged.runId).not.toBe(baseline.runId)
    const outcomes = (evaluation: typeof baseline) =>
      evaluation.simulation.orders.map(({ id: _, decisionId: __, ...outcome }) => outcome)
    expect(sourceChanged.strategy).toEqual(baseline.strategy)
    expect(imageChanged.strategy).toEqual(baseline.strategy)
    expect(behaviorChanged.strategy).toEqual(baseline.strategy)
    expect(outcomes(sourceChanged)).toEqual(outcomes(baseline))
    expect(outcomes(imageChanged)).toEqual(outcomes(baseline))
    expect(outcomes(behaviorChanged)).toEqual(outcomes(baseline))
  })

  test('rejects a false parameter attribution before evaluation', () => {
    const snapshot = makeSnapshot()
    const changedProtocol = {
      ...fixtureProtocol,
      executionModel: {
        ...fixtureProtocol.executionModel,
        priceImpact: {
          ...fixtureProtocol.executionModel.priceImpact,
          slippageBps: fixtureProtocol.executionModel.priceImpact.slippageBps + 1,
        },
      },
    }

    expect(() => evaluateTsmom(snapshot.bars, snapshot.manifest, changedProtocol, makeTestProvenance())).toThrow(
      'parameter hash does not match',
    )
  })

  test('fails before evaluation when comparable history is insufficient', () => {
    const snapshot = makeSnapshot(700)
    expect(() => evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance())).toThrow(
      'comparable observations',
    )
  })

  test('rejects an incomplete session instead of silently filtering it out', () => {
    const snapshot = makeSnapshot()
    const incomplete = snapshot.bars.filter(
      (bar) => !(bar.symbol === fixtureProtocol.universe[0] && bar.sessionDate === snapshot.manifest.firstSession),
    )
    expect(() => evaluateTsmom(incomplete, snapshot.manifest, fixtureProtocol, makeTestProvenance())).toThrow(
      'row count does not match manifest',
    )
  })

  test('retains complete aligned daily and rebalance evidence for a production-sized history', () => {
    const snapshot = makeSnapshot(2_400)
    const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance())
    const serializedEvidence = JSON.stringify({
      events: evaluation.events,
      simulation: evaluation.simulation,
      equitySeries: evaluation.equitySeries,
    })

    expect(evaluation.simulation.dailyMarks).toHaveLength(evaluation.strategy.observations)
    expect(evaluation.equitySeries).toHaveLength(evaluation.strategy.observations)
    expect(evaluation.signalDecisions).toHaveLength(
      evaluation.events.filter((event) => event.kind === 'decision').length,
    )
    for (const series of Object.values(evaluation.benchmarkSeries)) {
      expect(series.map((point) => point.sessionDate)).toEqual(
        evaluation.simulation.dailyMarks.map((point) => point.sessionDate),
      )
    }
    expect(
      evaluation.simulation.dailyMarks.every(
        (point) =>
          Number.isFinite(point.netReturn) &&
          Number.isFinite(point.drawdown) &&
          BigInt(point.cumulativeTurnoverMicros) >= BigInt(point.turnoverMicros) &&
          BigInt(point.cumulativeFeesMicros) >= BigInt(point.feeMicros),
      ),
    ).toBe(true)
    expect(Buffer.byteLength(serializedEvidence)).toBeLessThan(10 * 1024 * 1024)
  })

  test('accrues and reconciles an explicitly nonzero cash yield without changing authority', () => {
    const protocol = {
      ...fixtureProtocol,
      executionModel: {
        ...fixtureProtocol.executionModel,
        cash: { ...fixtureProtocol.executionModel.cash, annualYieldBps: 500 },
      },
    }
    const snapshot = makeSnapshot(800)
    const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, protocol, makeTestProvenance(protocol))
    const yieldEvents = evaluation.events.filter((event) => event.kind === 'cash-yield')

    expect(yieldEvents.length).toBeGreaterThan(0)
    expect(evaluation.strategy.totalCashYieldMicros).toBe(
      yieldEvents.reduce((sum, event) => sum + BigInt(event.amountMicros), 0n).toString(),
    )
    expect(evaluation.markedEquityReconciliation.exact).toBe(true)
    expect(evaluation.simulation.cashChanges.filter((change) => change.sourceKind === 'cash-yield')).toHaveLength(
      yieldEvents.length,
    )
  })
})
