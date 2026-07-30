import { describe, expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Result } from 'effect'

import { frozenCandidateDevelopmentSessions } from './candidate-development-calendar'
import {
  buildCandidateDevelopmentCommandReport,
  candidateDevelopmentExecutableProgramSchemaVersion,
  executeCandidateDevelopmentProgram,
  loadCandidateDevelopmentExecutableProgram,
  renderCandidateDevelopmentCommandReport,
  validateCandidateDevelopmentCommandEvaluation,
  validateCandidateDevelopmentExecutableProgram,
  writeCandidateDevelopmentCommandReport,
  type CandidateDevelopmentCommandEvaluation,
  type CandidateDevelopmentExecutableProgram,
} from './candidate-development-command'
import {
  candidateDevelopmentComparisonSemantics,
  officialMonthEndSignalDates,
  type CandidateDevelopmentReport,
} from './candidate-development'
import { canonicalHashV1, canonicalHashV1Result, sha256 } from './hash'
import { defaultProtocolDocument } from './protocol'
import { calculateExactPerformanceMetrics, buildVerdict } from './simulation/metrics'
import { reconcileMarkedEquity } from './simulation-reconciliation'
import type { EvaluationResult, IsoDate } from './types'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error('expected Result success')
  return result.success
}

const fixtureInitialCapitalMicros = '1000000'
const fixtureRunId = '1'.repeat(64)
const fixtureSessions = Array.from(
  { length: 504 },
  (_, index) => new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10) as IsoDate,
)

const performanceSeriesFixture = (
  equityMicros: string,
  totals: {
    readonly feesMicros?: string
    readonly cashYieldMicros?: string
  } = {},
) => {
  const feesMicros = totals.feesMicros ?? '0'
  const cashYieldMicros = totals.cashYieldMicros ?? '0'
  return fixtureSessions.map((sessionDate, index) => ({
    sessionDate,
    equityMicros,
    netReturn: index === 0 ? Number(equityMicros) / Number(fixtureInitialCapitalMicros) - 1 : 0,
    turnoverMicros: '0',
    cumulativeTurnoverMicros: '0',
    feeMicros: index === 0 ? feesMicros : '0',
    cumulativeFeesMicros: feesMicros,
    spreadCostMicros: '0',
    cumulativeSpreadCostMicros: '0',
    slippageCostMicros: '0',
    cumulativeSlippageCostMicros: '0',
    cashYieldMicros: index === 0 ? cashYieldMicros : '0',
    cumulativeCashYieldMicros: cashYieldMicros,
    peakEquityMicros: equityMicros,
    drawdown: 0,
  }))
}

const exactMetrics = (points: ReturnType<typeof performanceSeriesFixture>) => {
  const last = points.at(-1)
  if (last === undefined) throw new Error('performance fixture must be nonempty')
  return successOf(
    calculateExactPerformanceMetrics(
      points.map(({ equityMicros }) => BigInt(equityMicros)),
      BigInt(last.cumulativeTurnoverMicros),
      BigInt(last.cumulativeFeesMicros),
      BigInt(last.cumulativeSpreadCostMicros),
      BigInt(last.cumulativeSlippageCostMicros),
      BigInt(last.cumulativeCashYieldMicros),
      BigInt(fixtureInitialCapitalMicros),
    ),
  )
}

const fixtureExecutionModel = {
  ...defaultProtocolDocument.executionModel,
  cash: { ...defaultProtocolDocument.executionModel.cash, annualYieldBps: 10_000 },
}

const zeroPositionFixture = {
  symbol: 'SPY',
  quantityMicros: '0',
  costBasisMicros: '0',
  priceMicros: '1000000',
  marketValueMicros: '0',
}

const signalDecisionFixture = {
  schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1' as const,
  decisionId: 'a'.repeat(64),
  signalDate: fixtureSessions[0],
  executionDate: fixtureSessions[1],
  covarianceWindow: {
    returnCount: 1,
    firstSession: fixtureSessions[0],
    lastSession: fixtureSessions[0],
    sessionsHash: 'b'.repeat(64),
  },
  estimatedAnnualizedPortfolioVolatility: 0,
  exposureScale: 0,
  targetWeights: { SPY: 0 },
  signals: [
    {
      symbol: 'SPY',
      horizons: [{ horizonSessions: 1, return: 0, normalizedTrend: 0 }],
      dailyVolatility: 0,
      annualizedVolatility: 0,
      compositeScore: 0,
      positiveScore: 0,
      eligible: false,
      uncappedWeight: 0,
      cappedWeight: 0,
      targetWeight: 0,
    },
  ],
}

const inputManifestFixture = () => {
  const firstSession = fixtureSessions[0]
  const lastSession = fixtureSessions.at(-1)
  if (firstSession === undefined || lastSession === undefined) throw new Error('fixture sessions must be nonempty')
  const symbols = defaultProtocolDocument.universe.map((symbol) => ({
    symbol,
    rows: fixtureSessions.length,
    firstSession,
    lastSession,
  }))
  const material = {
    schemaVersion: 'bayn.input-manifest.v3' as const,
    database: 'signal' as const,
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1' as const,
      dataStart: firstSession,
      dataEnd: lastSession,
      lookbackStart: firstSession,
      evaluationStart: firstSession,
      evaluationEnd: lastSession,
    },
    rowCount: fixtureSessions.length * symbols.length,
    sessionCount: fixtureSessions.length,
    firstSession,
    lastSession,
    symbols,
    tables: {
      bars: 'adjusted_daily_bars_v2' as const,
      sessions: 'exchange_sessions_v1' as const,
      manifests: 'snapshot_manifests_v2' as const,
    },
    finalizedSnapshot: {
      schemaVersion: 'bayn.finalized-snapshot.v3' as const,
      publicationSchemaVersion: 'signal.adjusted-daily-snapshot.v2' as const,
      universeId: 'cross-asset-taa-v1' as const,
      universeSymbolHash: sha256(defaultProtocolDocument.universe.join(',')),
      snapshotId: '4'.repeat(64),
      publicationId: '5'.repeat(64),
      source: 'alpaca' as const,
      sourceFeed: 'sip' as const,
      adjustment: 'all' as const,
      calendarVersion: 'fixture-calendar-v1',
      publisherSourceRevision: '6'.repeat(40),
      publisherImage: {
        repository: 'registry.example.test/bayn-fixture',
        digest: `sha256:${'7'.repeat(64)}` as const,
      },
      finalizedAt: '2026-07-29T00:00:00.000Z',
      requestedStart: firstSession,
      firstSession,
      lastSession,
      asOfSession: lastSession,
      symbols: [...defaultProtocolDocument.universe],
      rowCount: fixtureSessions.length * symbols.length,
      sessionCount: fixtureSessions.length,
      contentHash: '8'.repeat(64),
      sessionsContentHash: '9'.repeat(64),
    },
  }
  return { ...material, hash: canonicalHashV1(material) }
}

const fixtureStressedRunId = 'c'.repeat(64)

const stressedAccountingFixture = (endingEquityMicros: string) => {
  const cashYieldMicros = BigInt(endingEquityMicros) - BigInt(fixtureInitialCapitalMicros)
  if (cashYieldMicros < 0n) throw new Error('stressed fixture cannot have negative cash yield')
  const eventPayload = {
    kind: 'cash-yield' as const,
    sessionDate: fixtureSessions[0],
    elapsedDays: 365,
    annualYieldBps: fixtureExecutionModel.cash.annualYieldBps,
    amountMicros: cashYieldMicros.toString(),
  }
  const event = {
    ...eventPayload,
    id: canonicalHashV1({ runId: fixtureStressedRunId, ...eventPayload }),
  }
  const cashChangePayload = {
    sourceKind: event.kind,
    sourceId: event.id,
    sessionDate: event.sessionDate,
    amountMicros: cashYieldMicros.toString(),
    cashAfterMicros: endingEquityMicros,
  }
  const cashChange = {
    ...cashChangePayload,
    id: canonicalHashV1({ runId: fixtureStressedRunId, kind: 'cash-change', ...cashChangePayload }),
  }
  const events = cashYieldMicros === 0n ? [] : [event]
  const cashChanges = cashYieldMicros === 0n ? [] : [cashChange]
  const simulation = {
    schemaVersion: 'bayn.simulation-trace.v3' as const,
    executionModel: fixtureExecutionModel,
    costMultiplierMicros: '2000000',
    orders: [],
    cashChanges,
    dailyMarks: performanceSeriesFixture(endingEquityMicros, {
      cashYieldMicros: cashYieldMicros.toString(),
    }).map((point) => ({ ...point, cashMicros: point.equityMicros, positions: [zeroPositionFixture] })),
  }
  const proof = reconcileMarkedEquity({
    runId: fixtureStressedRunId,
    initialCapitalMicros: fixtureInitialCapitalMicros,
    evaluatorTotalFeesMicros: '0',
    evaluatorEndingEquityMicros: endingEquityMicros,
    events,
    simulation,
  })
  if (Result.isFailure(proof)) {
    throw new Error(`stressed marked-equity fixture failed: ${JSON.stringify(proof.failure)}`)
  }
  return {
    runId: fixtureStressedRunId,
    evaluatorTotalFeesMicros: '0',
    evaluatorEndingEquityMicros: endingEquityMicros,
    events,
    simulation,
    equitySeries: proof.success.equitySeries,
    markedEquityReconciliation: proof.success.reconciliation,
  }
}

const reportFixture = (
  annualizedReturnDifferenceLowerBound: number,
  stressedEndingEquityMicros = '2000000',
): CandidateDevelopmentReport => {
  const stressed = stressedAccountingFixture(stressedEndingEquityMicros)
  return {
    schemaVersion: 'bayn.candidate-development-report.v2',
    protocolIdentity: {
      schemaVersion: 'bayn.candidate-development-protocol-identity.v2',
      candidateOrdinal: 16,
      priorTrialCount: 15,
      featureLookbackSessions: 126,
      candidateDevelopmentProtocolHash: 'a'.repeat(64),
    },
    comparisonSemantics: {
      schemaVersion: candidateDevelopmentComparisonSemantics.evidence.schemaVersion,
      candidateDevelopmentProtocolHash: 'a'.repeat(64),
      strategyProtocolHash: 'b'.repeat(64),
      comparisonSemantics: candidateDevelopmentComparisonSemantics,
      analysis: {
        power: { sufficient: true },
        bootstrap: {
          selectedBenchmark: 'buy-and-hold',
          tailResolutionSufficient: true,
          tailSampleCount: 31,
          minimumTailSamples: 20,
          annualizedReturnDifferenceLowerBound,
          sharpeDifferenceLowerBound: 0.01,
        },
        walkForward: {
          folds: [{ maximumDrawdown: 0.1, drawdownWithinLimit: true }],
          requiredFolds: 1,
          positiveFoldFraction: 1,
          requiredPositiveFoldFraction: 0.6,
          allDrawdownsWithinLimit: true,
          maximumFoldDrawdown: 0.1,
          sufficient: true,
        },
      },
    },
    doubledCost: {
      stressed: {
        signalDecisions: [signalDecisionFixture],
        simulation: stressed.simulation,
      },
    },
  } as unknown as CandidateDevelopmentReport
}

const baselineFixture = (
  status: 'PASS' | 'FAIL_CLOSED' = 'PASS',
  stressedEndingEquityMicros = '2000000',
): EvaluationResult => {
  const strategyEndingEquityMicros = status === 'PASS' ? '2000000' : fixtureInitialCapitalMicros
  const strategyPoints = performanceSeriesFixture(
    strategyEndingEquityMicros,
    status === 'PASS' ? { cashYieldMicros: '1000000' } : {},
  )
  const strategy = exactMetrics(strategyPoints)
  const buyAndHoldPoints = performanceSeriesFixture(fixtureInitialCapitalMicros)
  const directVolTimingPoints = performanceSeriesFixture(fixtureInitialCapitalMicros)
  const doubleCostPoints = performanceSeriesFixture(stressedEndingEquityMicros, {
    cashYieldMicros: (BigInt(stressedEndingEquityMicros) - BigInt(fixtureInitialCapitalMicros)).toString(),
  })
  const buyAndHold = exactMetrics(buyAndHoldPoints)
  const directVolTiming = exactMetrics(directVolTimingPoints)
  const doubleCostStrategy = exactMetrics(doubleCostPoints)
  const eventPayload = {
    kind: 'cash-yield' as const,
    sessionDate: fixtureSessions[0],
    elapsedDays: 365,
    annualYieldBps: 10_000,
    amountMicros: '1000000',
  }

  const event = { ...eventPayload, id: canonicalHashV1({ runId: fixtureRunId, ...eventPayload }) }
  const cashChangePayload = {
    sourceKind: event.kind,
    sourceId: event.id,
    sessionDate: event.sessionDate,
    amountMicros: '1000000',
    cashAfterMicros: strategyEndingEquityMicros,
  }
  const cashChange = {
    ...cashChangePayload,
    id: canonicalHashV1({ runId: fixtureRunId, kind: 'cash-change', ...cashChangePayload }),
  }
  const events = status === 'PASS' ? [event] : []
  const cashChanges = status === 'PASS' ? [cashChange] : []
  const simulation = {
    schemaVersion: 'bayn.simulation-trace.v3' as const,
    executionModel: fixtureExecutionModel,
    costMultiplierMicros: '1000000',
    orders: [],
    cashChanges,
    dailyMarks: strategyPoints.map((point) => ({
      ...point,
      cashMicros: point.equityMicros,
      positions: [zeroPositionFixture],
    })),
  }
  const verdict = buildVerdict(strategy, buyAndHold, directVolTiming, doubleCostStrategy, {
    universe: defaultProtocolDocument.universe,
    directVolatilityTarget: defaultProtocolDocument.directVolatilityTarget,
    initialCapitalMicros: '1000000',
    executionModel: fixtureExecutionModel,
    thresholds: defaultProtocolDocument.thresholds,
  })
  const markedEquityResult = reconcileMarkedEquity({
    runId: fixtureRunId,
    initialCapitalMicros: fixtureInitialCapitalMicros,
    evaluatorTotalFeesMicros: strategy.totalFeesMicros,
    evaluatorEndingEquityMicros: strategy.endingEquityMicros,
    events,
    simulation,
  })
  if (Result.isFailure(markedEquityResult)) {
    throw new Error(`marked-equity fixture failed: ${JSON.stringify(markedEquityResult.failure)}`)
  }
  const markedEquity = markedEquityResult.success
  return {
    schemaVersion: 'bayn.evaluation.v6',
    runId: fixtureRunId,
    codeRevision: '2'.repeat(40),
    protocolHash: '3'.repeat(64),
    initialCapitalMicros: '1000000',
    inputManifest: inputManifestFixture(),
    strategy,
    buyAndHold,
    directVolTiming,
    doubleCostStrategy,
    verdict,
    events,
    simulation,
    benchmarkSeries: {
      buyAndHold: buyAndHoldPoints,
      directVolTiming: directVolTimingPoints,
      doubleCostStrategy: doubleCostPoints,
    },
    equitySeries: markedEquity.equitySeries,
    markedEquityReconciliation: markedEquity.reconciliation,
    signalDecisions: [signalDecisionFixture],
  } as unknown as EvaluationResult
}

const commandEvaluationFixture = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
  accountingBaseline: EvaluationResult = baseline,
): CandidateDevelopmentCommandEvaluation => {
  const stressedEndingEquityMicros = report.doubledCost.stressed.simulation.dailyMarks.at(-1)?.equityMicros
  if (stressedEndingEquityMicros === undefined) throw new Error('stressed fixture must be nonempty')
  const stressed = stressedAccountingFixture(stressedEndingEquityMicros)
  return {
    baseline,
    comparisonSemantics: report.comparisonSemantics,
    stressed: report.doubledCost.stressed,
    accounting: {
      schemaVersion: 'bayn.candidate-development-accounting-evidence.v1',
      runId: accountingBaseline.runId,
      initialCapitalMicros: accountingBaseline.initialCapitalMicros,
      evaluatorTotalFeesMicros: accountingBaseline.strategy.totalFeesMicros,
      evaluatorEndingEquityMicros: accountingBaseline.strategy.endingEquityMicros,
      events: accountingBaseline.events,
      baselineSimulation: accountingBaseline.simulation,
      equitySeries: accountingBaseline.equitySeries,
      markedEquityReconciliation: accountingBaseline.markedEquityReconciliation,
      stressedRunId: stressed.runId,
      stressedEvaluatorTotalFeesMicros: stressed.evaluatorTotalFeesMicros,
      stressedEvaluatorEndingEquityMicros: stressed.evaluatorEndingEquityMicros,
      stressedEvents: stressed.events,
      stressedSimulation: stressed.simulation,
      stressedEquitySeries: stressed.equitySeries,
      stressedMarkedEquityReconciliation: stressed.markedEquityReconciliation,
    },
  }
}

const buildFixtureReport = (report: CandidateDevelopmentReport, baseline: EvaluationResult) =>
  buildCandidateDevelopmentCommandReport(report, commandEvaluationFixture(report, baseline))

describe('candidate development command', () => {
  test('calls no effects when preflight rejects the ordinal lineage', async () => {
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const program: CandidateDevelopmentExecutableProgram<string, string, string, never> = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 14,
        expectedStrategyProtocolHash: 'a'.repeat(64),
        officialSessions: [],
        signalSessionDates: [],
        featureLookbackSessions: 126,
      },
      effects: {
        preregisterCandidate: () => {
          preregistrations += 1
          return Effect.succeed('registration')
        },
        loadDevelopmentData: () => {
          loads += 1
          return Effect.succeed('data')
        },
        evaluateDevelopment: () => {
          evaluations += 1
          return Effect.fail('unexpected-evaluation')
        },
      },
    }

    const failure = await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(program)))

    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentPreflightInvalid',
      cause: {
        _tag: 'CandidateDevelopmentAttemptLineageMismatch',
        candidateOrdinal: 16,
        priorTrialCount: 14,
        expectedCandidateOrdinal: 15,
      },
    })
    expect(preregistrations).toBe(0)
    expect(loads).toBe(0)
    expect(evaluations).toBe(0)
  })

  test('calls preregistration, loading, and evaluation exactly once after passing preflight', async () => {
    const sessions = frozenCandidateDevelopmentSessions()
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const program: CandidateDevelopmentExecutableProgram<string, string, string, never> = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: 'a'.repeat(64),
        officialSessions: sessions,
        signalSessionDates: officialMonthEndSignalDates(sessions),
        featureLookbackSessions: 126,
      },
      effects: {
        preregisterCandidate: () => {
          preregistrations += 1
          return Effect.succeed('registration')
        },
        loadDevelopmentData: () => {
          loads += 1
          return Effect.succeed('data')
        },
        evaluateDevelopment: () => {
          evaluations += 1
          return Effect.fail('evaluation-stop')
        },
      },
    }

    expect(await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(program)))).toBe('evaluation-stop')
    expect(preregistrations).toBe(1)
    expect(loads).toBe(1)
    expect(evaluations).toBe(1)
  })

  test('derives the disposition and hashes the complete governed report', () => {
    const passing = successOf(buildFixtureReport(reportFixture(0.01), baselineFixture()))
    const rejected = successOf(buildFixtureReport(reportFixture(-0.01), baselineFixture()))
    const economicallyRejected = successOf(buildFixtureReport(reportFixture(0.01), baselineFixture('FAIL_CLOSED')))
    const doubledCostRejected = successOf(
      buildFixtureReport(reportFixture(0.01, '1000000'), baselineFixture('PASS', '1000000')),
    )
    const { contentHash, ...material } = passing

    expect(passing.decision.status).toBe('PASS')
    expect(rejected.decision.status).toBe('HOLD_REJECT')
    expect(economicallyRejected.decision.status).toBe('HOLD_REJECT')
    expect(doubledCostRejected.decision.status).toBe('HOLD_REJECT')
    expect(doubledCostRejected.decision.gates).toContainEqual({
      name: 'double_cost_return',
      passed: false,
      actual: 0,
      required: 0,
    })
    expect(passing.decision.gates.map(({ name }) => name)).toContain('annualized_excess_return_lower_bound')
    expect(passing.decision.gates.map(({ name }) => name)).not.toContain('annualized_return_difference_lower_bound')
    expect(contentHash).toBe(successOf(canonicalHashV1Result(material)))
    expect(buildFixtureReport(reportFixture(0.01), baselineFixture())).toEqual(Result.succeed(passing))
    const rendered = renderCandidateDevelopmentCommandReport(passing)
    expect(rendered.endsWith('\n')).toBe(true)
    expect(rendered.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(rendered)).toEqual(passing)
  })

  test('rejects detached doubled-cost summary metrics', () => {
    const baseline = baselineFixture()
    const detached = {
      ...baseline,
      doubleCostStrategy: { ...baseline.doubleCostStrategy, annualizedReturn: 0.5 },
    }

    expect(buildFixtureReport(reportFixture(0.01), detached)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
        series: 'double-cost-series',
        reason: 'metrics-mismatch',
        field: 'annualizedReturn',
        observed: 0.5,
      },
    })
  })

  test('rejects an economic summary status that disagrees with its gates', () => {
    const baseline = baselineFixture()
    const inconsistent = {
      ...baseline,
      verdict: { ...baseline.verdict, status: 'FAIL_CLOSED' as const },
    }

    expect(buildFixtureReport(reportFixture(0.01), inconsistent)).toEqual(
      Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicVerdictInvalid',
        expectedStatus: 'PASS',
        observedStatus: 'FAIL_CLOSED',
        failedGateNames: [],
      }),
    )
  })

  test('rejects an incomplete economic gate set before deriving success', () => {
    const baseline = baselineFixture()
    const incomplete = {
      ...baseline,
      verdict: { status: 'PASS' as const, gates: baseline.verdict.gates.slice(0, -1) },
    }
    const expectedGateNames = baseline.verdict.gates.map((gate) => gate.name)

    expect(buildFixtureReport(reportFixture(0.01), incomplete)).toEqual(
      Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicGateSetInvalid',
        expectedGateNames,
        observedGateNames: expectedGateNames.slice(0, -1),
      }),
    )
  })

  test('rejects forged passing gates that disagree with decoded metrics', () => {
    const failing = baselineFixture('FAIL_CLOSED')
    const forged = { ...failing, verdict: baselineFixture().verdict }

    expect(buildFixtureReport(reportFixture(0.01), forged)).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CandidateDevelopmentCommandEconomicGateInvalid',
        index: 2,
        expected: { name: 'positive_net_return', passed: false, actual: 0, required: '>0' },
        observed: {
          name: 'positive_net_return',
          passed: true,
          actual: 0.41421356237309515,
          required: '>0',
        },
      },
    })
  })

  test('rejects passing summaries that disagree with the strategy simulation trace', () => {
    const baseline = baselineFixture()
    const tampered = {
      ...baseline,
      simulation: {
        ...baseline.simulation,
        dailyMarks: baseline.simulation.dailyMarks.map((mark) => ({
          ...mark,
          equityMicros: fixtureInitialCapitalMicros,
          cashMicros: fixtureInitialCapitalMicros,
          peakEquityMicros: fixtureInitialCapitalMicros,
        })),
      },
    }

    expect(buildFixtureReport(reportFixture(0.01), tampered)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'reconstruction-failed',
        field: 'accounting',
      },
    })
  })

  test('rejects strategy event totals that disagree with daily marks', () => {
    const baseline = baselineFixture()
    const event = baseline.events[0]
    if (event?.kind !== 'cash-yield') throw new Error('fixture must begin with cash yield')
    const tampered = {
      ...baseline,
      events: [{ ...event, amountMicros: '999999' }, ...baseline.events.slice(1)],
    }

    expect(buildFixtureReport(reportFixture(0.01), tampered)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'reconstruction-failed',
        field: 'accounting',
        cause: [{ _tag: 'EvidenceMismatch', problem: { _tag: 'CashYield' } }],
      },
    })
  })

  test('rejects selected strategy marks that disagree with marked equity', () => {
    const baseline = baselineFixture()
    const first = baseline.equitySeries[0]
    const tampered = {
      ...baseline,
      equitySeries: [{ ...first, evaluatorEquityMicros: '1999999' }, ...baseline.equitySeries.slice(1)],
    }

    expect(buildFixtureReport(reportFixture(0.01), tampered)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'proof-mismatch',
        field: 'accounting.markedEquityProof',
      },
    })
  })

  test('rejects a forged selected net return after full accounting reconciliation', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const first = baseline.simulation.dailyMarks[0]
    const tamperedMark = { ...first, netReturn: first.netReturn + 0.01 }
    const tamperedBaseline = {
      ...baseline,
      simulation: {
        ...baseline.simulation,
        dailyMarks: [tamperedMark, ...baseline.simulation.dailyMarks.slice(1)],
      },
    }
    const evaluation = commandEvaluationFixture(report, tamperedBaseline, baseline)
    const accounting = {
      ...evaluation.accounting,
      baselineSimulation: {
        ...evaluation.accounting.baselineSimulation,
        dailyMarks: [tamperedMark, ...evaluation.accounting.baselineSimulation.dailyMarks.slice(1)],
      },
    }

    expect(buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting })).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
        series: 'strategy',
        reason: 'return-mismatch',
        field: 'netReturn',
      },
    })
  })

  test('rebuilds marked equity instead of trusting a supplied proof', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const first = baseline.simulation.dailyMarks[0]
    const tamperedMark = { ...first, cashMicros: fixtureInitialCapitalMicros }
    const tamperedBaseline = {
      ...baseline,
      simulation: {
        ...baseline.simulation,
        dailyMarks: [tamperedMark, ...baseline.simulation.dailyMarks.slice(1)],
      },
    }
    const evaluation = commandEvaluationFixture(report, tamperedBaseline, baseline)
    const accounting = {
      ...evaluation.accounting,
      baselineSimulation: {
        ...evaluation.accounting.baselineSimulation,
        dailyMarks: [tamperedMark, ...evaluation.accounting.baselineSimulation.dailyMarks.slice(1)],
      },
    }

    expect(buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting })).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'reconstruction-failed',
        field: 'accounting',
      },
    })
  })

  test('rebuilds stressed marked equity instead of trusting positive stressed summaries', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const evaluation = commandEvaluationFixture(report, baseline)
    const stressedSimulation = {
      ...report.doubledCost.stressed.simulation,
      cashChanges: [],
    }
    const tamperedReport = {
      ...report,
      doubledCost: {
        ...report.doubledCost,
        stressed: {
          ...report.doubledCost.stressed,
          simulation: stressedSimulation,
        },
      },
    }
    const tamperedEvaluation = {
      ...evaluation,
      stressed: tamperedReport.doubledCost.stressed,
      accounting: {
        ...evaluation.accounting,
        stressedEvents: [],
        stressedSimulation,
      },
    }

    expect(buildCandidateDevelopmentCommandReport(tamperedReport, tamperedEvaluation)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'reconstruction-failed',
        field: 'accounting.stressed',
      },
    })
  })

  test('rejects a reconciled accounting suffix after the selected qualification window', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const lastMark = baseline.simulation.dailyMarks.at(-1)
    if (lastMark === undefined) throw new Error('baseline fixture must be nonempty')
    const suffixDate = new Date(Date.parse(`${lastMark.sessionDate}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10) as IsoDate
    const fullSimulation = {
      ...baseline.simulation,
      dailyMarks: [...baseline.simulation.dailyMarks, { ...lastMark, sessionDate: suffixDate, netReturn: 0 }],
    }
    const proof = reconcileMarkedEquity({
      runId: baseline.runId,
      initialCapitalMicros: baseline.initialCapitalMicros,
      evaluatorTotalFeesMicros: baseline.strategy.totalFeesMicros,
      evaluatorEndingEquityMicros: baseline.strategy.endingEquityMicros,
      events: baseline.events,
      simulation: fullSimulation,
    })
    if (Result.isFailure(proof)) throw new Error(`suffix proof failed: ${JSON.stringify(proof.failure)}`)
    const baselineWithFullProof = {
      ...baseline,
      equitySeries: proof.success.equitySeries,
      markedEquityReconciliation: proof.success.reconciliation,
    }
    const evaluation = commandEvaluationFixture(report, baselineWithFullProof)
    const accounting = { ...evaluation.accounting, baselineSimulation: fullSimulation }

    expect(buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting })).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'selected-trace-mismatch',
        field: 'baselineSimulation.terminalSession',
        expected: lastMark.sessionDate,
        observed: suffixDate,
      },
    })
  })

  test('rejects decision evidence after the governed qualification window', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const lastMark = baseline.simulation.dailyMarks.at(-1)
    if (lastMark === undefined) throw new Error('baseline fixture must be nonempty')
    const postWindowDate = new Date(Date.parse(`${lastMark.sessionDate}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10) as IsoDate
    const decisionPayload = {
      kind: 'decision' as const,
      signalDate: postWindowDate,
      executionDate: postWindowDate,
      targetWeights: { SPY: 0 },
    }
    const decision = {
      ...decisionPayload,
      id: canonicalHashV1({ runId: baseline.runId, ...decisionPayload }),
    }
    const baselineWithDecision = { ...baseline, events: [...baseline.events, decision] }
    const evaluation = commandEvaluationFixture(report, baselineWithDecision)

    expect(buildCandidateDevelopmentCommandReport(report, evaluation)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'selected-trace-mismatch',
        field: 'baselineSimulation.events.signalDate',
        expected: `<=${lastMark.sessionDate}`,
        observed: postWindowDate,
      },
    })
  })

  test('keeps the sole report write attached through interruption', async () => {
    const report = successOf(buildFixtureReport(reportFixture(0.01), baselineFixture()))

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let completed = false
        const fiber = yield* writeCandidateDevelopmentCommandReport(report, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true
              }),
            ),
          ),
        ).pipe(Effect.forkChild)

        yield* Deferred.await(started)
        const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(interruption.pollUnsafe()).toBeUndefined()
        expect(completed).toBe(false)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interruption)

        expect(completed).toBe(true)
      }),
    )
  })

  test('requires the exact executable program shape before execution', () => {
    expect(validateCandidateDevelopmentExecutableProgram({})).toEqual(
      Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'schema-version-mismatch' }),
    )
    expect(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        input: {},
        effects: {},
      }),
    ).toEqual(Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effect-function-missing' }))

    expect(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        input: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          expectedStrategyProtocolHash: 'a'.repeat(64),
          signalSessionDates: [],
          featureLookbackSessions: 126,
        },
        effects: {
          preregisterCandidate: () => Effect.succeed('registration'),
          loadDevelopmentData: () => Effect.succeed('data'),
          evaluateDevelopment: () => Effect.fail('not-executed'),
        },
      }),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CandidateDevelopmentCommandProgramInvalid',
        reason: 'input-invalid',
      },
    })
  })

  test('preserves the protocol-valid zero-session feature lookback', () => {
    const program = validateCandidateDevelopmentExecutableProgram({
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: 'a'.repeat(64),
        officialSessions: [],
        signalSessionDates: [],
        featureLookbackSessions: 0,
      },
      effects: {
        preregisterCandidate: () => Effect.succeed('registration'),
        loadDevelopmentData: () => Effect.succeed('data'),
        evaluateDevelopment: () => Effect.fail('not-executed'),
      },
    })

    expect(program).toMatchObject({
      _tag: 'Success',
      success: { input: { featureLookbackSessions: 0 } },
    })
  })

  test('rejects malformed loaded evaluation output through the typed command channel', async () => {
    const sessions = frozenCandidateDevelopmentSessions()
    const validated = successOf(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        input: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          expectedStrategyProtocolHash: 'a'.repeat(64),
          officialSessions: sessions,
          signalSessionDates: officialMonthEndSignalDates(sessions),
          featureLookbackSessions: 126,
        },
        effects: {
          preregisterCandidate: () => Effect.succeed('registration'),
          loadDevelopmentData: () => Effect.succeed('data'),
          evaluateDevelopment: () => Effect.succeed({ baseline: {} }),
        },
      }),
    )

    expect(await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(validated)))).toMatchObject({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'evaluation-invalid',
    })
  })

  test('runtime-decodes the complete command evaluation witness', async () => {
    const sessions = frozenCandidateDevelopmentSessions()
    const report = reportFixture(0.01)
    const evaluation = commandEvaluationFixture(report, baselineFixture())
    const validated = successOf(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        input: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          expectedStrategyProtocolHash: 'a'.repeat(64),
          officialSessions: sessions,
          signalSessionDates: officialMonthEndSignalDates(sessions),
          featureLookbackSessions: 126,
        },
        effects: {
          preregisterCandidate: () => Effect.succeed('registration'),
          loadDevelopmentData: () => Effect.succeed('data'),
          evaluateDevelopment: () => Effect.succeed(evaluation),
        },
      }),
    )

    const direct = validateCandidateDevelopmentCommandEvaluation(evaluation)
    if (Result.isFailure(direct)) {
      const cause =
        direct.failure._tag === 'CandidateDevelopmentCommandProgramInvalid' ? direct.failure.cause : direct.failure
      throw new Error(`complete evaluation decode failed: ${String(cause)}`)
    }

    const decoded = await Effect.runPromise(validated.effects.evaluateDevelopment(undefined, undefined as never))

    expect(decoded.accounting.schemaVersion).toBe('bayn.candidate-development-accounting-evidence.v1')
    expect(decoded.accounting.runId).toBe(evaluation.baseline.runId)
    expect(decoded.accounting.baselineSimulation.dailyMarks).toHaveLength(504)
  })

  test('keeps dynamic module evaluation attached through interruption', async () => {
    const program = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: 'a'.repeat(64),
        officialSessions: [],
        signalSessionDates: [],
        featureLookbackSessions: 126,
      },
      effects: {
        preregisterCandidate: () => Effect.succeed('registration'),
        loadDevelopmentData: () => Effect.succeed('data'),
        evaluateDevelopment: () => Effect.fail('not-executed'),
      },
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let completed = false
        const fiber = yield* loadCandidateDevelopmentExecutableProgram('/tmp/candidate-development-program.ts', () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true
              }),
            ),
            Effect.as({ candidateDevelopmentProgram: program }),
          ),
        ).pipe(Effect.forkChild)

        yield* Deferred.await(started)
        const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(interruption.pollUnsafe()).toBeUndefined()
        expect(completed).toBe(false)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interruption)

        expect(completed).toBe(true)
      }),
    )
  })
})
