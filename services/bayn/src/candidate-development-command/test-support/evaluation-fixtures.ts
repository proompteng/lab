import {
  alignBars,
  buildCandidateDevelopmentCommandReportPure,
  buildVerdict,
  calculateExactPerformanceMetrics,
  candidateDevelopmentComparisonSemantics,
  canonicalHashV1,
  DataFeed,
  DataSource,
  defaultProtocolDocument,
  directVolatilityWeights,
  MICROS,
  officialMonthEndSignalDates,
  PriceAdjustment,
  PublicationSchema,
  reconcileMarkedEquity,
  referencePriceMicros,
  sha256,
  simulate,
  type CandidateDevelopmentCommandEvaluation,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentReport,
  type CandidateDevelopmentSourceManifest,
  type CandidateDevelopmentVerifiedModuleSource,
  type CandidateDevelopmentVerifiedSource,
  type CandidateDevelopmentVerifiedSourceFiles,
  type DailyPerformancePoint,
  type EvaluationResult,
  type IsoDate,
  type SimulationTarget,
} from '../test-api'
import { successOf } from './process'
import { frozenSourceInput, frozenSourceStrategyProtocol, frozenSourceVerifiedSourceFiles } from './provenance-fixtures'
import { Result } from '../test-runtime'

export const fixtureInitialCapitalMicros = '1000000'
export const fixtureRunId = '1'.repeat(64)
export const fixtureSessions = Array.from(
  { length: 504 },
  (_, index) => new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10) as IsoDate,
)

export const exactMetrics = (points: readonly DailyPerformancePoint[]) => {
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

export const fixtureExecutionModel = {
  ...defaultProtocolDocument.executionModel,
  precision: {
    ...defaultProtocolDocument.executionModel.precision,
    minimumBuyNotionalMicros: '1',
  },
  cash: { ...defaultProtocolDocument.executionModel.cash, annualYieldBps: 10_000 },
}
export const fixtureHistorySessions = Array.from(
  { length: 64 },
  (_, index) => new Date(Date.UTC(2019, 9, 29 + index)).toISOString().slice(0, 10) as IsoDate,
)
export const fixtureAccountingStart = fixtureHistorySessions.at(-1) as IsoDate
export const fixtureOfficialSessions = [...fixtureHistorySessions, ...fixtureSessions]

export const fixtureSpyClose = (sessionDate: IsoDate): number => {
  const index = fixtureOfficialSessions.indexOf(sessionDate)
  if (index < 0) throw new Error(`fixture market session ${sessionDate} is missing`)
  return Number.parseFloat((0.012 - index * 0.000007 + (index % 2 === 0 ? 0.000001 : -0.000001)).toFixed(8))
}

export const fixtureMarketBars = fixtureOfficialSessions.flatMap((sessionDate) =>
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

export const zeroPositionFixture = (sessionDate: IsoDate, symbol = 'SPY') => ({
  symbol,
  quantityMicros: '0',
  costBasisMicros: '0',
  priceMicros: successOf(
    referencePriceMicros(symbol === 'SPY' ? fixtureSpyClose(sessionDate) : 1, fixtureExecutionModel),
  ).toString(),
  marketValueMicros: '0',
})

export const buildCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol = fixtureStrategyProtocol,
  officialSessions = fixtureOfficialSessions,
  verifiedSource = fixtureVerifiedSource,
) => buildCandidateDevelopmentCommandReportPure(report, evaluation, strategyProtocol, officialSessions, verifiedSource)
export const fullAccountingSimulationFixture = <A extends EvaluationResult['simulation']>(simulation: A): A =>
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
        positions: fixtureStrategyProtocol.universe.map((symbol) =>
          zeroPositionFixture(fixtureAccountingStart, symbol),
        ),
      },
      ...simulation.dailyMarks,
    ],
  }) as A

export const makeSignalDecisionFixture = (signalDate: IsoDate, executionDate: IsoDate) => {
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

export const firstDecisionFixture = makeSignalDecisionFixture(fixtureSessions[0], fixtureSessions[1])
export const terminalDecisionFixture = makeSignalDecisionFixture(
  fixtureSessions.at(-2) as IsoDate,
  fixtureSessions.at(-1) as IsoDate,
)
export const signalDecisionFixture = firstDecisionFixture.signal
export const fixtureSignalDecisions = [firstDecisionFixture.signal, terminalDecisionFixture.signal]

export const fixtureBenchmarkSeries = (
  buyAtAccountingPredecessor = false,
): {
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
      [
        {
          signalIndex: buyAtAccountingPredecessor ? startIndex - 1 : startIndex,
          executionIndex: buyAtAccountingPredecessor ? startIndex : startIndex + 1,
          weights: { SPY: 1 },
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

export const inputManifestFixture = () => {
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

export const fixtureInputManifest = inputManifestFixture()
export const fixtureMarketDataMaterial = {
  schemaVersion: 'bayn.candidate-development-market-data-witness.v1' as const,
  snapshotId: fixtureInputManifest.finalizedSnapshot.snapshotId,
  inputManifestHash: fixtureInputManifest.hash,
  bars: fixtureMarketBars,
}
export const fixtureMarketData = {
  ...fixtureMarketDataMaterial,
  contentHash: canonicalHashV1(fixtureMarketDataMaterial),
}

export const fixtureStrategyProtocol = {
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
export const fixtureStrategyProtocolHash = canonicalHashV1(fixtureStrategyProtocol)
export const fixtureRuntimePreflightInput: CandidateDevelopmentPreflightInput = {
  candidateOrdinal: 16,
  priorTrialCount: 15,
  expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
  officialSessions: fixtureOfficialSessions,
  signalSessionDates: officialMonthEndSignalDates(fixtureOfficialSessions),
  featureLookbackSessions: 126,
}

export const fixtureStressedRunId = '9'.repeat(64)
export const fixtureSourceManifest: CandidateDevelopmentSourceManifest = {
  schemaVersion: 'bayn.candidate-development-source-manifest.v1',
  candidateOrdinal: 16,
  priorTrialCount: 15,
  strategyProtocolHash: fixtureStrategyProtocolHash,
  modulePath: 'services/bayn/src/candidates/fixture/program.ts',
  moduleFormat: 'self-contained-esm-v1',
  marketData: {
    schemaVersion: 'bayn.candidate-development-market-data-source.v1',
    snapshotId: fixtureMarketData.snapshotId,
    finalizedSnapshotContentHash: fixtureInputManifest.finalizedSnapshot.contentHash,
    inputManifestHash: fixtureInputManifest.hash,
    boundedContentHash: fixtureMarketData.contentHash,
  },
}
export const fixtureVerifiedSourceFiles: CandidateDevelopmentVerifiedSourceFiles = {
  schemaVersion: 'bayn.candidate-development-verified-source-files.v1',
  sourceRevision: '2'.repeat(40),
  modulePath: fixtureSourceManifest.modulePath,
  moduleBlobOid: '3'.repeat(40),
  moduleSha256: '4'.repeat(64),
  sourceManifestPath: 'services/bayn/candidates/fixture-source-manifest.json',
  sourceManifestBlobOid: '5'.repeat(40),
  sourceManifestSha256: '6'.repeat(64),
  sourceManifest: fixtureSourceManifest,
}
export const fixtureVerifiedModuleSource: CandidateDevelopmentVerifiedModuleSource = {
  files: fixtureVerifiedSourceFiles,
  moduleUrl: 'data:text/javascript;base64,ZXhwb3J0IGNvbnN0IGNhbmRpZGF0ZURldmVsb3BtZW50UHJvZ3JhbSA9IHt9Cg==',
}
export const { schemaVersion: _fixtureSourceFilesSchemaVersion, ...fixtureVerifiedSourceMaterial } =
  fixtureVerifiedSourceFiles
export const fixtureVerifiedSource: CandidateDevelopmentVerifiedSource = {
  schemaVersion: 'bayn.candidate-development-verified-source.v1',
  ...fixtureVerifiedSourceMaterial,
  baselineRunId: fixtureRunId,
  stressedRunId: fixtureStressedRunId,
}

export const syntheticFrozenSourceRuntime = (
  verifiedSource: CandidateDevelopmentVerifiedSource,
  verifiedFiles: CandidateDevelopmentVerifiedSourceFiles = frozenSourceVerifiedSourceFiles,
) => {
  const sourceManifest = {
    ...verifiedFiles.sourceManifest,
    marketData: fixtureSourceManifest.marketData,
  }
  const runtimeVerifiedSource: CandidateDevelopmentVerifiedSource = {
    ...verifiedSource,
    sourceManifest,
  }
  const preflightInput: CandidateDevelopmentPreflightInput = {
    ...frozenSourceInput,
    officialSessions: fixtureOfficialSessions,
    signalSessionDates: officialMonthEndSignalDates(fixtureOfficialSessions),
  }
  return {
    verifiedFiles: { ...verifiedFiles, sourceManifest },
    strategyProtocol: { ...frozenSourceStrategyProtocol, marketData: fixtureStrategyProtocol.marketData },
    runtimeInput: {
      ...runtimeVerifiedSource,
      runtimeDataSchemaVersion: 'bayn.candidate-development-artifact-runtime-input.v1' as const,
      preflightInput,
      marketData: fixtureMarketData,
    },
  }
}

export const canonicalAccountingFixture = (runId: string, costMultiplierMicros: bigint) => {
  const sessions = successOf(alignBars(fixtureMarketBars, fixtureStrategyProtocol.universe, fixtureInputManifest))
  const sessionIndex = new Map(sessions.map((session, index) => [session.date, index] as const))
  const startIndex = sessionIndex.get(fixtureAccountingStart)
  if (startIndex === undefined) throw new Error('fixture accounting predecessor is missing')
  const targets = fixtureSignalDecisions.map((decision): SimulationTarget => {
    const signalIndex = sessionIndex.get(decision.signalDate)
    const executionIndex = sessionIndex.get(decision.executionDate)
    if (signalIndex === undefined || executionIndex === undefined) {
      throw new Error('fixture accounting decision schedule is incomplete')
    }
    const { decisionId: _, executionDate: __, ...plan } = decision
    return { signalIndex, executionIndex, weights: decision.targetWeights, decision: plan }
  })
  const replay = successOf(
    simulate(sessions, targets, startIndex, fixtureStrategyProtocol, costMultiplierMicros, runId, true),
  )
  if (replay.simulation === null) throw new Error('fixture accounting simulation is missing')
  const fullSimulation = replay.simulation
  const selectedPerformance = replay.dailyPerformance.slice(1)
  const selectedDailyMarks = fullSimulation.dailyMarks.slice(1)
  if (
    selectedPerformance.length !== fixtureSessions.length ||
    selectedDailyMarks.length !== fixtureSessions.length ||
    selectedDailyMarks.some((mark, index) => mark.sessionDate !== fixtureSessions[index])
  ) {
    throw new Error('fixture accounting selection is incomplete')
  }
  const simulation = { ...fullSimulation, dailyMarks: selectedDailyMarks }
  const metrics = exactMetrics(selectedPerformance)
  const proof = reconcileMarkedEquity({
    runId,
    initialCapitalMicros: fixtureInitialCapitalMicros,
    evaluatorTotalFeesMicros: metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: metrics.endingEquityMicros,
    events: replay.events,
    simulation: fullSimulation,
  })
  if (Result.isFailure(proof)) {
    throw new Error(`canonical marked-equity fixture failed: ${JSON.stringify(proof.failure)}`)
  }
  return {
    runId,
    evaluatorTotalFeesMicros: metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: metrics.endingEquityMicros,
    events: replay.events,
    signalDecisions: replay.signalDecisions,
    simulation,
    fullSimulation,
    performance: selectedPerformance,
    metrics,
    equitySeries: proof.success.equitySeries,
    markedEquityReconciliation: proof.success.reconciliation,
  }
}

export const stressedAccountingFixture = () => canonicalAccountingFixture(fixtureStressedRunId, MICROS * 2n)

export const reportFixture = (annualizedReturnDifferenceLowerBound: number): CandidateDevelopmentReport => {
  const stressed = stressedAccountingFixture()
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
        signalDecisions: stressed.signalDecisions,
        simulation: stressed.simulation,
      },
    },
  } as unknown as CandidateDevelopmentReport
}

export const baselineFixture = (): EvaluationResult => {
  const baselineAccounting = canonicalAccountingFixture(fixtureRunId, MICROS)
  const stressedAccounting = stressedAccountingFixture()
  const strategy = baselineAccounting.metrics
  const rebuiltBenchmarks = fixtureBenchmarkSeries()
  const buyAndHoldPoints = rebuiltBenchmarks.buyAndHold
  const directVolTimingPoints = rebuiltBenchmarks.directVolTiming
  const doubleCostPoints = stressedAccounting.performance
  const buyAndHold = exactMetrics(buyAndHoldPoints)
  const directVolTiming = exactMetrics(directVolTimingPoints)
  const doubleCostStrategy = stressedAccounting.metrics
  const verdict = buildVerdict(strategy, buyAndHold, directVolTiming, doubleCostStrategy, fixtureStrategyProtocol)
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
    events: baselineAccounting.events,
    simulation: baselineAccounting.simulation,
    benchmarkSeries: {
      buyAndHold: buyAndHoldPoints,
      directVolTiming: directVolTimingPoints,
      doubleCostStrategy: doubleCostPoints,
    },
    equitySeries: baselineAccounting.equitySeries,
    markedEquityReconciliation: baselineAccounting.markedEquityReconciliation,
    signalDecisions: baselineAccounting.signalDecisions,
  } as unknown as EvaluationResult
}

export const commandEvaluationFixture = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
  accountingBaseline: EvaluationResult = baseline,
): CandidateDevelopmentCommandEvaluation => {
  const stressed = stressedAccountingFixture()
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

export const buildFixtureReport = (report: CandidateDevelopmentReport, baseline: EvaluationResult) =>
  buildCandidateDevelopmentCommandReport(report, commandEvaluationFixture(report, baseline), fixtureStrategyProtocol)
