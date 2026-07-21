import { describe, expect, test } from 'bun:test'

import { canonicalHashV1 } from './hash'
import {
  evaluateRiskBalancedTrend,
  makeRiskBalancedTrendDecision,
  prepareRiskBalancedTrendQualification,
} from './risk-balanced-trend'
import { makeRiskBalancedTrendStrategy } from './strategy-service'
import {
  makeRiskBalancedTrendSnapshot,
  makeRiskBalancedTrendTestProvenance,
  riskBalancedTrendFixtureProtocol,
} from './test-fixtures'
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
  test('matches a hand-calculated multi-symbol continuous normalized trend', () => {
    const protocol = shortProtocol({
      horizons: [1],
      volatilityWindow: 2,
      maximumSymbolWeight: 1,
      maximumPortfolioVolatility: 1,
    })
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17'] as const satisfies readonly IsoDate[]
    const decision = makeRiskBalancedTrendDecision(
      dates[2],
      dates,
      {
        DBC: [100, 101, 103.02],
        EEM: [100, 102, 103.02],
        EFA: [100, 99, 97.02],
      },
      protocol,
    )
    const [dbc, eem, efa] = decision.signals

    expect(dbc.dailyVolatility).toBeCloseTo(Math.sqrt(0.00005), 12)
    expect(dbc.horizons[0]).toMatchObject({ horizonSessions: 1 })
    expect(dbc.horizons[0].return).toBeCloseTo(0.02, 12)
    expect(dbc.horizons[0].normalizedTrend).toBeCloseTo(Math.sqrt(8), 12)
    expect(eem.horizons[0].return).toBeCloseTo(0.01, 12)
    expect(eem.horizons[0].normalizedTrend).toBeCloseTo(Math.sqrt(2), 12)
    expect(dbc.positiveScore).toBeGreaterThan(eem.positiveScore)
    expect(efa.compositeScore).toBeCloseTo(-Math.sqrt(8), 12)
    expect(efa.positiveScore).toBe(0)
    expect(decision.targetWeights).toEqual({ DBC: 0.666666666667, EEM: 0.333333333333, EFA: 0 })
  })

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
    expect(decision.estimatedAnnualizedPortfolioVolatility * decision.exposureScale).toBeLessThanOrEqual(0.05)
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
    expect(() =>
      makeRiskBalancedTrendDecision(
        dates[2],
        dates,
        { DBC: [100, 100], EEM: [100, 101, 102], EFA: [100, 99, 98] },
        protocol,
      ),
    ).toThrow('ordered closes')
  })

  test('retains cash when scores cannot absorb exposure and reaches full exposure only when capacity permits', () => {
    const protocol = shortProtocol({ maximumPortfolioVolatility: 1 })
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17'] as const satisfies readonly IsoDate[]
    const cases = [
      {
        name: 'one active symbol',
        closes: { DBC: [100, 101, 103], EEM: [100, 99, 97], EFA: [100, 98, 96] },
        expected: { DBC: 0.35, EEM: 0, EFA: 0 },
      },
      {
        name: 'two active symbols',
        closes: { DBC: [100, 101, 103], EEM: [100, 102, 103], EFA: [100, 98, 96] },
        expected: { DBC: 0.35, EEM: 0.35, EFA: 0 },
      },
      {
        name: 'three active symbols',
        closes: { DBC: [100, 101, 103], EEM: [100, 101, 103], EFA: [100, 101, 103] },
        expected: { DBC: 0.333333333333, EEM: 0.333333333333, EFA: 0.333333333333 },
      },
    ] as const

    for (const testCase of cases) {
      const decision = makeRiskBalancedTrendDecision(dates[2], dates, testCase.closes, protocol)
      expect(decision.targetWeights, testCase.name).toEqual(testCase.expected)
      expect(
        Object.values(decision.targetWeights).reduce((total, weight) => total + weight, 0),
        testCase.name,
      ).toBeLessThanOrEqual(1)
    }

    const allCash = makeRiskBalancedTrendDecision(
      dates[2],
      dates,
      { DBC: [100, 99, 97], EEM: [100, 98, 96], EFA: [100, 97, 95] },
      protocol,
    )
    expect(allCash.targetWeights).toEqual({ DBC: 0, EEM: 0, EFA: 0 })
    expect(allCash.signals.every((signal) => signal.positiveScore === 0)).toBe(true)
  })

  test('requires ordered history and does not use observations after a decision date', () => {
    const protocol = shortProtocol({ maximumPortfolioVolatility: 1 })
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17'] as const satisfies readonly IsoDate[]
    expect(() =>
      makeRiskBalancedTrendDecision(
        dates[2],
        [dates[0], dates[2], dates[1]],
        { DBC: [100, 101, 103], EEM: [100, 102, 103], EFA: [100, 99, 98] },
        protocol,
      ),
    ).toThrow('ordered sessions')

    const snapshot = makeRiskBalancedTrendSnapshot()
    const provenance = makeRiskBalancedTrendTestProvenance()
    const baseline = evaluateRiskBalancedTrend(
      snapshot.bars,
      snapshot.manifest,
      riskBalancedTrendFixtureProtocol,
      provenance,
    )
    const finalSession = snapshot.manifest.lastSession
    const changedFuture = snapshot.bars.map((bar) =>
      bar.sessionDate === finalSession && bar.symbol === 'DBC'
        ? {
            ...bar,
            open: bar.open * 1.5,
            high: bar.high * 1.5,
            low: bar.low * 1.5,
            close: bar.close * 1.5,
          }
        : bar,
    )
    const changed = evaluateRiskBalancedTrend(
      changedFuture,
      snapshot.manifest,
      riskBalancedTrendFixtureProtocol,
      provenance,
    )

    expect(baseline.signalDecisions[0].signalDate < finalSession).toBe(true)
    expect(changed.signalDecisions[0]).toEqual(baseline.signalDecisions[0])
  })

  test('evaluates deterministically with complete evidence and a calendar-only precommit', () => {
    const snapshot = makeRiskBalancedTrendSnapshot()
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
    expect(first.schemaVersion).toBe('bayn.evaluation.v6')
    expect(first.signalDecisions).toHaveLength(first.events.filter((event) => event.kind === 'decision').length)
    expect(first.simulation.dailyMarks).toHaveLength(first.strategy.observations)
    expect(first.equitySeries).toHaveLength(first.strategy.observations)
    expect(first.doubleCostStrategy.observations).toBe(first.strategy.observations)
    expect(Object.values(first.benchmarkSeries).every((series) => series.length === first.strategy.observations)).toBe(
      true,
    )
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
    const retained = first.signalDecisions[0]
    const retainedIndex = sessionDates.indexOf(retained.signalDate)
    const retainedDates = sessionDates.slice(retainedIndex - 252, retainedIndex + 1)
    const closesBySymbolAndDate = new Map(
      snapshot.bars.map((bar) => [`${bar.symbol}\u001f${bar.sessionDate}`, bar.close] as const),
    )
    const retainedCloses = Object.fromEntries(
      riskBalancedTrendFixtureProtocol.universe.map((symbol) => [
        symbol,
        retainedDates.map((date) => {
          const close = closesBySymbolAndDate.get(`${symbol}\u001f${date}`)
          if (close === undefined) throw new Error(`fixture is missing ${symbol} ${date}`)
          return close
        }),
      ]),
    )
    const expectedDecision = makeRiskBalancedTrendDecision(
      retained.signalDate,
      retainedDates,
      retainedCloses,
      riskBalancedTrendFixtureProtocol,
    )
    const { decisionId: _, executionDate: __, ...retainedPlan } = retained
    expect(retainedPlan).toEqual(expectedDecision)
    const priorTrialRunIds = Array.from({ length: 8 }, (_, index) => index.toString(16).repeat(64))
    const strategy = makeRiskBalancedTrendStrategy(riskBalancedTrendFixtureProtocol, provenance)
    const lock = strategy.prepareLock(snapshot.manifest, sessionDates, priorTrialRunIds)
    const analysis = strategy.analyze(first, priorTrialRunIds)
    expect(lock.priorTrialRunIds).toEqual(priorTrialRunIds)
    expect(lock).toMatchObject({
      schemaVersion: 'bayn.qualification-lock.v3',
      universeId: riskBalancedTrendFixtureProtocol.universeId,
      universeSymbolHash: riskBalancedTrendFixtureProtocol.universeSymbolHash,
      data: { inputManifestHash: snapshot.manifest.hash },
    })
    expect(analysis.priorTrialRunIds).toEqual(priorTrialRunIds)
    expect(analysis.candidateOrdinal).toBe(9)
    expect(canonicalHashV1(first)).toBe('879ed10bfcd266f7521a08931f33387b646d9acc40234752c67ec35bb56d9d16')
    expect(canonicalHashV1(first.signalDecisions)).toBe(
      'dcced90996d5be9bb75153bdefec3d06f72f198f8de1b7028a3e13e8a6956d10',
    )
  })
})
