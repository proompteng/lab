import { describe, expect, test } from 'bun:test'
import {
  canonicalHashV1,
  type CandidateDevelopmentVerifiedSource,
  validateCandidateDevelopmentCommandEvaluation,
} from './test-api'
import { Result } from './test-runtime'
import {
  baselineFixture,
  buildCandidateDevelopmentCommandReport,
  buildFixtureReport,
  commandEvaluationFixture,
  firstDecisionFixture,
  fixtureBenchmarkSeries,
  fixtureInputManifest,
  fixtureMarketData,
  fixtureMarketDataMaterial,
  fixtureOfficialSessions,
  fixtureStrategyProtocol,
  fixtureVerifiedSource,
  reportFixture,
} from './test-support'

describe('candidate development market data policy', () => {
  test('rejects forged fill reference prices and daily mark prices', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const forgedFillPayload = {
      orderId: 'd'.repeat(64),
      decisionId: firstDecisionFixture.signal.decisionId,
      sessionDate: firstDecisionFixture.signal.executionDate,
      symbol: 'SPY',
      side: 'buy' as const,
      quantityMicros: '1000000',
      referencePriceMicros: '1',
      priceMicros: '1',
      notionalMicros: '1',
      spreadCostMicros: '0',
      slippageCostMicros: '0',
      costBasisMicros: '1',
    }
    const forgedFill = {
      kind: 'fill' as const,
      ...forgedFillPayload,
      id: canonicalHashV1({ runId: baseline.runId, kind: 'fill', ...forgedFillPayload }),
    }
    const baselineWithFill = { ...baseline, events: [...baseline.events, forgedFill] }
    expect(buildFixtureReport(report, baselineWithFill)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.fills.referencePriceMicros',
        observed: '1',
      },
    })

    const firstMark = baseline.simulation.dailyMarks[0]
    const baselineWithMark = {
      ...baseline,
      simulation: {
        ...baseline.simulation,
        dailyMarks: [
          {
            ...firstMark,
            positions: firstMark.positions.map((position) => ({ ...position, priceMicros: '1' })),
          },
          ...baseline.simulation.dailyMarks.slice(1),
        ],
      },
    }
    expect(buildFixtureReport(report, baselineWithMark)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.dailyMarks.priceMicros',
        observed: '1',
      },
    })
  })

  test('binds baseline and stressed daily position basis to deterministic replay', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const firstBaselineMark = baseline.simulation.dailyMarks[0]
    const forgedBaseline = {
      ...baseline,
      simulation: {
        ...baseline.simulation,
        dailyMarks: [
          {
            ...firstBaselineMark,
            positions: firstBaselineMark.positions.map((position) => ({ ...position, costBasisMicros: '1' })),
          },
          ...baseline.simulation.dailyMarks.slice(1),
        ],
      },
    }
    expect(buildFixtureReport(report, forgedBaseline)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.replay.dailyMarks',
      },
    })

    const evaluation = commandEvaluationFixture(report, baseline)
    const firstStressedMark = report.doubledCost.stressed.simulation.dailyMarks[0]
    const forgedStressedMark = {
      ...firstStressedMark,
      positions: firstStressedMark.positions.map((position) => ({ ...position, costBasisMicros: '1' })),
    }
    const stressedSimulation = {
      ...report.doubledCost.stressed.simulation,
      dailyMarks: [forgedStressedMark, ...report.doubledCost.stressed.simulation.dailyMarks.slice(1)],
    }
    const stressedReport = {
      ...report,
      doubledCost: {
        ...report.doubledCost,
        stressed: { ...report.doubledCost.stressed, simulation: stressedSimulation },
      },
    }
    const stressedEvaluation = {
      ...evaluation,
      stressed: stressedReport.doubledCost.stressed,
      accounting: {
        ...evaluation.accounting,
        stressedSimulation: {
          ...evaluation.accounting.stressedSimulation,
          dailyMarks: evaluation.accounting.stressedSimulation.dailyMarks.map((mark) =>
            mark.sessionDate === forgedStressedMark.sessionDate ? forgedStressedMark : mark,
          ),
        },
      },
    }
    expect(
      buildCandidateDevelopmentCommandReport(stressedReport, stressedEvaluation, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'stressed.replay.dailyMarks',
      },
    })
  })

  test('rejects fabricated buy-and-hold and direct-volatility benchmarks', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const buyFirst = baseline.benchmarkSeries.buyAndHold[0]
    const fabricatedBuy = {
      ...baseline,
      benchmarkSeries: {
        ...baseline.benchmarkSeries,
        buyAndHold: [{ ...buyFirst, equityMicros: '999999999' }, ...baseline.benchmarkSeries.buyAndHold.slice(1)],
      },
    }
    expect(buildFixtureReport(report, fabricatedBuy)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'benchmarks.buyAndHold',
      },
    })

    const directFirst = baseline.benchmarkSeries.directVolTiming[0]
    const fabricatedDirect = {
      ...baseline,
      benchmarkSeries: {
        ...baseline.benchmarkSeries,
        directVolTiming: [
          { ...directFirst, equityMicros: '999999999' },
          ...baseline.benchmarkSeries.directVolTiming.slice(1),
        ],
      },
    }
    expect(buildFixtureReport(report, fabricatedDirect)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'benchmarks.directVolatilityTiming',
      },
    })
  })

  test('rejects buy-and-hold entry on the accounting predecessor', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const legacyBuyAndHold = fixtureBenchmarkSeries(true).buyAndHold
    expect(legacyBuyAndHold).not.toEqual(baseline.benchmarkSeries.buyAndHold)

    expect(
      buildFixtureReport(report, {
        ...baseline,
        benchmarkSeries: { ...baseline.benchmarkSeries, buyAndHold: legacyBuyAndHold },
      }),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'benchmarks.buyAndHold',
      },
    })
  })

  test('rejects self-consistent bounded bars that differ from the Git-verified source manifest', () => {
    const first = fixtureMarketData.bars[0]
    const forgedFirst = {
      ...first,
      open: first.open * 2,
      high: first.high * 2,
      low: first.low * 2,
      close: first.close * 2,
    }
    const forgedMarketDataMaterial = {
      ...fixtureMarketDataMaterial,
      bars: [forgedFirst, ...fixtureMarketData.bars.slice(1)],
    }
    const forgedMarketData = {
      ...forgedMarketDataMaterial,
      contentHash: canonicalHashV1(forgedMarketDataMaterial),
    }
    const forgedProtocol = {
      ...fixtureStrategyProtocol,
      marketData: { ...fixtureStrategyProtocol.marketData, contentHash: forgedMarketData.contentHash },
    }
    const forgedProtocolHash = canonicalHashV1(forgedProtocol)
    const report = reportFixture(0.01)
    const forgedReport = {
      ...report,
      comparisonSemantics: { ...report.comparisonSemantics, strategyProtocolHash: forgedProtocolHash },
    }
    const baseline = { ...baselineFixture(), protocolHash: forgedProtocolHash }
    const evaluation = {
      ...commandEvaluationFixture(forgedReport, baseline),
      marketData: forgedMarketData,
    }

    expect(
      buildCandidateDevelopmentCommandReport(
        forgedReport,
        evaluation,
        forgedProtocol,
        fixtureOfficialSessions,
        fixtureVerifiedSource,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'marketData.committedContentHash',
        expected: fixtureMarketData.contentHash,
        observed: forgedMarketData.contentHash,
      },
    })
  })

  test('binds bounded bars to the publisher finalized snapshot content hash', () => {
    const report = reportFixture(0.01)
    const driftedSource: CandidateDevelopmentVerifiedSource = {
      ...fixtureVerifiedSource,
      sourceManifest: {
        ...fixtureVerifiedSource.sourceManifest,
        marketData: {
          ...fixtureVerifiedSource.sourceManifest.marketData,
          finalizedSnapshotContentHash: 'f'.repeat(64),
        },
      },
    }

    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, baselineFixture()),
        fixtureStrategyProtocol,
        fixtureOfficialSessions,
        driftedSource,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'marketData.finalizedSnapshotContentHash',
        expected: 'f'.repeat(64),
        observed: fixtureInputManifest.finalizedSnapshot.contentHash,
      },
    })
  })

  test('uses deterministic code-unit market-bar ordering when locale-aware comparison disagrees', () => {
    const originalLocaleCompare = Object.getOwnPropertyDescriptor(String.prototype, 'localeCompare')
    if (originalLocaleCompare === undefined) throw new Error('String.prototype.localeCompare descriptor is missing')
    const result = (() => {
      Object.defineProperty(String.prototype, 'localeCompare', {
        configurable: true,
        writable: true,
        value(this: string, other: string): number {
          const left = String(this)
          return left === other ? 0 : left < other ? 1 : -1
        },
      })
      try {
        expect('DBC'.localeCompare('EFA')).toBeGreaterThan(0)
        expect(fixtureOfficialSessions[0].localeCompare(fixtureOfficialSessions[1])).toBeGreaterThan(0)
        const report = reportFixture(0.01)
        return buildFixtureReport(report, baselineFixture())
      } finally {
        Object.defineProperty(String.prototype, 'localeCompare', originalLocaleCompare)
      }
    })()

    expect(Result.isSuccess(result)).toBe(true)
  })

  test('rejects self-reported source revisions and run identities', () => {
    const report = reportFixture(0.01)
    const revisionDrift = { ...baselineFixture(), codeRevision: 'f'.repeat(40) }
    expect(buildFixtureReport(report, revisionDrift)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        field: 'verifiedSource.codeRevision',
        expected: fixtureVerifiedSource.sourceRevision,
        observed: 'f'.repeat(40),
      },
    })

    const runDrift = { ...baselineFixture(), runId: 'e'.repeat(64) }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, runDrift),
        fixtureStrategyProtocol,
        fixtureOfficialSessions,
        fixtureVerifiedSource,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        field: 'verifiedSource.baselineRunId',
        expected: fixtureVerifiedSource.baselineRunId,
        observed: 'e'.repeat(64),
      },
    })
  })

  test('binds aligned market-data sessions to the frozen official calendar', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const mismatchedOfficialSessions = [...fixtureOfficialSessions]
    mismatchedOfficialSessions[1] = fixtureOfficialSessions[2]

    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, baseline),
        fixtureStrategyProtocol,
        mismatchedOfficialSessions,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'marketData.sessions.sessionDate',
        index: 1,
        expected: fixtureOfficialSessions[2],
        observed: fixtureOfficialSessions[1],
      },
    })
  })

  test('runtime-decodes only valid OHLC market-data witnesses', () => {
    const report = reportFixture(0.01)
    const evaluation = commandEvaluationFixture(report, baselineFixture())
    const first = evaluation.marketData.bars[0]
    const invalidMarketData = {
      ...evaluation.marketData,
      bars: [{ ...first, low: first.high + 1 }, ...evaluation.marketData.bars.slice(1)],
    }

    expect(
      validateCandidateDevelopmentCommandEvaluation({ ...evaluation, marketData: invalidMarketData }),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandProgramInvalid',
        reason: 'evaluation-invalid',
      },
    })
  })
})
