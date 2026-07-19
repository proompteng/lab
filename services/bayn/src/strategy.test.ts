import { describe, expect, test } from 'bun:test'

import { defaultProtocol } from './protocol'
import { evaluateTsmom } from './strategy'
import { makeSnapshot } from './test-fixtures'
import type { FillEvent } from './types'

describe('TSMOM economic evaluator', () => {
  test('is deterministic, costed, and executes after the signal session', () => {
    const snapshot = makeSnapshot()
    const first = evaluateTsmom(snapshot.bars, snapshot.manifest, defaultProtocol, 'test-revision')
    const second = evaluateTsmom(snapshot.bars, snapshot.manifest, defaultProtocol, 'test-revision')
    expect(first).toEqual(second)
    expect(first.strategy.observations).toBeGreaterThanOrEqual(defaultProtocol.thresholds.minimumObservations)
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

  test('changes run identity when code, input, or protocol changes', () => {
    const snapshot = makeSnapshot()
    const baseline = evaluateTsmom(snapshot.bars, snapshot.manifest, defaultProtocol, 'revision-a')
    const codeChanged = evaluateTsmom(snapshot.bars, snapshot.manifest, defaultProtocol, 'revision-b')
    const protocolChanged = evaluateTsmom(
      snapshot.bars,
      snapshot.manifest,
      { ...defaultProtocol, transactionCostBps: defaultProtocol.transactionCostBps + 1 },
      'revision-a',
    )
    expect(codeChanged.runId).not.toBe(baseline.runId)
    expect(protocolChanged.runId).not.toBe(baseline.runId)
  })

  test('fails before evaluation when comparable history is insufficient', () => {
    const snapshot = makeSnapshot(700)
    expect(() => evaluateTsmom(snapshot.bars, snapshot.manifest, defaultProtocol, 'test-revision')).toThrow(
      'comparable observations',
    )
  })
})
