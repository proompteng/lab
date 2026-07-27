import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import type { MarketCalendarObservation } from './broker/alpaca'
import { referencePriceMicros } from './execution-model'
import { bindExecutionSession } from './execution-session'
import { canonicalHashV1 } from './hash'
import {
  evaluateRiskBalancedTrend,
  makeRiskBalancedTrendDecision,
  prepareRiskBalancedTrendQualification,
  type CurrentDecisionCycleBinding,
} from './risk-balanced-trend'
import { makeStrategy } from './strategy'
import { makeSnapshot, makeTestProvenance, fixtureProtocol } from './test-fixtures'
import type { CausalProtocol, IsoDate, Protocol } from './types'

const assertSuccess = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'strategy evaluation fixture must succeed')
  return result.success
}

type HistoricalProtocol = Extract<Protocol, { readonly schemaVersion: 'bayn.risk-balanced-trend.protocol.v3' }>

const { signal: _candidateSignal, ...historicalProtocolBase } = fixtureProtocol
const historicalProtocol: HistoricalProtocol = {
  ...historicalProtocolBase,
  schemaVersion: 'bayn.risk-balanced-trend.protocol.v3',
}

const shortProtocol = (overrides: Partial<HistoricalProtocol> = {}): HistoricalProtocol => ({
  ...historicalProtocol,
  universe: ['DBC', 'EEM', 'EFA'],
  horizons: [1, 2],
  volatilityWindow: 2,
  maximumSymbolWeight: 0.35,
  maximumPortfolioVolatility: 0.1,
  ...overrides,
})

const shortCandidateProtocol = (overrides: Partial<CausalProtocol> = {}): CausalProtocol => ({
  ...fixtureProtocol,
  universe: ['DBC', 'EEM', 'EFA'],
  horizons: [1, 2, 3, 4],
  volatilityWindow: 4,
  maximumSymbolWeight: 0.35,
  maximumPortfolioVolatility: 1,
  ...overrides,
})

const calendarSession = (date: IsoDate): MarketCalendarObservation['sessions'][number] => ({
  date,
  openAt: `${date}T13:30:00.000Z`,
  closeAt: `${date}T20:00:00.000Z`,
})

const currentDecisionBinding = (
  signalSessionDate: IsoDate,
  calendarSessionDates: readonly IsoDate[],
): CurrentDecisionCycleBinding => {
  const sessions = calendarSessionDates.map(calendarSession)
  const rangeEnd = sessions.at(-1)?.date
  if (rangeEnd === undefined) throw new Error('current-decision fixture requires calendar sessions')
  const material = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    requestedRange: { start: signalSessionDate, end: rangeEnd },
    timeZone: 'UTC',
    sessions,
  } as const
  const binding = bindExecutionSession({
    signal: {
      sessionDate: signalSessionDate,
      finalizedAt: `${signalSessionDate}T20:01:00.000Z`,
      contentHash: 'a'.repeat(64),
    },
    planningBrokerState: {
      observedAt: `${signalSessionDate}T20:02:00.000Z`,
      contentHash: 'b'.repeat(64),
    },
    calendar: { ...material, normalizedResponseHash: canonicalHashV1(material) },
    executionModel: fixtureProtocol.executionModel,
  })
  expect(Result.isSuccess(binding)).toBe(true)
  if (Result.isFailure(binding)) return expect.unreachable(binding.failure.message)
  return binding.success
}

describe('risk-balanced trend candidate', () => {
  test('returns precise pre-reconciliation strategy failures', () => {
    const snapshot = makeSnapshot()
    const evaluate = () =>
      evaluateRiskBalancedTrend(snapshot.bars.slice(1), snapshot.manifest, fixtureProtocol, makeTestProvenance())

    expect(evaluate).not.toThrow()
    const result = evaluate()
    assert(Result.isFailure(result), 'malformed strategy evidence must fail explicitly')
    expect(result.failure).toHaveLength(1)
    const [issue] = result.failure
    expect(issue).toEqual({
      _tag: 'ManifestRowCountMismatch',
      expected: snapshot.manifest.rowCount,
      observed: snapshot.bars.length - 1,
    })
  })

  test('matches a hand-calculated multi-symbol continuous normalized trend', () => {
    const protocol = shortProtocol({
      horizons: [1],
      volatilityWindow: 2,
      maximumSymbolWeight: 1,
      maximumPortfolioVolatility: 1,
    })
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17'] as const satisfies readonly IsoDate[]
    const decision = assertSuccess(
      makeRiskBalancedTrendDecision(
        dates[2],
        dates,
        {
          DBC: [100, 101, 103.02],
          EEM: [100, 102, 103.02],
          EFA: [100, 99, 97.02],
        },
        protocol,
      ),
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

  test('requires three positive horizons and allocates by conviction per unit volatility in protocol v4', () => {
    const protocol = shortCandidateProtocol()
    const dates = [
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
    ] as const satisfies readonly IsoDate[]
    const decision = assertSuccess(
      makeRiskBalancedTrendDecision(
        dates[4],
        dates,
        {
          DBC: [100, 99, 101, 98, 100],
          EEM: [100, 99, 98, 99, 101],
          EFA: [100, 101, 102, 101, 99],
        },
        protocol,
      ),
    )
    const dbc = decision.signals.find((signal) => signal.symbol === 'DBC')
    const eem = decision.signals.find((signal) => signal.symbol === 'EEM')
    const efa = decision.signals.find((signal) => signal.symbol === 'EFA')

    expect(dbc).toMatchObject({ eligible: false, positiveScore: 0, targetWeight: 0 })
    expect(eem?.eligible).toBe(true)
    expect(eem?.targetWeight).toBeGreaterThan(0)
    expect(eem?.positiveScore).toBeCloseTo((eem?.compositeScore ?? 0) / (eem?.annualizedVolatility ?? 1), 12)
    expect(efa).toMatchObject({ eligible: false, positiveScore: 0, targetWeight: 0 })
  })

  test('normalizes continuous trend, retains cash under cap capacity, and scales portfolio volatility', () => {
    const protocol = shortProtocol({ maximumPortfolioVolatility: 0.05 })
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17'] as const satisfies readonly IsoDate[]
    const decision = assertSuccess(
      makeRiskBalancedTrendDecision(
        dates[2],
        dates,
        {
          DBC: [100, 101, 105],
          EEM: [100, 102, 103],
          EFA: [100, 99, 98],
        },
        protocol,
      ),
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
    const decision = assertSuccess(
      makeRiskBalancedTrendDecision(
        dates[2],
        dates,
        {
          DBC: [100, 100, 100],
          EEM: [100, 101, 102],
          EFA: [100, 99, 98],
        },
        protocol,
      ),
    )

    expect(decision.signals[0]).toMatchObject({
      symbol: 'DBC',
      eligible: false,
      dailyVolatility: 0,
      compositeScore: 0,
      positiveScore: 0,
      targetWeight: 0,
    })
    const invalidClose = makeRiskBalancedTrendDecision(
      dates[2],
      dates,
      { DBC: [100, Number.NaN, 100], EEM: [100, 101, 102], EFA: [100, 99, 98] },
      protocol,
    )
    assert(Result.isFailure(invalidClose), 'invalid close must fail')
    expect(invalidClose.failure).toMatchObject({
      _tag: 'InvalidRiskBalancedTrendClose',
      symbol: 'DBC',
      index: 1,
    })
    const shortHistory = makeRiskBalancedTrendDecision(
      dates[2],
      dates,
      { DBC: [100, 100], EEM: [100, 101, 102], EFA: [100, 99, 98] },
      protocol,
    )
    assert(Result.isFailure(shortHistory), 'short history must fail')
    expect(shortHistory.failure).toMatchObject({
      _tag: 'RiskBalancedTrendCloseHistoryMismatch',
      symbol: 'DBC',
      expectedCount: 3,
      observedCount: 2,
    })
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
      const decision = assertSuccess(makeRiskBalancedTrendDecision(dates[2], dates, testCase.closes, protocol))
      expect(decision.targetWeights, testCase.name).toEqual(testCase.expected)
      expect(
        Object.values(decision.targetWeights).reduce((total, weight) => total + weight, 0),
        testCase.name,
      ).toBeLessThanOrEqual(1)
    }

    const allCash = assertSuccess(
      makeRiskBalancedTrendDecision(
        dates[2],
        dates,
        { DBC: [100, 99, 97], EEM: [100, 98, 96], EFA: [100, 97, 95] },
        protocol,
      ),
    )
    expect(allCash.targetWeights).toEqual({ DBC: 0, EEM: 0, EFA: 0 })
    expect(allCash.signals.every((signal) => signal.positiveScore === 0)).toBe(true)
  })

  test('requires ordered history and does not use observations after a decision date', () => {
    const protocol = shortProtocol({ maximumPortfolioVolatility: 1 })
    const dates = ['2026-07-15', '2026-07-16', '2026-07-17'] as const satisfies readonly IsoDate[]
    const unordered = makeRiskBalancedTrendDecision(
      dates[2],
      [dates[0], dates[2], dates[1]],
      { DBC: [100, 101, 103], EEM: [100, 102, 103], EFA: [100, 99, 98] },
      protocol,
    )
    assert(Result.isFailure(unordered), 'unordered session history must fail')
    expect(unordered.failure).toMatchObject({ _tag: 'RiskBalancedTrendSessionHistoryMismatch' })

    const snapshot = makeSnapshot()
    const provenance = makeTestProvenance()
    const baseline = assertSuccess(
      evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance),
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
    const changed = assertSuccess(
      evaluateRiskBalancedTrend(changedFuture, snapshot.manifest, fixtureProtocol, provenance),
    )

    expect(baseline.signalDecisions[0].signalDate < finalSession).toBe(true)
    expect(changed.signalDecisions[0]).toEqual(baseline.signalDecisions[0])
  })

  test('compiles one current decision with exact quantized terminal-session prices', () => {
    const snapshot = makeSnapshot(1_129)
    const strategy = makeStrategy(fixtureProtocol, makeTestProvenance())
    const bars = snapshot.bars.map((bar) =>
      bar.sessionDate === snapshot.manifest.lastSession && bar.symbol === fixtureProtocol.universe[0]
        ? { ...bar, close: 100.123456 }
        : bar,
    )
    const current = assertSuccess(
      strategy.currentDecision(
        bars,
        snapshot.manifest,
        currentDecisionBinding(snapshot.manifest.lastSession, ['2020-04-30', '2020-05-01', '2020-05-04']),
      ),
    )
    const sessionDates = [...new Set(snapshot.bars.map((bar) => bar.sessionDate))].sort()
    const historyLength = Math.max(fixtureProtocol.volatilityWindow, ...fixtureProtocol.horizons) + 1
    const historyDates = sessionDates.slice(-historyLength)
    const closesBySymbolAndDate = new Map(
      bars.map((bar) => [`${bar.symbol}\u001f${bar.sessionDate}`, bar.close] as const),
    )
    const expectedPrices = Object.fromEntries(
      fixtureProtocol.universe.map((symbol) => {
        const close = closesBySymbolAndDate.get(`${symbol}\u001f${snapshot.manifest.finalizedSnapshot.lastSession}`)
        if (close === undefined) throw new Error(`fixture is missing terminal close for ${symbol}`)
        return [symbol, assertSuccess(referencePriceMicros(close, fixtureProtocol.executionModel)).toString()]
      }),
    )
    const expectedDecision = assertSuccess(
      makeRiskBalancedTrendDecision(
        snapshot.manifest.finalizedSnapshot.lastSession,
        historyDates,
        Object.fromEntries(
          fixtureProtocol.universe.map((symbol) => [
            symbol,
            historyDates.map((date) => {
              const close = closesBySymbolAndDate.get(`${symbol}\u001f${date}`)
              if (close === undefined) throw new Error(`fixture is missing ${symbol} ${date}`)
              return close
            }),
          ]),
        ),
        fixtureProtocol,
      ),
    )

    expect(current).toEqual({ decision: expectedDecision, priceMicros: expectedPrices })
    expect(current.decision.signalDate).toBe(snapshot.manifest.finalizedSnapshot.lastSession)
    expect(current.priceMicros[fixtureProtocol.universe[0]]).toBe('100123500')
    expect(Object.keys(current.priceMicros)).toEqual([...fixtureProtocol.universe])
    expect(Object.values(current.priceMicros).every((price) => /^[1-9][0-9]*$/.test(price))).toBe(true)
  })

  test('returns terminal-price quantization failures through the current-decision Result', () => {
    const snapshot = makeSnapshot(1_129)
    const protocol = {
      ...fixtureProtocol,
      executionModel: {
        ...fixtureProtocol.executionModel,
        precision: {
          ...fixtureProtocol.executionModel.precision,
          priceIncrementMicros: '1000000000000',
        },
      },
    }
    const strategy = makeStrategy(protocol, makeTestProvenance(protocol))
    const current = strategy.currentDecision(
      snapshot.bars,
      snapshot.manifest,
      currentDecisionBinding(snapshot.manifest.lastSession, ['2020-04-30', '2020-05-01', '2020-05-04']),
    )

    assert(Result.isFailure(current), 'current decision must preserve execution-model price failure data')
    expect(current.failure).toMatchObject({
      _tag: 'InvalidReferencePrice',
      reason: 'rounded-to-zero',
    })
  })

  test('rejects a current decision outside the bound month-end cycle', () => {
    const snapshot = makeSnapshot()
    const strategy = makeStrategy(fixtureProtocol, makeTestProvenance())

    const notMonthEnd = strategy.currentDecision(
      snapshot.bars,
      snapshot.manifest,
      currentDecisionBinding(snapshot.manifest.lastSession, ['2020-04-21', '2020-04-22', '2020-05-01']),
    )
    assert(Result.isFailure(notMonthEnd), 'same-month execution must fail')
    expect(notMonthEnd.failure).toMatchObject({ _tag: 'CurrentDecisionNotMonthEnd' })
    const invalidBinding = strategy.currentDecision(snapshot.bars, snapshot.manifest, {
      signalSessionDate: snapshot.manifest.lastSession,
      executionSessionDate: '2020-05-01',
      calendarSessionDates: [snapshot.manifest.lastSession, '2020-05-01'],
    } as unknown as CurrentDecisionCycleBinding)
    assert(Result.isFailure(invalidBinding), 'invalid binding must fail')
    expect(invalidBinding.failure).toMatchObject({ _tag: 'CurrentDecisionBindingDecodeFailed' })
    const wrongSession = strategy.currentDecision(
      snapshot.bars,
      snapshot.manifest,
      currentDecisionBinding('2020-04-20', ['2020-04-20', '2020-04-21', '2020-04-22']),
    )
    assert(Result.isFailure(wrongSession), 'wrong bound signal session must fail')
    expect(wrongSession.failure).toMatchObject({ _tag: 'CurrentDecisionSessionMismatch' })
  })

  test('rejects an invalid or snapshot-divergent manifest before compiling a current decision', () => {
    const snapshot = makeSnapshot(1_129)
    const strategy = makeStrategy(fixtureProtocol, makeTestProvenance())
    const cycleBinding = currentDecisionBinding(snapshot.manifest.lastSession, [
      '2020-04-30',
      '2020-05-01',
      '2020-05-04',
    ])
    const invalidHash = strategy.currentDecision(
      snapshot.bars,
      {
        ...snapshot.manifest,
        hash: '0'.repeat(64),
      },
      cycleBinding,
    )
    assert(Result.isFailure(invalidHash), 'invalid manifest hash must fail')
    expect(invalidHash.failure).toMatchObject({ _tag: 'ManifestDecodeFailed' })

    const priorSession = snapshot.bars
      .map((bar) => bar.sessionDate)
      .filter((date) => date < snapshot.manifest.lastSession)
      .sort()
      .at(-1)
    if (priorSession === undefined) throw new Error('fixture requires a prior session')
    const { hash: _, ...material } = snapshot.manifest
    const divergentMaterial = {
      ...material,
      bounds: {
        ...material.bounds,
        dataEnd: priorSession,
        evaluationEnd: priorSession,
      },
      lastSession: priorSession,
      symbols: material.symbols.map((coverage) => ({ ...coverage, lastSession: priorSession })),
    }
    const divergent = {
      ...divergentMaterial,
      hash: canonicalHashV1(divergentMaterial),
    }

    const divergentDecision = strategy.currentDecision(snapshot.bars, divergent, cycleBinding)
    assert(Result.isFailure(divergentDecision), 'snapshot-divergent manifest must fail')
    expect(divergentDecision.failure).toMatchObject({ _tag: 'ManifestSnapshotBoundsMismatch' })
  })

  test('rejects a Signal manifest for a different universe before qualification', () => {
    const snapshot = makeSnapshot()
    const { hash: _, ...manifestMaterial } = snapshot.manifest
    const mismatchedMaterial = {
      ...manifestMaterial,
      finalizedSnapshot: {
        ...manifestMaterial.finalizedSnapshot,
        universeSymbolHash: '0'.repeat(64),
      },
    }
    const mismatchedManifest = {
      ...mismatchedMaterial,
      hash: canonicalHashV1(mismatchedMaterial),
    }
    const strategy = makeStrategy(fixtureProtocol, makeTestProvenance())

    const evaluation = strategy.evaluate(snapshot.bars, mismatchedManifest)
    assert(Result.isFailure(evaluation), 'strategy evaluation must preserve manifest failure as Result data')
    expect(evaluation.failure).toEqual([
      expect.objectContaining({
        _tag: 'ManifestDecodeFailed',
      }),
    ])
    const lock = strategy.prepareLock(mismatchedManifest, [], [])
    assert(Result.isFailure(lock), 'qualification lock must reject an invalid manifest')
    expect(lock.failure).toMatchObject({ _tag: 'ManifestDecodeFailed' })
  })

  test('evaluates deterministically with complete evidence and a calendar-only precommit', () => {
    const snapshot = makeSnapshot()
    const provenance = makeTestProvenance()
    const first = assertSuccess(
      evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance),
    )
    const second = assertSuccess(
      evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance),
    )
    const sessionDates = [...new Set(snapshot.bars.map((bar) => bar.sessionDate))].sort()
    const precommit = assertSuccess(
      prepareRiskBalancedTrendQualification(sessionDates, snapshot.manifest, fixtureProtocol, provenance),
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
      fixtureProtocol.universe.map((symbol) => [
        symbol,
        retainedDates.map((date) => {
          const close = closesBySymbolAndDate.get(`${symbol}\u001f${date}`)
          if (close === undefined) throw new Error(`fixture is missing ${symbol} ${date}`)
          return close
        }),
      ]),
    )
    const expectedDecision = assertSuccess(
      makeRiskBalancedTrendDecision(retained.signalDate, retainedDates, retainedCloses, fixtureProtocol),
    )
    const { decisionId: _, executionDate: __, ...retainedPlan } = retained
    expect(retainedPlan).toEqual(expectedDecision)
    const priorTrialRunIds = Array.from({ length: 8 }, (_, index) => index.toString(16).repeat(64))
    const strategy = makeStrategy(fixtureProtocol, provenance)
    const lock = assertSuccess(strategy.prepareLock(snapshot.manifest, sessionDates, priorTrialRunIds))
    const analysis = assertSuccess(strategy.analyze(first, priorTrialRunIds))
    expect(lock.priorTrialRunIds).toEqual(priorTrialRunIds)
    expect(lock).toMatchObject({
      schemaVersion: 'bayn.qualification-lock.v3',
      universeId: fixtureProtocol.universeId,
      universeSymbolHash: fixtureProtocol.universeSymbolHash,
      data: { inputManifestHash: snapshot.manifest.hash },
    })
    expect(lock.universeRationale).toBe(
      'The precommitted five-sleeve cross-asset universe uses broad commodities (DBC), developed ex-US equities (EFA), intermediate US Treasuries (IEF), US equities (SPY), and US real estate (VNQ); symbols were fixed without inspecting candidate prices or returns.',
    )
    expect(analysis.priorTrialRunIds).toEqual(priorTrialRunIds)
    expect(analysis.candidateOrdinal).toBe(9)
    expect(canonicalHashV1(first)).toBe('81002ac221b557498e06cbcd9307d986ed21ff2c2ce883adcc489fef7f468416')
    expect(canonicalHashV1(first.signalDecisions)).toBe(
      'a7ee602d168b076e56759e852ac3a207d7f74774ee0f2650c0922ad1e1f4e272',
    )
  })
})
