import { describe, expect, test } from 'bun:test'

import { calculatePerformanceMetrics, evaluateTsmom } from './strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'
import type { FillEvent } from './types'

describe('TSMOM economic evaluator', () => {
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
    expect(first.codeRevision).toBe(provenance.sourceRevision)
    expect(first.protocolHash).toBe(provenance.strategy.parameterHash)
    expect(first.strategy.observations).toBeGreaterThanOrEqual(fixtureProtocol.thresholds.minimumObservations)
    expect(BigInt(first.strategy.totalFeesMicros)).toBeGreaterThan(0n)
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
    }
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
    const changedProtocol = { ...fixtureProtocol, transactionCostBps: fixtureProtocol.transactionCostBps + 1 }
    const protocolChanged = evaluateTsmom(
      snapshot.bars,
      snapshot.manifest,
      changedProtocol,
      makeTestProvenance(changedProtocol),
    )
    expect(sourceChanged.runId).not.toBe(baseline.runId)
    expect(imageChanged.runId).not.toBe(baseline.runId)
    expect(behaviorChanged.runId).not.toBe(baseline.runId)
    expect(protocolChanged.runId).not.toBe(baseline.runId)
  })

  test('rejects a false parameter attribution before evaluation', () => {
    const snapshot = makeSnapshot()
    const changedProtocol = { ...fixtureProtocol, transactionCostBps: fixtureProtocol.transactionCostBps + 1 }

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
})
