import { describe, expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Result } from 'effect'

import { frozenCandidateDevelopmentSessions } from './candidate-development-calendar'
import {
  buildCandidateDevelopmentCommandReport as buildCandidateDevelopmentCommandReportPure,
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
import { MICROS, referencePriceMicros } from './execution-model'
import { alignBars, directVolatilityWeights, simulate, type SimulationTarget } from './simulation'
import { calculateExactPerformanceMetrics, buildVerdict } from './simulation/metrics'
import { reconcileMarkedEquity } from './simulation-reconciliation'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyPerformancePoint,
  type EvaluationResult,
  type IsoDate,
} from './types'

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

const exactMetrics = (points: readonly DailyPerformancePoint[]) => {
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
  precision: {
    ...defaultProtocolDocument.executionModel.precision,
    minimumBuyNotionalMicros: '1',
  },
  cash: { ...defaultProtocolDocument.executionModel.cash, annualYieldBps: 10_000 },
}
const fixtureCashYieldMicros = '2739'
const fixtureYieldEndingEquityMicros = (BigInt(fixtureInitialCapitalMicros) + BigInt(fixtureCashYieldMicros)).toString()

const fixtureHistorySessions = Array.from(
  { length: 64 },
  (_, index) => new Date(Date.UTC(2019, 9, 29 + index)).toISOString().slice(0, 10) as IsoDate,
)
const fixtureAccountingStart = fixtureHistorySessions.at(-1) as IsoDate
const fixtureOfficialSessions = [...fixtureHistorySessions, ...fixtureSessions]

const fixtureSpyClose = (sessionDate: IsoDate): number => {
  const index = fixtureOfficialSessions.indexOf(sessionDate)
  if (index < 0) throw new Error(`fixture market session ${sessionDate} is missing`)
  return Number.parseFloat((0.012 - index * 0.000007 + (index % 2 === 0 ? 0.000001 : -0.000001)).toFixed(8))
}

const fixtureMarketBars = fixtureOfficialSessions.flatMap((sessionDate) =>
  defaultProtocolDocument.universe.map((symbol) => {
    const close = symbol === 'SPY' ? fixtureSpyClose(sessionDate) : 1
    return {
      symbol,
      sessionDate,
      open: close,
      high: Number.parseFloat((close * 1.01).toFixed(8)),
      low: Number.parseFloat((close * 0.99).toFixed(8)),
      close,
      volume: 1_000_000,
      source: DataSource.Alpaca,
      sourceFeed: DataFeed.Sip,
      adjustment: PriceAdjustment.All,
      publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
    }
  }),
)

const zeroPositionFixture = (sessionDate: IsoDate) => ({
  symbol: 'SPY',
  quantityMicros: '0',
  costBasisMicros: '0',
  priceMicros: successOf(referencePriceMicros(fixtureSpyClose(sessionDate), fixtureExecutionModel)).toString(),
  marketValueMicros: '0',
})

const buildCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol = fixtureStrategyProtocol,
  officialSessions = fixtureOfficialSessions,
) => buildCandidateDevelopmentCommandReportPure(report, evaluation, strategyProtocol, officialSessions)
const fullAccountingSimulationFixture = <A extends EvaluationResult['simulation']>(simulation: A): A =>
  ({
    ...simulation,
    dailyMarks: [
      {
        sessionDate: fixtureAccountingStart,
        equityMicros: fixtureInitialCapitalMicros,
        netReturn: 0,
        turnoverMicros: '0',
        cumulativeTurnoverMicros: '0',
        feeMicros: '0',
        cumulativeFeesMicros: '0',
        spreadCostMicros: '0',
        cumulativeSpreadCostMicros: '0',
        slippageCostMicros: '0',
        cumulativeSlippageCostMicros: '0',
        cashYieldMicros: '0',
        cumulativeCashYieldMicros: '0',
        peakEquityMicros: fixtureInitialCapitalMicros,
        drawdown: 0,
        cashMicros: fixtureInitialCapitalMicros,
        positions: [zeroPositionFixture(fixtureAccountingStart)],
      },
      ...simulation.dailyMarks,
    ],
  }) as A

const makeSignalDecisionFixture = (signalDate: IsoDate, executionDate: IsoDate) => {
  const eventPayload = { signalDate, executionDate, targetWeights: { SPY: 0 } }
  const decisionId = canonicalHashV1({ runId: fixtureRunId, kind: 'decision', ...eventPayload })
  return {
    signal: {
      schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1' as const,
      decisionId,
      signalDate,
      executionDate,
      covarianceWindow: {
        returnCount: 1,
        firstSession: signalDate,
        lastSession: signalDate,
        sessionsHash: canonicalHashV1({ signalDate }),
      },
      estimatedAnnualizedPortfolioVolatility: 0,
      exposureScale: 0,
      targetWeights: eventPayload.targetWeights,
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
    },
    event: { kind: 'decision' as const, id: decisionId, ...eventPayload },
  }
}

const firstDecisionFixture = makeSignalDecisionFixture(fixtureSessions[0], fixtureSessions[1])
const terminalDecisionFixture = makeSignalDecisionFixture(
  fixtureSessions.at(-2) as IsoDate,
  fixtureSessions.at(-1) as IsoDate,
)
const signalDecisionFixture = firstDecisionFixture.signal
const fixtureSignalDecisions = [firstDecisionFixture.signal, terminalDecisionFixture.signal]
const fixtureDecisionEvents = [firstDecisionFixture.event, terminalDecisionFixture.event]

const fixtureBenchmarkSeries = (): {
  readonly buyAndHold: readonly DailyPerformancePoint[]
  readonly directVolTiming: readonly DailyPerformancePoint[]
} => {
  const sessions = successOf(alignBars(fixtureMarketBars, fixtureStrategyProtocol.universe, fixtureInputManifest))
  const sessionIndex = new Map(sessions.map((session, index) => [session.date, index] as const))
  const startIndex = sessionIndex.get(fixtureAccountingStart)
  const firstSignalIndex = sessionIndex.get(firstDecisionFixture.signal.signalDate)
  const firstExecutionIndex = sessionIndex.get(firstDecisionFixture.signal.executionDate)
  const terminalSignalIndex = sessionIndex.get(terminalDecisionFixture.signal.signalDate)
  const terminalExecutionIndex = sessionIndex.get(terminalDecisionFixture.signal.executionDate)
  if (
    startIndex === undefined ||
    firstSignalIndex === undefined ||
    firstExecutionIndex === undefined ||
    terminalSignalIndex === undefined ||
    terminalExecutionIndex === undefined
  ) {
    throw new Error('fixture benchmark schedule is incomplete')
  }
  const protocol = { ...fixtureStrategyProtocol, universe: ['SPY'] }
  const directWeights = successOf(directVolatilityWeights(sessions, firstSignalIndex, protocol))
  const terminalTarget: SimulationTarget = {
    signalIndex: terminalSignalIndex,
    executionIndex: terminalExecutionIndex,
    weights: { SPY: 0 },
  }
  const benchmarkRunId = canonicalHashV1({
    schemaVersion: 'bayn.candidate-development-benchmark-run.v1',
    candidateRunId: fixtureRunId,
    marketDataContentHash: fixtureMarketData.contentHash,
    policy: fixtureStrategyProtocol.benchmarks,
  })
  const buyAndHold = successOf(
    simulate(
      sessions,
      [{ signalIndex: startIndex - 1, executionIndex: startIndex, weights: { SPY: 1 } }, terminalTarget],
      startIndex,
      protocol,
      MICROS,
      benchmarkRunId,
      false,
    ),
  )
  const directVolTiming = successOf(
    simulate(
      sessions,
      [
        {
          signalIndex: firstSignalIndex,
          executionIndex: firstExecutionIndex,
          weights: directWeights,
        },
        terminalTarget,
      ],
      startIndex,
      protocol,
      MICROS,
      benchmarkRunId,
      false,
    ),
  )
  const select = (series: readonly DailyPerformancePoint[]): readonly DailyPerformancePoint[] => {
    const bySession = new Map(series.map((point) => [point.sessionDate, point] as const))
    const selected = fixtureSessions.map((sessionDate) => bySession.get(sessionDate))
    if (selected.some((point) => point === undefined)) throw new Error('fixture benchmark selection is incomplete')
    const complete = selected as readonly DailyPerformancePoint[]
    const first = complete[0]
    return [
      {
        ...first,
        netReturn: Number(first.equityMicros) / Number(fixtureInitialCapitalMicros) - 1,
      },
      ...complete.slice(1),
    ]
  }
  return { buyAndHold: select(buyAndHold.dailyPerformance), directVolTiming: select(directVolTiming.dailyPerformance) }
}

const inputManifestFixture = () => {
  const firstSession = fixtureOfficialSessions[0]
  const lastSession = fixtureOfficialSessions.at(-1)
  if (firstSession === undefined || lastSession === undefined) throw new Error('fixture sessions must be nonempty')
  const symbols = defaultProtocolDocument.universe.map((symbol) => ({
    symbol,
    rows: fixtureOfficialSessions.length,
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
    rowCount: fixtureOfficialSessions.length * symbols.length,
    sessionCount: fixtureOfficialSessions.length,
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
      publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
      universeId: 'cross-asset-taa-v1' as const,
      universeSymbolHash: sha256(defaultProtocolDocument.universe.join(',')),
      snapshotId: '4'.repeat(64),
      publicationId: '5'.repeat(64),
      source: DataSource.Alpaca,
      sourceFeed: DataFeed.Sip,
      adjustment: PriceAdjustment.All,
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
      rowCount: fixtureOfficialSessions.length * symbols.length,
      sessionCount: fixtureOfficialSessions.length,
      contentHash: '8'.repeat(64),
      sessionsContentHash: '9'.repeat(64),
    },
  }
  return { ...material, hash: canonicalHashV1(material) }
}

const fixtureInputManifest = inputManifestFixture()
const fixtureMarketDataMaterial = {
  schemaVersion: 'bayn.candidate-development-market-data-witness.v1' as const,
  snapshotId: fixtureInputManifest.finalizedSnapshot.snapshotId,
  inputManifestHash: fixtureInputManifest.hash,
  bars: fixtureMarketBars,
}
const fixtureMarketData = {
  ...fixtureMarketDataMaterial,
  contentHash: canonicalHashV1(fixtureMarketDataMaterial),
}

const fixtureStrategyProtocol = {
  schemaVersion: 'bayn.candidate-development-strategy-protocol.v2' as const,
  universe: [...defaultProtocolDocument.universe],
  directVolatilityTarget: defaultProtocolDocument.directVolatilityTarget,
  initialCapitalMicros: fixtureInitialCapitalMicros,
  executionModel: fixtureExecutionModel,
  thresholds: defaultProtocolDocument.thresholds,
  marketData: {
    schemaVersion: 'bayn.candidate-development-market-data-contract.v1' as const,
    snapshotId: fixtureMarketData.snapshotId,
    contentHash: fixtureMarketData.contentHash,
  },
  benchmarks: {
    schemaVersion: 'bayn.candidate-development-benchmark-policy.v1' as const,
    symbol: 'SPY',
    directVolatilityWindow: 63 as const,
    terminalPolicy: 'last-all-cash-strategy-decision' as const,
  },
}
const fixtureStrategyProtocolHash = canonicalHashV1(fixtureStrategyProtocol)

const fixtureStressedRunId = fixtureRunId

const stressedAccountingFixture = (endingEquityMicros: string) => {
  const cashYieldMicros = BigInt(endingEquityMicros) - BigInt(fixtureInitialCapitalMicros)
  if (cashYieldMicros < 0n) throw new Error('stressed fixture cannot have negative cash yield')
  const eventPayload = {
    kind: 'cash-yield' as const,
    sessionDate: fixtureSessions[0],
    elapsedDays: 1,
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
  const events = cashYieldMicros === 0n ? fixtureDecisionEvents : [...fixtureDecisionEvents, event]
  const cashChanges = cashYieldMicros === 0n ? [] : [cashChange]
  const simulation = {
    schemaVersion: 'bayn.simulation-trace.v3' as const,
    executionModel: fixtureExecutionModel,
    costMultiplierMicros: '2000000',
    orders: [],
    cashChanges,
    dailyMarks: performanceSeriesFixture(endingEquityMicros, {
      cashYieldMicros: cashYieldMicros.toString(),
    }).map((point) => ({
      ...point,
      cashMicros: point.equityMicros,
      positions: [zeroPositionFixture(point.sessionDate)],
    })),
  }
  const fullSimulation = fullAccountingSimulationFixture(simulation)
  const proof = reconcileMarkedEquity({
    runId: fixtureStressedRunId,
    initialCapitalMicros: fixtureInitialCapitalMicros,
    evaluatorTotalFeesMicros: '0',
    evaluatorEndingEquityMicros: endingEquityMicros,
    events,
    simulation: fullSimulation,
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
    fullSimulation,
    equitySeries: proof.success.equitySeries,
    markedEquityReconciliation: proof.success.reconciliation,
  }
}

const reportFixture = (
  annualizedReturnDifferenceLowerBound: number,
  stressedEndingEquityMicros = fixtureYieldEndingEquityMicros,
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
      strategyProtocolHash: fixtureStrategyProtocolHash,
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
        signalDecisions: fixtureSignalDecisions,
        simulation: stressed.simulation,
      },
    },
  } as unknown as CandidateDevelopmentReport
}

const baselineFixture = (
  status: 'PASS' | 'FAIL_CLOSED' = 'PASS',
  stressedEndingEquityMicros = fixtureYieldEndingEquityMicros,
): EvaluationResult => {
  const strategyEndingEquityMicros = status === 'PASS' ? fixtureYieldEndingEquityMicros : fixtureInitialCapitalMicros
  const strategyPoints = performanceSeriesFixture(
    strategyEndingEquityMicros,
    status === 'PASS' ? { cashYieldMicros: fixtureCashYieldMicros } : {},
  )
  const strategy = exactMetrics(strategyPoints)
  const rebuiltBenchmarks = fixtureBenchmarkSeries()
  const buyAndHoldPoints = rebuiltBenchmarks.buyAndHold
  const directVolTimingPoints = rebuiltBenchmarks.directVolTiming
  const doubleCostPoints = performanceSeriesFixture(stressedEndingEquityMicros, {
    cashYieldMicros: (BigInt(stressedEndingEquityMicros) - BigInt(fixtureInitialCapitalMicros)).toString(),
  })
  const buyAndHold = exactMetrics(buyAndHoldPoints)
  const directVolTiming = exactMetrics(directVolTimingPoints)
  const doubleCostStrategy = exactMetrics(doubleCostPoints)
  const eventPayload = {
    kind: 'cash-yield' as const,
    sessionDate: fixtureSessions[0],
    elapsedDays: 1,
    annualYieldBps: 10_000,
    amountMicros: fixtureCashYieldMicros,
  }

  const event = { ...eventPayload, id: canonicalHashV1({ runId: fixtureRunId, ...eventPayload }) }
  const cashChangePayload = {
    sourceKind: event.kind,
    sourceId: event.id,
    sessionDate: event.sessionDate,
    amountMicros: fixtureCashYieldMicros,
    cashAfterMicros: strategyEndingEquityMicros,
  }
  const cashChange = {
    ...cashChangePayload,
    id: canonicalHashV1({ runId: fixtureRunId, kind: 'cash-change', ...cashChangePayload }),
  }
  const events = status === 'PASS' ? [...fixtureDecisionEvents, event] : fixtureDecisionEvents
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
      positions: [zeroPositionFixture(point.sessionDate)],
    })),
  }
  const fullSimulation = fullAccountingSimulationFixture(simulation)
  const verdict = buildVerdict(strategy, buyAndHold, directVolTiming, doubleCostStrategy, fixtureStrategyProtocol)
  const markedEquityResult = reconcileMarkedEquity({
    runId: fixtureRunId,
    initialCapitalMicros: fixtureInitialCapitalMicros,
    evaluatorTotalFeesMicros: strategy.totalFeesMicros,
    evaluatorEndingEquityMicros: strategy.endingEquityMicros,
    events,
    simulation: fullSimulation,
  })
  if (Result.isFailure(markedEquityResult)) {
    throw new Error(`marked-equity fixture failed: ${JSON.stringify(markedEquityResult.failure)}`)
  }
  const markedEquity = markedEquityResult.success
  return {
    schemaVersion: 'bayn.evaluation.v6',
    runId: fixtureRunId,
    codeRevision: '2'.repeat(40),
    protocolHash: fixtureStrategyProtocolHash,
    initialCapitalMicros: '1000000',
    inputManifest: fixtureInputManifest,
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
    signalDecisions: fixtureSignalDecisions,
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
      schemaVersion: 'bayn.candidate-development-accounting-evidence.v2',
      runId: accountingBaseline.runId,
      initialCapitalMicros: accountingBaseline.initialCapitalMicros,
      evaluatorTotalFeesMicros: accountingBaseline.strategy.totalFeesMicros,
      evaluatorEndingEquityMicros: accountingBaseline.strategy.endingEquityMicros,
      events: accountingBaseline.events,
      baselineSimulation: fullAccountingSimulationFixture(accountingBaseline.simulation),
      equitySeries: accountingBaseline.equitySeries,
      markedEquityReconciliation: accountingBaseline.markedEquityReconciliation,
      signalDecisions: accountingBaseline.signalDecisions,
      stressedRunId: stressed.runId,
      stressedEvaluatorTotalFeesMicros: stressed.evaluatorTotalFeesMicros,
      stressedEvaluatorEndingEquityMicros: stressed.evaluatorEndingEquityMicros,
      stressedEvents: stressed.events,
      stressedSimulation: stressed.fullSimulation,
      stressedEquitySeries: stressed.equitySeries,
      stressedMarkedEquityReconciliation: stressed.markedEquityReconciliation,
    },
    marketData: fixtureMarketData,
  }
}

const buildFixtureReport = (report: CandidateDevelopmentReport, baseline: EvaluationResult) =>
  buildCandidateDevelopmentCommandReport(report, commandEvaluationFixture(report, baseline), fixtureStrategyProtocol)

describe('candidate development command', () => {
  test('calls no effects when preflight rejects the ordinal lineage', async () => {
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const program: CandidateDevelopmentExecutableProgram<string, string, string, never> = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      strategyProtocol: fixtureStrategyProtocol,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 14,
        expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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
      strategyProtocol: fixtureStrategyProtocol,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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
          actual: 0.0013685635169500276,
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
    const event = baseline.events.find(
      (candidate): candidate is Extract<EvaluationResult['events'][number], { readonly kind: 'cash-yield' }> =>
        candidate.kind === 'cash-yield',
    )
    if (event === undefined) throw new Error('fixture must contain cash yield')
    const tampered = {
      ...baseline,
      events: baseline.events.map((candidate) =>
        candidate.id === event.id ? { ...event, amountMicros: '999999' } : candidate,
      ),
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
        dailyMarks: evaluation.accounting.baselineSimulation.dailyMarks.map((mark) =>
          mark.sessionDate === tamperedMark.sessionDate ? tamperedMark : mark,
        ),
      },
    }

    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
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
        dailyMarks: evaluation.accounting.baselineSimulation.dailyMarks.map((mark) =>
          mark.sessionDate === tamperedMark.sessionDate ? tamperedMark : mark,
        ),
      },
    }

    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
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
        stressedEvents: evaluation.accounting.stressedEvents.filter((event) => event.kind === 'decision'),
        stressedSimulation,
      },
    }

    expect(
      buildCandidateDevelopmentCommandReport(tamperedReport, tamperedEvaluation, fixtureStrategyProtocol),
    ).toMatchObject({
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
    const accountingSimulation = fullAccountingSimulationFixture(baseline.simulation)
    const fullSimulation = {
      ...accountingSimulation,
      dailyMarks: [...accountingSimulation.dailyMarks, { ...lastMark, sessionDate: suffixDate, netReturn: 0 }],
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

    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol, [
        ...fixtureOfficialSessions,
        suffixDate,
      ]),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.dailyMarks.priceMicros',
        expected: 'governed mark session',
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
    const signalDecision = {
      ...signalDecisionFixture,
      decisionId: decision.id,
      signalDate: postWindowDate,
      executionDate: postWindowDate,
      covarianceWindow: {
        ...signalDecisionFixture.covarianceWindow,
        firstSession: postWindowDate,
        lastSession: postWindowDate,
      },
    }
    const baselineWithDecision = {
      ...baseline,
      events: [...baseline.events, decision],
      signalDecisions: [...baseline.signalDecisions, signalDecision],
    }
    const evaluation = commandEvaluationFixture(report, baselineWithDecision)

    expect(buildCandidateDevelopmentCommandReport(report, evaluation, fixtureStrategyProtocol)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'benchmarks.schedule',
        observed: { signalDate: postWindowDate, executionDate: postWindowDate },
      },
    })
  })

  test('requires every selected baseline decision to have one matching accounting event', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const withoutDecision = {
      ...baseline,
      events: baseline.events.filter((event) => event.kind !== 'decision'),
    }
    const evaluation = commandEvaluationFixture(report, withoutDecision)

    expect(buildCandidateDevelopmentCommandReport(report, evaluation, fixtureStrategyProtocol)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.decisionCount',
        expected: 2,
        observed: 0,
      },
    })
  })

  test('requires stressed accounting decisions to preserve selected target weights', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const evaluation = commandEvaluationFixture(report, baseline)
    const accounting = {
      ...evaluation.accounting,
      stressedEvents: evaluation.accounting.stressedEvents.map((event) =>
        event.kind === 'decision' ? { ...event, targetWeights: { SPY: 0.5 } } : event,
      ),
    }

    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'stressed.decision.targetWeights',
      },
    })
  })

  test('binds candidate economics to the hash-checked strategy protocol', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()

    const capitalProtocol = { ...fixtureStrategyProtocol, initialCapitalMicros: '1000001' }
    const capitalHash = canonicalHashV1(capitalProtocol)
    const capitalReport = {
      ...report,
      comparisonSemantics: { ...report.comparisonSemantics, strategyProtocolHash: capitalHash },
    }
    const capitalBaseline = { ...baseline, protocolHash: capitalHash }
    expect(
      buildCandidateDevelopmentCommandReport(
        capitalReport,
        commandEvaluationFixture(capitalReport, capitalBaseline),
        capitalProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'strategyProtocol.initialCapitalMicros',
        expected: '1000001',
        observed: fixtureInitialCapitalMicros,
      },
    })

    const universeProtocol = { ...fixtureStrategyProtocol, universe: [...fixtureStrategyProtocol.universe].reverse() }
    const universeHash = canonicalHashV1(universeProtocol)
    const universeReport = {
      ...report,
      comparisonSemantics: { ...report.comparisonSemantics, strategyProtocolHash: universeHash },
    }
    const universeBaseline = { ...baseline, protocolHash: universeHash }
    expect(
      buildCandidateDevelopmentCommandReport(
        universeReport,
        commandEvaluationFixture(universeReport, universeBaseline),
        universeProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'strategyProtocol.universe',
      },
    })

    const executionModel = {
      ...fixtureExecutionModel,
      priceImpact: { ...fixtureExecutionModel.priceImpact, halfSpreadBps: 1 },
    }
    const executionBaseline = {
      ...baseline,
      simulation: { ...baseline.simulation, executionModel },
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, executionBaseline),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'strategyProtocol.baselineExecutionModel',
      },
    })
  })

  test('derives baseline and stressed cash-yield intervals from adjacent accounting sessions', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const baselineYield = baseline.events.find(
      (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'cash-yield' }> =>
        event.kind === 'cash-yield',
    )
    if (baselineYield === undefined) throw new Error('baseline fixture must contain cash yield')
    const baselineWithWrongInterval = {
      ...baseline,
      events: baseline.events.map((event) =>
        event.id === baselineYield.id ? { ...baselineYield, elapsedDays: 2 } : event,
      ),
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, baselineWithWrongInterval),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.cashYield.elapsedDays',
        expected: 1,
        observed: 2,
      },
    })

    const evaluation = commandEvaluationFixture(report, baseline)
    const stressedYield = evaluation.accounting.stressedEvents.find(
      (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'cash-yield' }> =>
        event.kind === 'cash-yield',
    )
    if (stressedYield === undefined) throw new Error('stressed fixture must contain cash yield')
    const accounting = {
      ...evaluation.accounting,
      stressedEvents: evaluation.accounting.stressedEvents.map((event) =>
        event.id === stressedYield.id ? { ...stressedYield, elapsedDays: 2 } : event,
      ),
    }
    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'stressed.cashYield.elapsedDays',
        expected: 1,
        observed: 2,
      },
    })
  })

  test('binds the accounting predecessor to the immediately preceding official session', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const evaluation = commandEvaluationFixture(report, baseline)
    const skippedSession = '2019-12-30' as IsoDate
    const accounting = {
      ...evaluation.accounting,
      baselineSimulation: {
        ...evaluation.accounting.baselineSimulation,
        dailyMarks: evaluation.accounting.baselineSimulation.dailyMarks.map((mark, index) =>
          index === 0 ? { ...mark, sessionDate: skippedSession } : mark,
        ),
      },
    }

    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol, [
        skippedSession,
        ...fixtureOfficialSessions,
      ]),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.calendar.sessionDate',
        index: 1,
        expected: fixtureOfficialSessions[0],
        observed: fixtureSessions[0],
      },
    })
  })

  test('rejects every out-of-universe accounting symbol before reconciliation', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const qqqPosition = { ...zeroPositionFixture(fixtureSessions[0]), symbol: 'QQQ' }
    const qqqOrder: EvaluationResult['simulation']['orders'][number] = {
      id: 'd'.repeat(64),
      decisionId: firstDecisionFixture.signal.decisionId,
      sessionDate: fixtureSessions[1],
      symbol: 'QQQ',
      side: 'buy',
      requestedQuantityMicros: '1',
      filledQuantityMicros: '0',
      status: 'rejected',
      rejectionReason: 'zero-after-rounding',
      unfilledRemainder: 'none',
    }
    const qqqFill: Extract<EvaluationResult['events'][number], { readonly kind: 'fill' }> = {
      kind: 'fill',
      id: 'e'.repeat(64),
      orderId: qqqOrder.id,
      decisionId: firstDecisionFixture.signal.decisionId,
      sessionDate: fixtureSessions[1],
      symbol: 'QQQ',
      side: 'buy',
      quantityMicros: '1',
      referencePriceMicros: '1000000',
      priceMicros: '1000000',
      notionalMicros: '1',
      spreadCostMicros: '0',
      slippageCostMicros: '0',
      costBasisMicros: '1',
    }

    const decisionBaseline = {
      ...baseline,
      signalDecisions: baseline.signalDecisions.map((decision) => ({
        ...decision,
        targetWeights: { ...decision.targetWeights, QQQ: 0 },
      })),
      events: baseline.events.map((event) =>
        event.kind === 'decision' ? { ...event, targetWeights: { ...event.targetWeights, QQQ: 0 } } : event,
      ),
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, decisionBaseline),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: { field: 'baseline.signalDecisions.targetWeights', observed: 'QQQ' },
    })

    const orderBaseline = {
      ...baseline,
      simulation: { ...baseline.simulation, orders: [qqqOrder] },
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, orderBaseline),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({ failure: { field: 'baseline.orders.symbol', observed: 'QQQ' } })

    const fillBaseline = { ...baseline, events: [...baseline.events, qqqFill] }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, fillBaseline),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({ failure: { field: 'baseline.events.symbol', observed: 'QQQ' } })

    const positionBaseline = {
      ...baseline,
      simulation: {
        ...baseline.simulation,
        dailyMarks: baseline.simulation.dailyMarks.map((mark, index) =>
          index === 0 ? { ...mark, positions: [...mark.positions, qqqPosition] } : mark,
        ),
      },
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, positionBaseline),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({ failure: { field: 'baseline.positions.symbol', observed: 'QQQ' } })

    const evaluation = commandEvaluationFixture(report, baseline)
    const stressedAccounting = {
      ...evaluation.accounting,
      stressedSimulation: {
        ...evaluation.accounting.stressedSimulation,
        dailyMarks: evaluation.accounting.stressedSimulation.dailyMarks.map((mark, index) =>
          index === 0 ? { ...mark, positions: [...mark.positions, qqqPosition] } : mark,
        ),
      },
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        { ...evaluation, accounting: stressedAccounting },
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({ failure: { field: 'stressed.positions.symbol', observed: 'QQQ' } })
  })

  test('rejects a requested order that a zero-weight decision cannot derive', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const orderPayload = {
      decisionId: firstDecisionFixture.signal.decisionId,
      sessionDate: firstDecisionFixture.signal.executionDate,
      symbol: 'SPY',
      side: 'buy' as const,
      requestedQuantityMicros: '1000000',
      filledQuantityMicros: '0',
      status: 'rejected' as const,
      rejectionReason: 'zero-after-rounding' as const,
      unfilledRemainder: 'canceled' as const,
    }
    const impossibleOrder = {
      ...orderPayload,
      id: canonicalHashV1({ runId: baseline.runId, kind: 'order', ...orderPayload }),
    }
    const baselineWithOrder = {
      ...baseline,
      simulation: { ...baseline.simulation, orders: [impossibleOrder] },
    }

    expect(buildFixtureReport(report, baselineWithOrder)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.orders',
      },
    })
  })

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
        strategyProtocol: fixtureStrategyProtocol,
        input: {},
        effects: {},
      }),
    ).toEqual(Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effect-function-missing' }))

    expect(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        strategyProtocol: fixtureStrategyProtocol,
        input: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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

  test('rejects strategy protocol bytes that disagree with the preregistered hash', () => {
    const changedProtocol = { ...fixtureStrategyProtocol, initialCapitalMicros: '1000001' }

    expect(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        strategyProtocol: changedProtocol,
        input: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
          officialSessions: [],
          signalSessionDates: [],
          featureLookbackSessions: 0,
        },
        effects: {
          preregisterCandidate: () => Effect.succeed('registration'),
          loadDevelopmentData: () => Effect.succeed('data'),
          evaluateDevelopment: () => Effect.fail('not-executed'),
        },
      }),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandProgramInvalid',
        reason: 'strategy-protocol-hash-mismatch',
        cause: {
          expected: fixtureStrategyProtocolHash,
          observed: canonicalHashV1(changedProtocol),
        },
      },
    })
  })

  test('preserves the protocol-valid zero-session feature lookback', () => {
    const program = validateCandidateDevelopmentExecutableProgram({
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      strategyProtocol: fixtureStrategyProtocol,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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
        strategyProtocol: fixtureStrategyProtocol,
        input: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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
        strategyProtocol: fixtureStrategyProtocol,
        input: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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

    expect(decoded.accounting.schemaVersion).toBe('bayn.candidate-development-accounting-evidence.v2')
    expect(decoded.accounting.runId).toBe(evaluation.baseline.runId)
    expect(decoded.accounting.baselineSimulation.dailyMarks).toHaveLength(505)
  })

  test('keeps dynamic module evaluation attached through interruption', async () => {
    const program = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      strategyProtocol: fixtureStrategyProtocol,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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
