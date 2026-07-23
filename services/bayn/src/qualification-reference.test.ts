import { describe, expect, test } from 'bun:test'

import { canonicalHashV1 } from './hash'
import { evaluateReference } from './audit/reference'
import { evaluateRiskBalancedTrend } from './risk-balanced-trend'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

describe('independent qualification reference', () => {
  test('reproduces every persisted strategy and benchmark artifact', () => {
    const snapshot = makeSnapshot(900)
    const provenance = makeTestProvenance()
    const actual = evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
    const reference = evaluateReference(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)

    expect(reference.runId).toBe(actual.runId)
    expect(reference.protocolHash).toBe(actual.protocolHash)
    expect(reference.strategy.metrics).toEqual(actual.strategy)
    expect(reference.buyAndHold.metrics).toEqual(actual.buyAndHold)
    expect(reference.directVolTiming.metrics).toEqual(actual.directVolTiming)
    expect(reference.doubleCostStrategy.metrics).toEqual(actual.doubleCostStrategy)
    expect(reference.verdict).toEqual(actual.verdict)
    expect(reference.strategy.events).toEqual(actual.events)
    expect(reference.strategy.decisions).toEqual(actual.signalDecisions)
    expect(reference.strategy.trace).toEqual(actual.simulation)
    expect(reference.buyAndHold.daily).toEqual(actual.benchmarkSeries.buyAndHold)
    expect(reference.directVolTiming.daily).toEqual(actual.benchmarkSeries.directVolTiming)
    expect(reference.doubleCostStrategy.daily).toEqual(actual.benchmarkSeries.doubleCostStrategy)
  })

  test('binds the result to raw market data', () => {
    const snapshot = makeSnapshot(900)
    const provenance = makeTestProvenance()
    const original = evaluateReference(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
    const bars = snapshot.bars.map((bar, index) => (index === 4_000 ? { ...bar, close: bar.close * 1.5 } : bar))
    const changed = evaluateReference(bars, snapshot.manifest, fixtureProtocol, provenance)

    expect(canonicalHashV1(changed.strategy.decisions)).not.toBe(canonicalHashV1(original.strategy.decisions))
  })

  test('independently keeps planned quantities invariant to future execution OHLC', () => {
    const snapshot = makeSnapshot(900)
    const provenance = makeTestProvenance()
    const actual = evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
    const executionDate = actual.signalDecisions[0].executionDate
    const changedBars = snapshot.bars.map((bar) => {
      if (bar.sessionDate !== executionDate) return bar
      const open = bar.open * 1.5
      const close = bar.close * 1.2
      return {
        ...bar,
        open,
        high: Math.max(open, close, bar.high * 1.1),
        low: Math.min(open, close, bar.low * 0.8),
        close,
      }
    })
    const changedActual = evaluateRiskBalancedTrend(changedBars, snapshot.manifest, fixtureProtocol, provenance)
    const changedReference = evaluateReference(changedBars, snapshot.manifest, fixtureProtocol, provenance)
    const requests = (orders: typeof actual.simulation.orders) =>
      orders
        .filter((order) => order.sessionDate === executionDate)
        .map(({ decisionId, sessionDate, symbol, side, requestedQuantityMicros }) => ({
          decisionId,
          sessionDate,
          symbol,
          side,
          requestedQuantityMicros,
        }))

    expect(requests(changedActual.simulation.orders)).toEqual(requests(actual.simulation.orders))
    expect(requests(changedReference.strategy.trace?.orders ?? [])).toEqual(requests(actual.simulation.orders))
    expect(changedActual.strategy.endingEquityMicros).not.toBe(actual.strategy.endingEquityMicros)
    expect(changedReference.strategy.trace).toEqual(changedActual.simulation)
  })
})
