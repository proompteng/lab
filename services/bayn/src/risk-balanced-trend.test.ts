import { describe, expect, test } from 'bun:test'

import { canonicalHashV1 } from './hash'
import {
  evaluateRiskBalancedTrend,
  makeRiskBalancedTrendDecision,
  prepareRiskBalancedTrendQualification,
} from './risk-balanced-trend'
import { makeRiskBalancedTrendTestProvenance, makeSnapshot, riskBalancedTrendFixtureProtocol } from './test-fixtures'
import type { IsoDate, RiskBalancedTrendProtocol } from './types'

const shortProtocol = (overrides: Partial<RiskBalancedTrendProtocol> = {}): RiskBalancedTrendProtocol => ({
  ...riskBalancedTrendFixtureProtocol,
  universe: ['DBC', 'EEM', 'EFA'],
  horizons: [1, 2],
  volatilityWindow: 2,
  maximumSymbolWeight: 0.35,
  maximumPortfolioVolatility: 0.1,
  ...overrides,
})

describe('risk-balanced trend candidate', () => {
  test('normalizes continuous trend, retains cash under cap capacity, and scales portfolio volatility', () => {
    const protocol = shortProtocol({ maximumPortfolioVolatility: 0.05 })
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17'] as const satisfies readonly IsoDate[]
    const decision = makeRiskBalancedTrendDecision(
      dates[2],
      dates,
      {
        DBC: [100, 101, 105],
        EEM: [100, 102, 103],
        EFA: [100, 99, 98],
      },
      protocol,
    )

    expect(decision.schemaVersion).toBe('bayn.risk-balanced-trend-decision-plan.v1')
    expect(decision.signals.map((signal) => signal.symbol)).toEqual([...protocol.universe])
    expect(decision.signals.find((signal) => signal.symbol === 'EFA')?.positiveScore).toBe(0)
    expect(decision.signals.filter((signal) => signal.positiveScore > 0).map((signal) => signal.cappedWeight)).toEqual([
      0.35, 0.35,
    ])
    expect(Object.values(decision.targetWeights).reduce((total, weight) => total + weight, 0)).toBeLessThanOrEqual(0.7)
    expect(decision.estimatedAnnualizedPortfolioVolatility).toBeGreaterThan(0.05)
    expect(decision.exposureScale).toBeLessThan(1)
    expect(decision.covarianceWindow).toMatchObject({
      returnCount: 2,
      firstSession: '2026-07-16',
      lastSession: '2026-07-17',
    })
    expect(canonicalHashV1(decision)).toMatch(/^[a-f0-9]{64}$/)
  })

  test('makes zero-volatility symbols explicitly ineligible and fails on malformed closes', () => {
    const protocol = shortProtocol({ maximumPortfolioVolatility: 1 })
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17'] as const satisfies readonly IsoDate[]
    const decision = makeRiskBalancedTrendDecision(
      dates[2],
      dates,
      {
        DBC: [100, 100, 100],
        EEM: [100, 101, 102],
        EFA: [100, 99, 98],
      },
      protocol,
    )

    expect(decision.signals[0]).toMatchObject({
      symbol: 'DBC',
      eligible: false,
      dailyVolatility: 0,
      compositeScore: 0,
      positiveScore: 0,
      targetWeight: 0,
    })
    expect(() =>
      makeRiskBalancedTrendDecision(
        dates[2],
        dates,
        { DBC: [100, Number.NaN, 100], EEM: [100, 101, 102], EFA: [100, 99, 98] },
        protocol,
      ),
    ).toThrow('invalid close')
  })

  test('evaluates deterministically with complete evidence and a calendar-only precommit', () => {
    const snapshot = makeSnapshot()
    const provenance = makeRiskBalancedTrendTestProvenance()
    const first = evaluateRiskBalancedTrend(
      snapshot.bars,
      snapshot.manifest,
      riskBalancedTrendFixtureProtocol,
      provenance,
    )
    const second = evaluateRiskBalancedTrend(
      snapshot.bars,
      snapshot.manifest,
      riskBalancedTrendFixtureProtocol,
      provenance,
    )
    const sessionDates = [...new Set(snapshot.bars.map((bar) => bar.sessionDate))].sort()
    const precommit = prepareRiskBalancedTrendQualification(
      sessionDates,
      snapshot.manifest,
      riskBalancedTrendFixtureProtocol,
      provenance,
    )

    expect(first).toEqual(second)
    expect(first.schemaVersion).toBe('bayn.evaluation.v5')
    expect(first.signalDecisions).toHaveLength(first.events.filter((event) => event.kind === 'decision').length)
    expect(first.simulation.dailyMarks).toHaveLength(first.strategy.observations)
    expect(first.equitySeries).toHaveLength(first.strategy.observations)
    expect(first.markedEquityReconciliation.exact).toBe(true)
    expect(
      first.signalDecisions.every((decision) => decision.schemaVersion === 'bayn.risk-balanced-trend-decision-plan.v1'),
    ).toBe(true)
    expect(precommit).toMatchObject({
      candidateRunId: first.runId,
      protocolHash: first.protocolHash,
      selectedSessionCount: first.strategy.observations,
      selectedRebalanceCount: first.signalDecisions.length,
    })
    expect(precommit.signalDates).toEqual(first.signalDecisions.map((decision) => decision.signalDate))
    expect(precommit.executionDates).toEqual(first.signalDecisions.map((decision) => decision.executionDate))
    expect(canonicalHashV1(first)).toBe('3a42d8484f680b4a06a35b287cff14546d3a6f17297c2ae16ea098527e5e0aa8')
    expect(canonicalHashV1(first.signalDecisions)).toBe(
      '10be1e9303a1863cb1d721e5bfe2ec0c854043c4d39656ed9bf191c0dd989acc',
    )
  })
})
