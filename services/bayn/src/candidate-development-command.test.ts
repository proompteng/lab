import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Deferred, Effect, Fiber, Result } from 'effect'

import { frozenCandidateDevelopmentSessions } from './candidate-development-calendar'
import type { CandidateDevelopmentNextPreregistration } from './candidate-development-calendar'
import {
  bindCandidateDevelopmentVerifiedSource,
  buildCandidateDevelopmentCommandReport as buildCandidateDevelopmentCommandReportPure,
  candidateDevelopmentExecutableProgramSchemaVersion,
  evaluateCandidateDevelopmentArtifact,
  executeCandidateDevelopmentProgram,
  loadCandidateDevelopmentExecutableProgram,
  makeCandidateDevelopmentCommandReportWriter,
  openCandidateDevelopmentGitBatchObjectReader,
  renderCandidateDevelopmentCommandReport,
  validateCandidateDevelopmentAccountingReplay,
  validateCandidateDevelopmentCommandEvaluation,
  validateCandidateDevelopmentExecutableProgram,
  validateCandidateDevelopmentPreregisteredMarketData,
  validateCandidateDevelopmentPreregistrationDocument,
  verifyCandidateDevelopmentPreregistrationLineage,
  verifyCandidateDevelopmentPreregistrationModuleNovelty,
  verifyCandidateDevelopmentRepositoryIntegrity,
  verifyCandidateDevelopmentSourceFiles,
  writeCandidateDevelopmentCommandReport,
  type CandidateDevelopmentCommandEvaluation,
  type CandidateDevelopmentExecutableProgram,
  type CandidateDevelopmentSourceGit,
  type CandidateDevelopmentSourceManifest,
  type CandidateDevelopmentSourceVerifier,
  type CandidateDevelopmentVerifiedSource,
  type CandidateDevelopmentVerifiedSourceFiles,
  type CandidateDevelopmentVerifiedModuleSource,
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

const execFilePromise = (file: string, args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolveExecution, rejectExecution) => {
    execFile(file, [...args], { cwd }, (error) => {
      if (error === null) resolveExecution()
      else rejectExecution(error)
    })
  })

const execFileTextPromise = (file: string, args: readonly string[], cwd: string): Promise<string> =>
  new Promise((resolveExecution, rejectExecution) => {
    execFile(file, [...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolveExecution(stdout.trim())
      else rejectExecution(error)
    })
  })

const execFileBytesPromise = (file: string, args: readonly string[], cwd: string): Promise<Buffer> =>
  new Promise((resolveExecution, rejectExecution) => {
    execFile(file, [...args], { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolveExecution(stdout)
      else rejectExecution(error)
    })
  })

const fixtureInitialCapitalMicros = '1000000'
const fixtureRunId = '1'.repeat(64)
const fixtureSessions = Array.from(
  { length: 504 },
  (_, index) => new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10) as IsoDate,
)

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

const zeroPositionFixture = (sessionDate: IsoDate, symbol = 'SPY') => ({
  symbol,
  quantityMicros: '0',
  costBasisMicros: '0',
  priceMicros: successOf(
    referencePriceMicros(symbol === 'SPY' ? fixtureSpyClose(sessionDate) : 1, fixtureExecutionModel),
  ).toString(),
  marketValueMicros: '0',
})

const buildCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol = fixtureStrategyProtocol,
  officialSessions = fixtureOfficialSessions,
  verifiedSource = fixtureVerifiedSource,
) => buildCandidateDevelopmentCommandReportPure(report, evaluation, strategyProtocol, officialSessions, verifiedSource)
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
        positions: fixtureStrategyProtocol.universe.map((symbol) =>
          zeroPositionFixture(fixtureAccountingStart, symbol),
        ),
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

const fixtureBenchmarkSeries = (
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
const fixtureSourceManifest: CandidateDevelopmentSourceManifest = {
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
const fixtureVerifiedSourceFiles: CandidateDevelopmentVerifiedSourceFiles = {
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
const fixtureVerifiedModuleSource: CandidateDevelopmentVerifiedModuleSource = {
  files: fixtureVerifiedSourceFiles,
  moduleUrl: 'data:text/javascript;base64,ZXhwb3J0IGNvbnN0IGNhbmRpZGF0ZURldmVsb3BtZW50UHJvZ3JhbSA9IHt9Cg==',
}
const { schemaVersion: _fixtureSourceFilesSchemaVersion, ...fixtureVerifiedSourceMaterial } = fixtureVerifiedSourceFiles
const fixtureVerifiedSource: CandidateDevelopmentVerifiedSource = {
  schemaVersion: 'bayn.candidate-development-verified-source.v1',
  ...fixtureVerifiedSourceMaterial,
  baselineRunId: fixtureRunId,
  stressedRunId: fixtureStressedRunId,
}

const canonicalAccountingFixture = (runId: string, costMultiplierMicros: bigint) => {
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

const stressedAccountingFixture = () => canonicalAccountingFixture(fixtureStressedRunId, MICROS * 2n)

const reportFixture = (annualizedReturnDifferenceLowerBound: number): CandidateDevelopmentReport => {
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

const baselineFixture = (): EvaluationResult => {
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

const commandEvaluationFixture = (
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

    const failure = await Effect.runPromise(
      Effect.flip(executeCandidateDevelopmentProgram(program, fixtureVerifiedSource)),
    )

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

    expect(
      await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(program, fixtureVerifiedSource))),
    ).toBe('evaluation-stop')
    expect(preregistrations).toBe(1)
    expect(loads).toBe(1)
    expect(evaluations).toBe(1)
  })

  test('derives the disposition and hashes the complete governed report', () => {
    const passing = successOf(buildFixtureReport(reportFixture(0.01), baselineFixture()))
    const rejected = successOf(buildFixtureReport(reportFixture(-0.01), baselineFixture()))
    const { contentHash, ...material } = passing

    expect(passing.decision.status).toBe('PASS')
    expect(rejected.decision.status).toBe('HOLD_REJECT')
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

  test('binds the reported doubled-cost daily series to stressed replay marks', () => {
    const baseline = baselineFixture()
    const points = baseline.benchmarkSeries.doubleCostStrategy
    const index = points.findIndex(
      (point, pointIndex) =>
        points[pointIndex + 1] !== undefined && point.cashYieldMicros !== points[pointIndex + 1]?.cashYieldMicros,
    )
    if (index < 0) throw new Error('fixture requires adjacent differing cash-yield amounts')
    const first = points[index]
    const second = points[index + 1]
    const priorCumulative = BigInt(first.cumulativeCashYieldMicros) - BigInt(first.cashYieldMicros)
    const swappedFirst = {
      ...first,
      cashYieldMicros: second.cashYieldMicros,
      cumulativeCashYieldMicros: (priorCumulative + BigInt(second.cashYieldMicros)).toString(),
    }
    const swappedSecond = {
      ...second,
      cashYieldMicros: first.cashYieldMicros,
    }
    const tampered = {
      ...baseline,
      benchmarkSeries: {
        ...baseline.benchmarkSeries,
        doubleCostStrategy: points.map((point, pointIndex) =>
          pointIndex === index ? swappedFirst : pointIndex === index + 1 ? swappedSecond : point,
        ),
      },
    }

    expect(buildFixtureReport(reportFixture(0.01), tampered)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'double-cost-series.replay',
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
    const baseline = baselineFixture()
    const index = baseline.verdict.gates.findIndex((gate) => gate.name === 'positive_net_return')
    if (index < 0) throw new Error('positive return gate is missing')
    const expected = baseline.verdict.gates[index]
    const observed = { ...expected, passed: false, actual: 0 }
    const forged = {
      ...baseline,
      verdict: {
        ...baseline.verdict,
        gates: baseline.verdict.gates.map((gate, gateIndex) => (gateIndex === index ? observed : gate)),
      },
    }

    expect(buildFixtureReport(reportFixture(0.01), forged)).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CandidateDevelopmentCommandEconomicGateInvalid',
        index,
        expected,
        observed,
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
        reason: 'binding-mismatch',
        field: 'baseline.replay.dailyMarks',
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
        reason: 'binding-mismatch',
        field: 'baseline.replay.monetaryEvents',
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
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.replay.dailyMarks',
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
        reason: 'binding-mismatch',
        field: 'baseline.replay.dailyMarks',
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
        stressedSimulation: fullAccountingSimulationFixture(stressedSimulation),
      },
    }

    expect(
      buildCandidateDevelopmentCommandReport(tamperedReport, tamperedEvaluation, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'stressed.replay.monetaryEvents',
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
    const suffixMark = {
      ...lastMark,
      sessionDate: suffixDate,
      netReturn: 0,
      turnoverMicros: '0',
      feeMicros: '0',
      spreadCostMicros: '0',
      slippageCostMicros: '0',
      cashYieldMicros: '0',
    }
    const fullSimulation = {
      ...accountingSimulation,
      dailyMarks: [...accountingSimulation.dailyMarks, suffixMark],
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
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
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
        reason: 'selected-trace-mismatch',
        field: 'baselineSimulation.events.signalDate',
        expected: `<=${lastMark.sessionDate}`,
        observed: postWindowDate,
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

  test('requires cash yield before same-session fill and fee evidence', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const insertFeeBeforeYield = (events: EvaluationResult['events'], runId: string): EvaluationResult['events'] => {
      const yieldIndex = events.findIndex((event) => event.kind === 'cash-yield')
      const cashYield = events[yieldIndex]
      if (yieldIndex < 0 || cashYield?.kind !== 'cash-yield') {
        throw new Error('cash-yield fixture must be present')
      }
      const payload = {
        kind: 'fee' as const,
        sessionDate: cashYield.sessionDate,
        commissionMicros: '0',
        secMicros: '0',
        tafMicros: '0',
        catMicros: '0',
        totalMicros: '0',
      }
      const fee = { ...payload, id: canonicalHashV1({ runId, ...payload }) }
      return [...events.slice(0, yieldIndex), fee, ...events.slice(yieldIndex)]
    }

    const baselineWithLateYield = {
      ...baseline,
      events: insertFeeBeforeYield(baseline.events, baseline.runId),
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        commandEvaluationFixture(report, baselineWithLateYield),
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.cashYield.order',
        expected: 'before every same-session fill and fee',
        observed: { kind: 'fee' },
      },
    })

    const evaluation = commandEvaluationFixture(report, baseline)
    const accounting = {
      ...evaluation.accounting,
      stressedEvents: insertFeeBeforeYield(evaluation.accounting.stressedEvents, evaluation.accounting.stressedRunId),
    }
    expect(
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'stressed.cashYield.order',
        expected: 'before every same-session fill and fee',
        observed: { kind: 'fee' },
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
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.calendar.sessionDate',
        index: 1,
        expected: fixtureAccountingStart,
        observed: fixtureSessions[0],
      },
    })
  })

  test('rejects multiple accounting predecessors before the selected window', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const evaluation = commandEvaluationFixture(report, baseline)
    const earlierSession = fixtureHistorySessions.at(-2)
    if (earlierSession === undefined) throw new Error('fixture history requires two predecessor sessions')
    const addEarlierPredecessor = (simulation: EvaluationResult['simulation']) => {
      const predecessor = simulation.dailyMarks[0]
      return {
        ...simulation,
        dailyMarks: [
          {
            ...predecessor,
            sessionDate: earlierSession,
            positions: fixtureStrategyProtocol.universe.map((symbol) => zeroPositionFixture(earlierSession, symbol)),
          },
          ...simulation.dailyMarks,
        ],
      }
    }

    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        {
          ...evaluation,
          accounting: {
            ...evaluation.accounting,
            baselineSimulation: addEarlierPredecessor(evaluation.accounting.baselineSimulation),
          },
        },
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'selected-trace-mismatch',
        field: 'baselineSimulation.predecessorCount',
        expected: 1,
        observed: 2,
      },
    })

    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        {
          ...evaluation,
          accounting: {
            ...evaluation.accounting,
            stressedSimulation: addEarlierPredecessor(evaluation.accounting.stressedSimulation),
          },
        },
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'selected-trace-mismatch',
        field: 'stressedSimulation.predecessorCount',
        expected: 1,
        observed: 2,
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
        field: 'baseline.replay.orders',
      },
    })
  })

  test('requires canonical fill fee and cash evidence in baseline and stressed replay', () => {
    const sessions = successOf(alignBars(fixtureMarketBars, fixtureStrategyProtocol.universe, fixtureInputManifest))
    const sessionIndexByDate = new Map(sessions.map((session, index) => [session.date, index] as const))
    const startIndex = sessionIndexByDate.get(fixtureSessions[0])
    if (startIndex === undefined) throw new Error('fixture replay start is missing')
    const feeProtocol = {
      ...fixtureStrategyProtocol,
      executionModel: {
        ...fixtureExecutionModel,
        fees: { ...fixtureExecutionModel.fees, commissionBps: 100 },
        cash: { ...fixtureExecutionModel.cash, annualYieldBps: 0 },
      },
    }
    const marketData = {
      witness: fixtureMarketData,
      sessions,
      sessionIndexByDate,
    }
    const decisionFor = (
      runId: string,
      base: typeof firstDecisionFixture.signal,
      weight: number,
    ): EvaluationResult['signalDecisions'][number] => {
      const targetWeights = { SPY: weight }
      const payload = {
        signalDate: base.signalDate,
        executionDate: base.executionDate,
        targetWeights,
      }
      return {
        ...base,
        decisionId: canonicalHashV1({ runId, kind: 'decision', ...payload }),
        exposureScale: weight,
        targetWeights,
        signals: base.signals.map((signal) => ({
          ...signal,
          eligible: weight > 0,
          uncappedWeight: weight,
          cappedWeight: weight,
          targetWeight: weight,
        })),
      }
    }
    const targetFor = (decision: EvaluationResult['signalDecisions'][number]): SimulationTarget => {
      const signalIndex = sessionIndexByDate.get(decision.signalDate)
      const executionIndex = sessionIndexByDate.get(decision.executionDate)
      if (signalIndex === undefined || executionIndex === undefined) {
        throw new Error('fixture replay decision schedule is missing')
      }
      const { decisionId: _, executionDate: __, ...plan } = decision
      return { signalIndex, executionIndex, weights: decision.targetWeights, decision: plan }
    }

    for (const [field, runId, costMultiplierMicros] of [
      ['baseline', fixtureRunId, MICROS],
      ['stressed', fixtureStressedRunId, MICROS * 2n],
    ] as const) {
      const signalDecisions = [
        decisionFor(runId, firstDecisionFixture.signal, 1),
        decisionFor(runId, terminalDecisionFixture.signal, 0),
      ]
      const replay = successOf(
        simulate(sessions, signalDecisions.map(targetFor), startIndex, feeProtocol, costMultiplierMicros, runId, true),
      )
      if (replay.simulation === null) throw new Error('fixture replay simulation is missing')
      expect(replay.events.some((event) => event.kind === 'fill')).toBe(true)
      expect(replay.events.some((event) => event.kind === 'fee' && event.totalMicros !== '0')).toBe(true)
      expect(
        replay.simulation.cashChanges.some(
          (cashChange) => cashChange.sourceKind === 'fee' && cashChange.amountMicros.startsWith('-'),
        ),
      ).toBe(true)
      expect(
        Result.isSuccess(
          validateCandidateDevelopmentAccountingReplay(
            field,
            runId,
            signalDecisions,
            replay.events,
            replay.simulation,
            marketData,
            feeProtocol,
          ),
        ),
      ).toBe(true)

      const withoutFeeEvents = replay.events.filter((event) => event.kind !== 'fee')
      expect(
        validateCandidateDevelopmentAccountingReplay(
          field,
          runId,
          signalDecisions,
          withoutFeeEvents,
          replay.simulation,
          marketData,
          feeProtocol,
        ),
      ).toMatchObject({ failure: { field: `${field}.replay.monetaryEvents` } })

      const withoutFeeCash = {
        ...replay.simulation,
        cashChanges: replay.simulation.cashChanges.filter((cashChange) => cashChange.sourceKind !== 'fee'),
      }
      expect(
        validateCandidateDevelopmentAccountingReplay(
          field,
          runId,
          signalDecisions,
          replay.events,
          withoutFeeCash,
          marketData,
          feeProtocol,
        ),
      ).toMatchObject({ failure: { field: `${field}.replay.cashChanges` } })
    }
  })

  test('requires canonical cash-yield events and cash changes in baseline and stressed replay', () => {
    const sessions = successOf(alignBars(fixtureMarketBars, fixtureStrategyProtocol.universe, fixtureInputManifest))
    const marketData = {
      witness: fixtureMarketData,
      sessions,
      sessionIndexByDate: new Map(sessions.map((session, index) => [session.date, index] as const)),
    }
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const evaluation = commandEvaluationFixture(report, baseline)

    for (const [field, runId, signalDecisions, events, simulation] of [
      [
        'baseline',
        evaluation.accounting.runId,
        baseline.signalDecisions,
        evaluation.accounting.events,
        evaluation.accounting.baselineSimulation,
      ],
      [
        'stressed',
        evaluation.accounting.stressedRunId,
        report.doubledCost.stressed.signalDecisions,
        evaluation.accounting.stressedEvents,
        evaluation.accounting.stressedSimulation,
      ],
    ] as const) {
      expect(events.some((event) => event.kind === 'cash-yield')).toBe(true)
      expect(simulation.cashChanges.some((cashChange) => cashChange.sourceKind === 'cash-yield')).toBe(true)
      expect(
        Result.isSuccess(
          validateCandidateDevelopmentAccountingReplay(
            field,
            runId,
            signalDecisions,
            events,
            simulation,
            marketData,
            fixtureStrategyProtocol,
          ),
        ),
      ).toBe(true)

      expect(
        validateCandidateDevelopmentAccountingReplay(
          field,
          runId,
          signalDecisions,
          events.filter((event) => event.kind !== 'cash-yield'),
          simulation,
          marketData,
          fixtureStrategyProtocol,
        ),
      ).toMatchObject({ failure: { field: `${field}.replay.monetaryEvents` } })

      expect(
        validateCandidateDevelopmentAccountingReplay(
          field,
          runId,
          signalDecisions,
          events,
          {
            ...simulation,
            cashChanges: simulation.cashChanges.filter((cashChange) => cashChange.sourceKind !== 'cash-yield'),
          },
          marketData,
          fixtureStrategyProtocol,
        ),
      ).toMatchObject({ failure: { field: `${field}.replay.cashChanges` } })
    }
  })

  test('rejects every accounting decision and order before the first selected rebalance', () => {
    const report = reportFixture(0.01)
    const baseline = baselineFixture()
    const preRebalance = makeSignalDecisionFixture(fixtureAccountingStart, fixtureSessions[0])
    const baselineWithPreRebalanceEvent = {
      ...baseline,
      events: [preRebalance.event, ...baseline.events],
    }
    const evaluation = commandEvaluationFixture(report, baselineWithPreRebalanceEvent)
    const extraPlanAccounting = {
      ...evaluation.accounting,
      signalDecisions: [preRebalance.signal, ...evaluation.accounting.signalDecisions],
    }
    expect(
      buildCandidateDevelopmentCommandReport(
        report,
        { ...evaluation, accounting: extraPlanAccounting },
        fixtureStrategyProtocol,
      ),
    ).toMatchObject({ failure: { field: 'baseline.signalDecisions' } })

    const orderPayload = {
      decisionId: preRebalance.signal.decisionId,
      sessionDate: fixtureSessions[0],
      symbol: 'SPY',
      side: 'buy' as const,
      requestedQuantityMicros: '1',
      filledQuantityMicros: '0',
      status: 'rejected' as const,
      rejectionReason: 'zero-after-rounding' as const,
      unfilledRemainder: 'none' as const,
    }
    const preRebalanceOrder = {
      ...orderPayload,
      id: canonicalHashV1({ runId: baseline.runId, kind: 'order', ...orderPayload }),
    }
    const baselineWithOrder = {
      ...baseline,
      simulation: { ...baseline.simulation, orders: [preRebalanceOrder] },
    }
    expect(buildFixtureReport(report, baselineWithOrder)).toMatchObject({
      failure: { field: 'baseline.replay.orders' },
    })

    const preRebalancePriceMicros = successOf(
      referencePriceMicros(fixtureSpyClose(fixtureAccountingStart), fixtureExecutionModel),
    ).toString()
    const fillPayload = {
      orderId: preRebalanceOrder.id,
      decisionId: preRebalance.signal.decisionId,
      sessionDate: fixtureAccountingStart,
      symbol: 'SPY',
      side: 'buy' as const,
      quantityMicros: '1',
      referencePriceMicros: preRebalancePriceMicros,
      priceMicros: preRebalancePriceMicros,
      notionalMicros: '1',
      spreadCostMicros: '0',
      slippageCostMicros: '0',
      costBasisMicros: '1',
    }
    const preRebalanceFill = {
      kind: 'fill' as const,
      ...fillPayload,
      id: canonicalHashV1({ runId: baseline.runId, kind: 'fill', ...fillPayload }),
    }
    const baselineWithFill = {
      ...baseline,
      events: [preRebalanceFill, ...baseline.events],
    }
    expect(buildFixtureReport(report, baselineWithFill)).toMatchObject({
      failure: {
        reason: 'selected-trace-mismatch',
        field: 'baselineSimulation.events.sessionDate',
        expected: `>=${fixtureSessions[0]}`,
        observed: fixtureAccountingStart,
      },
    })

    const stressedSimulation = {
      ...report.doubledCost.stressed.simulation,
      orders: [
        {
          ...preRebalanceOrder,
          id: canonicalHashV1({
            runId: fixtureStressedRunId,
            kind: 'order',
            ...orderPayload,
          }),
        },
      ],
    }
    const stressedReport = {
      ...report,
      doubledCost: {
        ...report.doubledCost,
        stressed: { ...report.doubledCost.stressed, simulation: stressedSimulation },
      },
    }
    const stressedEvaluationFixture = commandEvaluationFixture(stressedReport, baseline)
    const stressedEvaluation = {
      ...stressedEvaluationFixture,
      accounting: {
        ...stressedEvaluationFixture.accounting,
        stressedSimulation: {
          ...stressedEvaluationFixture.accounting.stressedSimulation,
          orders: stressedSimulation.orders,
        },
      },
    }
    expect(
      buildCandidateDevelopmentCommandReport(stressedReport, stressedEvaluation, fixtureStrategyProtocol),
    ).toMatchObject({ failure: { field: 'stressed.replay.orders' } })
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

  test('cancels a blocked report output write on interruption', async () => {
    const report = successOf(buildFixtureReport(reportFixture(0.01), baselineFixture()))
    let resolveStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let completion: ((error?: Error | null) => void) | undefined
    let destroyed = false
    const writer = makeCandidateDevelopmentCommandReportWriter({
      write: (_renderedReport, callback) => {
        completion = callback
        resolveStarted?.()
        return false
      },
      destroy: (error) => {
        destroyed = true
        completion?.(error)
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* writeCandidateDevelopmentCommandReport(report, writer).pipe(Effect.forkChild)
        yield* Effect.promise(() => started)
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout('1 second'))
      }),
    )
    expect(destroyed).toBe(true)
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

  test('derives baseline and stressed run identities from verified Git provenance', () => {
    const input = {
      candidateOrdinal: 16,
      priorTrialCount: 15,
      expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
      officialSessions: fixtureOfficialSessions,
      signalSessionDates: fixtureSignalDecisions.map(({ signalDate }) => signalDate),
      featureLookbackSessions: 126,
    }
    const verified = successOf(bindCandidateDevelopmentVerifiedSource(fixtureVerifiedSourceFiles, input))
    const moduleDrift = successOf(
      bindCandidateDevelopmentVerifiedSource({ ...fixtureVerifiedSourceFiles, moduleSha256: 'f'.repeat(64) }, input),
    )
    const revisionDrift = successOf(
      bindCandidateDevelopmentVerifiedSource({ ...fixtureVerifiedSourceFiles, sourceRevision: 'e'.repeat(40) }, input),
    )

    expect(verified.baselineRunId).not.toBe(verified.stressedRunId)
    expect(moduleDrift.baselineRunId).not.toBe(verified.baselineRunId)
    expect(revisionDrift.baselineRunId).not.toBe(verified.baselineRunId)
    expect(
      bindCandidateDevelopmentVerifiedSource(
        {
          ...fixtureVerifiedSourceFiles,
          sourceManifest: { ...fixtureSourceManifest, candidateOrdinal: 17 },
        },
        input,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'candidateOrdinal', expected: 16, observed: 17 },
      },
    })
  })

  test('rejects colluding trial counts before preregistration', async () => {
    const input = {
      candidateOrdinal: 1,
      priorTrialCount: 0,
      expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
      officialSessions: fixtureOfficialSessions,
      signalSessionDates: fixtureSignalDecisions.map(({ signalDate }) => signalDate),
      featureLookbackSessions: 126,
    }
    const sourceManifest = {
      ...fixtureSourceManifest,
      candidateOrdinal: input.candidateOrdinal,
      priorTrialCount: input.priorTrialCount,
    }
    const verifiedFiles = { ...fixtureVerifiedSourceFiles, sourceManifest }
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(fixtureStrategyProtocol)},
        buildEvaluation: () => { throw new Error('must not evaluate') },
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, verifiedFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: {
          field: 'trialHistory.candidatePreregistration',
          expected: { candidateOrdinal: 16, priorTrialCount: 15 },
          observed: { candidateOrdinal: 1, priorTrialCount: 0 },
        },
      },
    })
  })

  test('binds every preregistered market-data commitment to the source manifest', () => {
    expect(
      validateCandidateDevelopmentPreregisteredMarketData(
        fixtureSourceManifest.marketData,
        fixtureSourceManifest.marketData,
      ),
    ).toEqual(Result.succeed(undefined))

    for (const [field, observed] of [
      ['snapshotId', 'a'.repeat(64)],
      ['finalizedSnapshotContentHash', 'b'.repeat(64)],
      ['inputManifestHash', 'c'.repeat(64)],
      ['boundedContentHash', 'd'.repeat(64)],
    ] as const) {
      expect(
        validateCandidateDevelopmentPreregisteredMarketData(fixtureSourceManifest.marketData, {
          ...fixtureSourceManifest.marketData,
          [field]: observed,
        }),
      ).toMatchObject({
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: `trialHistory.nextCandidatePreregistration.marketData.${field}`,
            expected: fixtureSourceManifest.marketData[field],
            observed,
          },
        },
      })
    }
  })

  test('binds authorization to the exact preregistration document bytes', () => {
    const preregistration: CandidateDevelopmentNextPreregistration = {
      schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
      candidateOrdinal: 16,
      priorTrialCount: 15,
      strategyProtocolHash: fixtureStrategyProtocolHash,
      modulePath: fixtureSourceManifest.modulePath,
      moduleSha256: fixtureVerifiedSourceFiles.moduleSha256,
      marketData: fixtureSourceManifest.marketData,
      preregistration: {
        sourceRevision: '1'.repeat(40),
        path: 'candidate/preregistration.json',
        blobOid: '2'.repeat(40),
      },
    }
    const document = {
      schemaVersion: preregistration.schemaVersion,
      candidateOrdinal: preregistration.candidateOrdinal,
      priorTrialCount: preregistration.priorTrialCount,
      strategyProtocolHash: preregistration.strategyProtocolHash,
      modulePath: preregistration.modulePath,
      moduleSha256: preregistration.moduleSha256,
      marketData: preregistration.marketData,
    }

    expect(validateCandidateDevelopmentPreregistrationDocument(preregistration, document)).toEqual(
      Result.succeed(undefined),
    )
    expect(
      validateCandidateDevelopmentPreregistrationDocument(preregistration, {
        ...document,
        marketData: { ...document.marketData, boundedContentHash: 'f'.repeat(64) },
      }),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-blob',
        cause: {
          field: 'marketData.boundedContentHash',
          expected: preregistration.marketData.boundedContentHash,
          observed: 'f'.repeat(64),
        },
      },
    })

    expect(
      validateCandidateDevelopmentPreregistrationDocument(preregistration, {
        ...document,
        moduleSha256: 'e'.repeat(64),
      }),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-blob',
        cause: {
          field: 'moduleSha256',
          expected: preregistration.moduleSha256,
          observed: 'e'.repeat(64),
        },
      },
    })
  })

  test('rejects consumed Candidate 16 before development evaluation', async () => {
    const officialSessions = frozenCandidateDevelopmentSessions()
    const input = {
      candidateOrdinal: 16,
      priorTrialCount: 15,
      expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
      officialSessions,
      signalSessionDates: officialMonthEndSignalDates(officialSessions),
      featureLookbackSessions: 126,
    }
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(fixtureStrategyProtocol)},
        buildEvaluation: () => { throw new Error('consumed Candidate 16 must not evaluate') },
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    const loaded = await Effect.runPromise(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))
    const program = successOf(
      validateCandidateDevelopmentExecutableProgram(
        (loaded as { readonly candidateDevelopmentProgram?: unknown }).candidateDevelopmentProgram,
      ),
    )
    const verifiedSource = successOf(bindCandidateDevelopmentVerifiedSource(fixtureVerifiedSourceFiles, input))

    expect(
      await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(program, verifiedSource))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-program-binding',
      cause: {
        field: 'trialHistory.nextCandidatePreregistration',
        observed: null,
        latestTerminalEvidence: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          terminalStatus: 'HOLD_REJECT',
          sourceRevision: '60a48a2e52fbafdd67a404a33a3cb22e82a98493',
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

    expect(
      await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(validated, fixtureVerifiedSource))),
    ).toMatchObject({
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

    const decoded = await Effect.runPromise(
      validated.effects.evaluateDevelopment(undefined, undefined as never, fixtureVerifiedSource),
    )

    expect(decoded.accounting.schemaVersion).toBe('bayn.candidate-development-accounting-evidence.v2')
    expect(decoded.accounting.runId).toBe(evaluation.baseline.runId)
    expect(decoded.accounting.baselineSimulation.dailyMarks).toHaveLength(505)
  })

  test('verifies the source manifest and module as exact Git blobs', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    const dependencyPath = join(candidateDirectory, 'dependency.mjs')
    const sourceManifestPath = join(candidateDirectory, 'source-manifest.json')
    const moduleBytes = 'export const candidateDevelopmentProgram = {}\n'
    const dependencyBytes = 'export const dependency = 1\n'
    const sourceManifest: CandidateDevelopmentSourceManifest = {
      ...fixtureSourceManifest,
      modulePath: 'candidate/program.mjs',
    }
    const sourceManifestBytes = `${JSON.stringify(sourceManifest, null, 2)}\n`
    try {
      await mkdir(candidateDirectory, { recursive: true })
      await writeFile(modulePath, moduleBytes)
      await writeFile(dependencyPath, dependencyBytes)
      await writeFile(sourceManifestPath, sourceManifestBytes)
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
      await execFilePromise(
        'git',
        ['add', 'candidate/program.mjs', 'candidate/dependency.mjs', 'candidate/source-manifest.json'],
        repository,
      )
      await execFilePromise('git', ['commit', '-qm', 'test: bind candidate source'], repository)

      const verified = await Effect.runPromise(verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath))
      expect(verified.files.modulePath).toBe('candidate/program.mjs')
      expect(verified.files.sourceManifestPath).toBe('candidate/source-manifest.json')
      expect(verified.files.sourceRevision).toMatch(/^[0-9a-f]{40}$/)
      expect(verified.files.moduleBlobOid).toMatch(/^[0-9a-f]{40}$/)
      expect(Buffer.from(verified.moduleUrl.split(',')[1] ?? '', 'base64').toString('utf8')).toBe(moduleBytes)

      const replacementPath = join(candidateDirectory, 'replacement.mjs')
      const replacementBytes = "throw new Error('replacement blob executed')\n"
      await writeFile(replacementPath, replacementBytes)
      const replacementOid = await execFileTextPromise(
        'git',
        ['hash-object', '-w', 'candidate/replacement.mjs'],
        repository,
      )
      await execFilePromise('git', ['replace', verified.files.moduleBlobOid, replacementOid], repository)
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'replaceRefs' },
      })
      await execFilePromise('git', ['replace', '-d', verified.files.moduleBlobOid], repository)

      await writeFile(modulePath, `${moduleBytes}// tampered\n`)
      const moduleDiskDrift = await Effect.runPromise(
        verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath),
      )
      expect(moduleDiskDrift.files.moduleSha256).toBe(verified.files.moduleSha256)
      expect(moduleDiskDrift.moduleUrl).toBe(verified.moduleUrl)

      await writeFile(modulePath, moduleBytes)
      await writeFile(sourceManifestPath, `${sourceManifestBytes} `)
      const manifestDiskDrift = await Effect.runPromise(
        verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath),
      )
      expect(manifestDiskDrift.files.sourceManifestSha256).toBe(verified.files.sourceManifestSha256)

      await writeFile(sourceManifestPath, sourceManifestBytes)
      await writeFile(modulePath, 'import "node:fs"\nexport const candidateDevelopmentProgram = {}\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: add imported dependency'], repository)
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-format',
      })
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('ignores inherited Git repository-selection environment', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-environment-'))
    const alternateRepository = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-alternate-'))
    const candidateDirectory = join(repository, 'candidate')
    const alternateCandidateDirectory = join(alternateRepository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    const sourceManifestPath = join(candidateDirectory, 'source-manifest.json')
    const moduleBytes = 'export const candidateDevelopmentProgram = { source: "trusted" }\n'
    const alternateModuleBytes = 'export const candidateDevelopmentProgram = { source: "alternate" }\n'
    const sourceManifest = { ...fixtureSourceManifest, modulePath: 'candidate/program.mjs' }
    const sourceManifestBytes = `${JSON.stringify(sourceManifest, null, 2)}\n`
    const previousGitDir = process.env.GIT_DIR
    const previousGitWorkTree = process.env.GIT_WORK_TREE
    try {
      for (const [root, directory, bytes] of [
        [repository, candidateDirectory, moduleBytes],
        [alternateRepository, alternateCandidateDirectory, alternateModuleBytes],
      ] as const) {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'program.mjs'), bytes)
        await writeFile(join(directory, 'source-manifest.json'), sourceManifestBytes)
        await execFilePromise('git', ['init', '-q'], root)
        await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], root)
        await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], root)
        await execFilePromise('git', ['add', 'candidate/program.mjs', 'candidate/source-manifest.json'], root)
        await execFilePromise('git', ['commit', '-qm', 'test: bind source environment'], root)
      }
      const expectedRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      process.env.GIT_DIR = join(alternateRepository, '.git')
      process.env.GIT_WORK_TREE = repository
      const verified = await Effect.runPromise(verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath))

      expect(verified.files.sourceRevision).toBe(expectedRevision)
      expect(Buffer.from(verified.moduleUrl.split(',')[1] ?? '', 'base64').toString('utf8')).toBe(moduleBytes)
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
      if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = previousGitWorkTree
      await rm(repository, { recursive: true, force: true })
      await rm(alternateRepository, { recursive: true, force: true })
    }
  })

  test('rejects grafts, replacement refs, and alternate object metadata before Git verification', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-repository-integrity-'))
    const alternateRepository = await mkdtemp(join(tmpdir(), 'bayn-candidate-alternate-objects-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    try {
      await mkdir(candidateDirectory, { recursive: true })
      await mkdir(join(alternateRepository, 'objects'), { recursive: true })
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)

      await writeFile(modulePath, 'export const candidate = "before-preregistration"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: candidate before preregistration'], repository)
      const priorRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const priorModuleOid = await execFileTextPromise('git', ['rev-parse', 'HEAD:candidate/program.mjs'], repository)

      await writeFile(modulePath, 'export const candidate = "preregistration-placeholder"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: preregistration placeholder'], repository)
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      expect(await execFileTextPromise('git', ['rev-parse', '--is-shallow-repository'], repository)).toBe('false')
      expect(
        await execFileTextPromise(
          'git',
          ['log', '--format=%H', `--find-object=${priorModuleOid}`, preregistrationRevision, '--'],
          repository,
        ),
      ).not.toBe('')
      expect(await Effect.runPromise(verifyCandidateDevelopmentRepositoryIntegrity(repository))).toBeUndefined()

      const graftsPath = resolve(
        repository,
        await execFileTextPromise('git', ['rev-parse', '--git-path', 'info/grafts'], repository),
      )
      await mkdir(dirname(graftsPath), { recursive: true })
      await writeFile(graftsPath, `${preregistrationRevision}\n`)
      expect(await execFileTextPromise('git', ['rev-parse', '--is-shallow-repository'], repository)).toBe('false')
      expect(
        await execFileTextPromise(
          'git',
          ['log', '--format=%H', `--find-object=${priorModuleOid}`, preregistrationRevision, '--'],
          repository,
        ),
      ).toBe('')
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'grafts', observed: [preregistrationRevision] },
      })
      await rm(graftsPath, { force: true })
      expect(await Effect.runPromise(verifyCandidateDevelopmentRepositoryIntegrity(repository))).toBeUndefined()

      await execFilePromise('git', ['replace', preregistrationRevision, priorRevision], repository)
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'replaceRefs' },
      })
      await execFilePromise('git', ['replace', '-d', preregistrationRevision], repository)

      await execFilePromise('git', ['config', 'replace.refBase', 'refs/custom-replace'], repository)
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'replacementConfig', observed: ['replace.refbase'] },
      })
      await execFilePromise('git', ['config', '--unset-all', 'replace.refBase'], repository)

      const alternatesPath = resolve(
        repository,
        await execFileTextPromise('git', ['rev-parse', '--git-path', 'objects/info/alternates'], repository),
      )
      await mkdir(dirname(alternatesPath), { recursive: true })
      await writeFile(alternatesPath, `${join(alternateRepository, 'objects')}\n`)
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'alternates' },
      })
      await rm(alternatesPath, { force: true })

      const httpAlternatesPath = resolve(
        repository,
        await execFileTextPromise('git', ['rev-parse', '--git-path', 'objects/info/http-alternates'], repository),
      )
      await writeFile(httpAlternatesPath, 'https://example.invalid/objects\n')
      expect(
        await Effect.runPromise(Effect.flip(verifyCandidateDevelopmentRepositoryIntegrity(repository))),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'httpAlternates' },
      })
      await rm(httpAlternatesPath, { force: true })
      expect(await Effect.runPromise(verifyCandidateDevelopmentRepositoryIntegrity(repository))).toBeUndefined()
    } finally {
      await rm(repository, { recursive: true, force: true })
      await rm(alternateRepository, { recursive: true, force: true })
    }
  })

  test('cancels repository-integrity Git verification on interruption', async () => {
    let aborted = false
    const sourceGit: CandidateDevelopmentSourceGit = {
      text: (_repositoryRoot, _args, signal) =>
        new Promise((_resolve, reject) => {
          const abort = () => {
            aborted = true
            reject(signal?.reason ?? new Error('aborted'))
          }
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        }),
      bytes: async () => Buffer.alloc(0),
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* verifyCandidateDevelopmentRepositoryIntegrity('/tmp/repository', sourceGit).pipe(
          Effect.forkChild,
        )
        yield* Effect.sleep('10 millis')
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout('1 second'))
      }),
    )
    expect(aborted).toBe(true)
  })

  test('keeps module-history novelty independent from a graft inserted after preflight', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-graft-race-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    try {
      await mkdir(candidateDirectory, { recursive: true })
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)

      await writeFile(modulePath, 'export const candidate = "before-preregistration"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: candidate before preregistration'], repository)
      const priorModuleOid = await execFileTextPromise('git', ['rev-parse', 'HEAD:candidate/program.mjs'], repository)

      await writeFile(modulePath, 'export const candidate = "preregistration-placeholder"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: preregistration placeholder'], repository)
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const graftsPath = resolve(
        repository,
        await execFileTextPromise('git', ['rev-parse', '--git-path', 'info/grafts'], repository),
      )
      await mkdir(dirname(graftsPath), { recursive: true })

      let graftInserted = false
      const sourceGit: CandidateDevelopmentSourceGit = {
        text: async (repositoryRoot, args) => {
          if (!graftInserted && args[0] === 'cat-file' && args[1] === 'commit') {
            graftInserted = true
            await writeFile(graftsPath, `${preregistrationRevision}\n`)
          }
          return execFileTextPromise('git', ['--no-replace-objects', '-C', repositoryRoot, ...args], repositoryRoot)
        },
        bytes: (repositoryRoot, args) =>
          execFileBytesPromise('git', ['--no-replace-objects', '-C', repositoryRoot, ...args], repositoryRoot),
      }

      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationModuleNovelty(
              repository,
              preregistrationRevision,
              'candidate/program.mjs',
              priorModuleOid,
              sourceGit,
            ),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-module-novelty',
        cause: {
          preregistrationRevision,
          observed: priorModuleOid,
        },
      })
      expect(graftInserted).toBe(true)
      expect(await execFileTextPromise('git', ['rev-parse', '--is-shallow-repository'], repository)).toBe('false')
      expect(
        await execFileTextPromise(
          'git',
          ['log', '--format=%H', `--find-object=${priorModuleOid}`, preregistrationRevision, '--'],
          repository,
        ),
      ).toBe('')
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('requires preregistration to be a proper Git ancestor without replacement objects', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-preregistration-lineage-'))
    const markerPath = join(repository, 'marker.txt')
    try {
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)

      await writeFile(markerPath, 'root\n')
      await execFilePromise('git', ['add', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: root'], repository)
      const rootRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      await writeFile(markerPath, 'preregistered\n')
      await execFilePromise('git', ['add', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: preregister candidate'], repository)
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      await writeFile(markerPath, 'implemented\n')
      await execFilePromise('git', ['add', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: implement candidate'], repository)
      const properDescendantRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      expect(
        await Effect.runPromise(
          verifyCandidateDevelopmentPreregistrationLineage(
            repository,
            preregistrationRevision,
            properDescendantRevision,
          ),
        ),
      ).toBeUndefined()

      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationLineage(
              repository,
              preregistrationRevision,
              preregistrationRevision,
            ),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-lineage',
        cause: {
          expected: 'proper ancestor of evaluated source revision',
          observed: preregistrationRevision,
        },
      })

      await execFilePromise('git', ['checkout', '-qb', 'divergent', rootRevision], repository)
      await writeFile(markerPath, 'divergent implementation\n')
      await execFilePromise('git', ['add', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: divergent implementation'], repository)
      const divergentRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const divergentTree = await execFileTextPromise('git', ['rev-parse', `${divergentRevision}^{tree}`], repository)
      const replacementCommit = await execFileTextPromise(
        'git',
        ['commit-tree', divergentTree, '-p', preregistrationRevision, '-m', 'test: forged ancestry'],
        repository,
      )
      await execFilePromise('git', ['replace', divergentRevision, replacementCommit], repository)

      await execFilePromise(
        'git',
        ['merge-base', '--is-ancestor', preregistrationRevision, divergentRevision],
        repository,
      )
      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationLineage(repository, preregistrationRevision, divergentRevision),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'replaceRefs' },
      })
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('cancels preregistration lineage Git verification on interruption', async () => {
    let aborted = false
    const sourceGit: CandidateDevelopmentSourceGit = {
      text: (_repositoryRoot, args, signal) => {
        if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return Promise.resolve('false')
        if (args[0] === 'for-each-ref') return Promise.resolve('')
        if (args[0] === 'config' && args[1] === '--list') return Promise.resolve('')
        if (args[0] === 'rev-parse' && args[1] === '--git-path') return Promise.resolve(args[2] ?? '')
        return new Promise((_resolve, reject) => {
          const abort = () => {
            aborted = true
            reject(signal?.reason ?? new Error('aborted'))
          }
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      },
      bytes: async () => Buffer.alloc(0),
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* verifyCandidateDevelopmentPreregistrationLineage(
          '/tmp/repository',
          '1'.repeat(40),
          '2'.repeat(40),
          sourceGit,
        ).pipe(Effect.forkChild)
        yield* Effect.sleep('10 millis')
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout('1 second'))
      }),
    )
    expect(aborted).toBe(true)
  })

  test('requires the evaluated module blob to postdate all preregistration history', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-preregistration-module-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    const markerPath = join(repository, 'marker.txt')
    try {
      await mkdir(candidateDirectory, { recursive: true })
      const completedModule = 'export const candidate = "completed-before-preregistration"\n'
      await writeFile(modulePath, completedModule)
      await writeFile(markerPath, 'completed candidate\n')
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
      await execFilePromise('git', ['add', 'candidate/program.mjs', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: complete candidate before preregistration'], repository)
      const completedModuleOid = await execFileTextPromise(
        'git',
        ['rev-parse', 'HEAD:candidate/program.mjs'],
        repository,
      )

      await writeFile(modulePath, 'export const candidate = "preregistration-placeholder"\n')
      await writeFile(markerPath, 'preregistered\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: preregister after replacing implementation'], repository)
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      await writeFile(modulePath, completedModule)
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: restore pre-preregistered implementation'], repository)

      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationModuleNovelty(
              repository,
              preregistrationRevision,
              'candidate/program.mjs',
              completedModuleOid,
            ),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-module-novelty',
        cause: {
          preregistrationRevision,
          modulePath: 'candidate/program.mjs',
          expected: 'evaluated module blob created after preregistration',
          observed: completedModuleOid,
        },
      })

      await writeFile(modulePath, 'export const candidate = "implemented-after-preregistration"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: implement after preregistration'], repository)
      const laterModuleOid = await execFileTextPromise('git', ['rev-parse', 'HEAD:candidate/program.mjs'], repository)
      expect(
        await Effect.runPromise(
          verifyCandidateDevelopmentPreregistrationModuleNovelty(
            repository,
            preregistrationRevision,
            'candidate/program.mjs',
            laterModuleOid,
          ),
        ),
      ).toBeUndefined()
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('caches immutable subtrees across preregistration history', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-preregistration-tree-cache-'))
    const stableDirectory = join(repository, 'stable')
    const markerPath = join(repository, 'marker.txt')
    const modulePath = join(repository, 'candidate', 'program.mjs')
    try {
      await mkdir(stableDirectory, { recursive: true })
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
      await writeFile(join(stableDirectory, 'fixture.txt'), 'stable subtree\n')
      await writeFile(markerPath, 'one\n')
      await execFilePromise('git', ['add', 'stable/fixture.txt', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: first preregistration ancestor'], repository)
      for (const value of ['two', 'three']) {
        await writeFile(markerPath, `${value}\n`)
        await execFilePromise('git', ['add', 'marker.txt'], repository)
        await execFilePromise('git', ['commit', '-qm', `test: ${value} preregistration ancestor`], repository)
      }
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const stableTreeOid = await execFileTextPromise(
        'git',
        ['rev-parse', `${preregistrationRevision}:stable`],
        repository,
      )

      await mkdir(dirname(modulePath), { recursive: true })
      await writeFile(modulePath, 'export const candidate = "implemented-after-preregistration"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: implement candidate after preregistration'], repository)
      const moduleBlobOid = await execFileTextPromise('git', ['rev-parse', 'HEAD:candidate/program.mjs'], repository)

      const queriedTreeOids: string[] = []
      let objectReaderOpenCount = 0
      const sourceGit: CandidateDevelopmentSourceGit = {
        text: (repositoryRoot, args) =>
          execFileTextPromise('git', ['--no-replace-objects', '-C', repositoryRoot, ...args], repositoryRoot),
        bytes: (repositoryRoot, args) =>
          execFileBytesPromise('git', ['--no-replace-objects', '-C', repositoryRoot, ...args], repositoryRoot),
        openObjectReader: async (repositoryRoot) => {
          objectReaderOpenCount += 1
          return {
            read: async (oid, expectedType) => {
              if (expectedType === 'tree') queriedTreeOids.push(oid)
              return execFileBytesPromise(
                'git',
                ['--no-replace-objects', '-C', repositoryRoot, 'cat-file', expectedType, oid],
                repositoryRoot,
              )
            },
            close: async () => undefined,
          }
        },
      }

      expect(
        await Effect.runPromise(
          verifyCandidateDevelopmentPreregistrationModuleNovelty(
            repository,
            preregistrationRevision,
            'candidate/program.mjs',
            moduleBlobOid,
            sourceGit,
          ),
        ),
      ).toBeUndefined()
      expect(objectReaderOpenCount).toBe(1)
      expect(queriedTreeOids.filter((treeOid) => treeOid === stableTreeOid)).toHaveLength(1)
      expect(new Set(queriedTreeOids).size).toBe(queriedTreeOids.length)
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('terminates the production Git batch reader on cancellation', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-batch-cancellation-'))
    try {
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
      await writeFile(join(repository, 'marker.txt'), 'marker\n')
      await execFilePromise('git', ['add', 'marker.txt'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: batch reader cancellation'], repository)
      const revision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)
      const controller = new AbortController()
      const reader = await openCandidateDevelopmentGitBatchObjectReader(repository, controller.signal)
      const commit = await reader.read(revision, 'commit')
      expect(commit.toString('utf8')).toContain('test: batch reader cancellation')
      controller.abort(new Error('test cancellation'))
      let rejected = false
      try {
        await reader.read(revision, 'commit')
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)
      await reader.close()
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('terminates the Git batch reader before buffering an oversized object', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-batch-oversized-'))
    try {
      await execFilePromise('git', ['init', '-q'], repository)
      const oversizedPath = join(repository, 'oversized.bin')
      await writeFile(oversizedPath, Buffer.alloc(4096, 0x61))
      const blobOid = await execFileTextPromise('git', ['hash-object', '-w', 'oversized.bin'], repository)
      const reader = await openCandidateDevelopmentGitBatchObjectReader(repository, new AbortController().signal, 128)
      let rejected = false
      try {
        await reader.read(blobOid, 'blob')
      } catch (cause) {
        rejected = true
        expect(String(cause)).toContain('maximumObjectBytes')
      }
      expect(rejected).toBe(true)
      await Promise.race([
        reader.close(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('oversized Git batch reader did not terminate')), 1_000),
        ),
      ])
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('rejects shallow Git history before module novelty verification', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-history-source-'))
    const shallowRepository = await mkdtemp(join(tmpdir(), 'bayn-candidate-history-shallow-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    try {
      await mkdir(candidateDirectory, { recursive: true })
      await writeFile(modulePath, 'export const candidate = "old"\n')
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: old candidate'], repository)
      await writeFile(modulePath, 'export const candidate = "new"\n')
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: new candidate'], repository)

      await rm(shallowRepository, { recursive: true, force: true })
      await execFilePromise(
        'git',
        ['clone', '-q', '--depth', '1', pathToFileURL(repository).href, shallowRepository],
        tmpdir(),
      )
      const preregistrationRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], shallowRepository)
      const moduleBlobOid = await execFileTextPromise(
        'git',
        ['rev-parse', 'HEAD:candidate/program.mjs'],
        shallowRepository,
      )
      expect(await execFileTextPromise('git', ['rev-parse', '--is-shallow-repository'], shallowRepository)).toBe('true')

      expect(
        await Effect.runPromise(
          Effect.flip(
            verifyCandidateDevelopmentPreregistrationModuleNovelty(
              shallowRepository,
              preregistrationRevision,
              'candidate/program.mjs',
              moduleBlobOid,
            ),
          ),
        ),
      ).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-repository-integrity',
        cause: { field: 'shallowRepository', expected: 'false', observed: 'true' },
      })
    } finally {
      await rm(repository, { recursive: true, force: true })
      await rm(shallowRepository, { recursive: true, force: true })
    }
  })

  test('pins verification and execution to the captured revision when HEAD moves', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'bayn-candidate-moving-head-'))
    const candidateDirectory = join(repository, 'candidate')
    const modulePath = join(candidateDirectory, 'program.mjs')
    const sourceManifestPath = join(candidateDirectory, 'source-manifest.json')
    const input = {
      candidateOrdinal: 16,
      priorTrialCount: 15,
      expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
      officialSessions: fixtureOfficialSessions,
      signalSessionDates: officialMonthEndSignalDates(fixtureOfficialSessions),
      featureLookbackSessions: 126,
    }
    const report = reportFixture(0.01)
    const evaluationTemplate = commandEvaluationFixture(report, baselineFixture())
    const sourceManifest: CandidateDevelopmentSourceManifest = {
      ...fixtureSourceManifest,
      modulePath: 'candidate/program.mjs',
    }
    const sourceManifestBytes = `${JSON.stringify(sourceManifest, null, 2)}\n`
    const sourceA = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(fixtureStrategyProtocol)},
        buildEvaluation: (verifiedSource) => {
          const evaluation = ${JSON.stringify(evaluationTemplate)}
          evaluation.baseline.runId = verifiedSource.baselineRunId
          evaluation.baseline.codeRevision = verifiedSource.sourceRevision
          evaluation.accounting.runId = verifiedSource.baselineRunId
          evaluation.accounting.stressedRunId = verifiedSource.stressedRunId
          return evaluation
        },
      }
    `
    const sourceB = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(fixtureStrategyProtocol)},
        buildEvaluation: () => { throw new Error('commit B executed') },
      }
    `

    try {
      await mkdir(candidateDirectory, { recursive: true })
      await writeFile(modulePath, sourceA)
      await writeFile(sourceManifestPath, sourceManifestBytes)
      await execFilePromise('git', ['init', '-q'], repository)
      await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
      await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
      await execFilePromise('git', ['add', 'candidate/program.mjs', 'candidate/source-manifest.json'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: add source A'], repository)
      const sourceRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      await writeFile(modulePath, sourceB)
      await execFilePromise('git', ['add', 'candidate/program.mjs'], repository)
      await execFilePromise('git', ['commit', '-qm', 'test: add source B'], repository)
      const movedRevision = await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)

      const capturedRevisions: string[] = []
      const movingHeadGit: CandidateDevelopmentSourceGit = {
        text: async (repositoryRoot, args) => {
          const output = await execFileTextPromise('git', args, repositoryRoot)
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            capturedRevisions.push(output)
            await execFilePromise('git', ['reset', '--hard', movedRevision], repositoryRoot)
          }
          return output
        },
        bytes: (repositoryRoot, args) => execFileBytesPromise('git', args, repositoryRoot),
      }
      let verificationPasses = 0
      const sourceVerifier: CandidateDevelopmentSourceVerifier = (observedModulePath, observedManifestPath) =>
        Effect.promise(async () => {
          verificationPasses += 1
          await execFilePromise('git', ['reset', '--hard', sourceRevision], repository)
        }).pipe(
          Effect.andThen(
            verifyCandidateDevelopmentSourceFiles(observedModulePath, observedManifestPath, movingHeadGit),
          ),
        )
      let importedSource = ''
      const importer = (moduleUrl: string, verifiedFiles: CandidateDevelopmentVerifiedSourceFiles) => {
        importedSource = Buffer.from(moduleUrl.split(',')[1] ?? '', 'base64').toString('utf8')
        return evaluateCandidateDevelopmentArtifact(moduleUrl, verifiedFiles)
      }

      const loaded = await Effect.runPromise(
        loadCandidateDevelopmentExecutableProgram(modulePath, sourceManifestPath, importer, sourceVerifier),
      )
      const expectedFiles: CandidateDevelopmentVerifiedSourceFiles = {
        schemaVersion: 'bayn.candidate-development-verified-source-files.v1',
        sourceRevision,
        modulePath: 'candidate/program.mjs',
        moduleBlobOid: await execFileTextPromise(
          'git',
          ['rev-parse', `${sourceRevision}:candidate/program.mjs`],
          repository,
        ),
        moduleSha256: sha256(sourceA),
        sourceManifestPath: 'candidate/source-manifest.json',
        sourceManifestBlobOid: await execFileTextPromise(
          'git',
          ['rev-parse', `${sourceRevision}:candidate/source-manifest.json`],
          repository,
        ),
        sourceManifestSha256: sha256(sourceManifestBytes),
        sourceManifest,
      }
      const expectedVerifiedSource = successOf(bindCandidateDevelopmentVerifiedSource(expectedFiles, input))
      const decoded = await Effect.runPromise(
        loaded.program.effects.evaluateDevelopment(undefined, undefined as never, loaded.verifiedSource),
      )

      expect(verificationPasses).toBe(2)
      expect(capturedRevisions).toEqual([sourceRevision, sourceRevision])
      expect(importedSource).toBe(sourceA)
      expect(loaded.verifiedSource).toEqual(expectedVerifiedSource)
      expect(decoded.baseline.codeRevision).toBe(sourceRevision)
      expect(decoded.baseline.runId).toBe(expectedVerifiedSource.baselineRunId)
      expect(decoded.accounting.stressedRunId).toBe(expectedVerifiedSource.stressedRunId)
      expect(await execFileTextPromise('git', ['rev-parse', 'HEAD'], repository)).toBe(movedRevision)
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  test('evaluates the immutable artifact without host code-loading capabilities', async () => {
    const input = {
      candidateOrdinal: 16,
      priorTrialCount: 15,
      expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
      officialSessions: fixtureOfficialSessions,
      signalSessionDates: officialMonthEndSignalDates(fixtureOfficialSessions),
      featureLookbackSessions: 126,
    }
    const verifiedSource = successOf(bindCandidateDevelopmentVerifiedSource(fixtureVerifiedSourceFiles, input))
    const report = reportFixture(0.01)
    const baseEvaluation = commandEvaluationFixture(report, baselineFixture())
    const evaluation = {
      ...baseEvaluation,
      baseline: {
        ...baseEvaluation.baseline,
        runId: verifiedSource.baselineRunId,
        codeRevision: verifiedSource.sourceRevision,
      },
      accounting: {
        ...baseEvaluation.accounting,
        runId: verifiedSource.baselineRunId,
        stressedRunId: verifiedSource.stressedRunId,
      },
    }
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(fixtureStrategyProtocol)},
        buildEvaluation: (verifiedSource) => {
          const unavailable = [
            typeof globalThis['process'],
            typeof globalThis['Bun'],
            typeof globalThis['fetch'],
            typeof globalThis['require'],
            typeof globalThis['module'],
            typeof globalThis['Promise'],
            typeof globalThis['ShadowRealm'],
            typeof globalThis['Atomics'],
            typeof globalThis['SharedArrayBuffer'],
            typeof globalThis['Date'],
            typeof globalThis['Intl'],
            typeof globalThis['Loader'],
            typeof globalThis['Temporal'],
            typeof globalThis['performance'],
            typeof globalThis['crypto'],
            typeof globalThis['navigator'],
            typeof globalThis['WebAssembly'],
            typeof globalThis['Worker'],
            typeof globalThis['setTimeout'],
            typeof Math['random'],
            typeof String.prototype['localeCompare'],
            typeof Number.prototype['toLocaleString'],
          ].every((value) => value === 'undefined')
          let functionBlocked = false
          let constructorBlocked = false
          let evalBlocked = false
          try { globalThis['Function']('return 1')() } catch { functionBlocked = true }
          try { ({}).constructor.constructor('return 1')() } catch { constructorBlocked = true }
          try { globalThis['eval']('1') } catch { evalBlocked = true }
          if (
            !unavailable ||
            globalThis.constructor !== null ||
            !functionBlocked ||
            !constructorBlocked ||
            !evalBlocked ||
            verifiedSource.baselineRunId !== ${JSON.stringify(verifiedSource.baselineRunId)}
          ) {
            throw new Error('candidate artifact sandbox is not closed')
          }
          return ${JSON.stringify(evaluation)}
        },
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    const loaded = await Effect.runPromise(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))
    const program = successOf(
      validateCandidateDevelopmentExecutableProgram(
        (loaded as { readonly candidateDevelopmentProgram?: unknown }).candidateDevelopmentProgram,
      ),
    )
    const decoded = await Effect.runPromise(
      program.effects.evaluateDevelopment(undefined, undefined as never, verifiedSource),
    )

    expect(decoded.baseline.codeRevision).toBe(verifiedSource.sourceRevision)
    expect(decoded.baseline.runId).toBe(verifiedSource.baselineRunId)
    expect(decoded.accounting.stressedRunId).toBe(verifiedSource.stressedRunId)
  })

  test('interrupts a real infinite-loop artifact worker promptly', async () => {
    const input = {
      candidateOrdinal: 16,
      priorTrialCount: 15,
      expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
      officialSessions: fixtureOfficialSessions,
      signalSessionDates: officialMonthEndSignalDates(fixtureOfficialSessions),
      featureLookbackSessions: 126,
    }
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(fixtureStrategyProtocol)},
        buildEvaluation: () => { while (true) {} },
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    const loaded = await Effect.runPromise(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))
    const program = successOf(
      validateCandidateDevelopmentExecutableProgram(
        (loaded as { readonly candidateDevelopmentProgram?: unknown }).candidateDevelopmentProgram,
      ),
    )
    const verifiedSource = successOf(bindCandidateDevelopmentVerifiedSource(fixtureVerifiedSourceFiles, input))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* program.effects
          .evaluateDevelopment(undefined, undefined as never, verifiedSource)
          .pipe(Effect.forkChild)
        yield* Effect.sleep('50 millis')
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout('1 second'))
      }),
    )
  })

  test('rejects async artifact execution before entering the sandbox', async () => {
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: {},
        strategyProtocol: {},
        buildEvaluation: async () => ({}),
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-format',
        cause: { identifiers: ['async'] },
      },
    })
  })

  test('rejects nonliteral dynamic imports before sandbox execution', async () => {
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: {},
        strategyProtocol: {},
        buildEvaluation: () => import('node:' + 'fs').catch(() => ({})),
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-format',
        cause: { identifiers: ['import'] },
      },
    })
  })

  test('rejects ShadowRealm before sandbox execution', async () => {
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: {},
        strategyProtocol: {},
        buildEvaluation: () => new ShadowRealm().evaluate('Math.random()'),
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-format',
        cause: { identifiers: ['ShadowRealm'] },
      },
    })
  })

  test('rejects Bun Loader before sandbox execution', async () => {
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: {},
        strategyProtocol: {},
        buildEvaluation: () => Loader,
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-format',
        cause: { identifiers: ['Loader'] },
      },
    })
  })

  test('rejects source drift during import before returning an executable program', async () => {
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
    let verificationCount = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        loadCandidateDevelopmentExecutableProgram(
          '/tmp/candidate-development-program.ts',
          '/tmp/candidate-development-source-manifest.json',
          () => Effect.succeed({ candidateDevelopmentProgram: program }),
          () => {
            verificationCount += 1
            return Effect.succeed(
              verificationCount === 1
                ? fixtureVerifiedModuleSource
                : {
                    ...fixtureVerifiedModuleSource,
                    files: { ...fixtureVerifiedSourceFiles, moduleSha256: 'f'.repeat(64) },
                  },
            )
          },
        ),
      ),
    )

    expect(verificationCount).toBe(2)
    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-post-import',
    })
  })

  test('does not import a module when Git source verification fails', async () => {
    let imports = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        loadCandidateDevelopmentExecutableProgram(
          '/tmp/candidate-development-program.ts',
          '/tmp/candidate-development-source-manifest.json',
          () => {
            imports += 1
            return Effect.succeed({})
          },
          () =>
            Effect.fail({
              _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
              operation: 'verify-module-blob',
              cause: 'tampered',
            }),
        ),
      ),
    )

    expect(imports).toBe(0)
    expect(failure).toEqual({
      _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
      operation: 'verify-module-blob',
      cause: 'tampered',
    })
  })

  test('aborts a stalled source Git subprocess when verification is interrupted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-abort-'))
    const modulePath = join(directory, 'program.mjs')
    const sourceManifestPath = join(directory, 'source-manifest.json')
    let resolveStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let aborted = false
    const sourceGit: CandidateDevelopmentSourceGit = {
      text: (_repositoryRoot, _args, signal) =>
        new Promise((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error('source verification did not provide an abort signal'))
            return
          }
          resolveStarted?.()
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal.reason ?? new Error('source verification aborted'))
            },
            { once: true },
          )
        }),
      bytes: () => Promise.reject(new Error('source byte read must not start')),
    }

    try {
      await writeFile(modulePath, 'export const candidateDevelopmentArtifact = {}\n')
      await writeFile(sourceManifestPath, '{}\n')
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit).pipe(
            Effect.forkChild,
          )
          yield* Effect.promise(() => started)
          yield* Fiber.interrupt(fiber)
        }),
      )
      expect(aborted).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('aborts and joins a sibling source Git read after batch failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-source-pair-abort-'))
    const modulePath = join(directory, 'program.mjs')
    const sourceManifestPath = join(directory, 'source-manifest.json')
    const sourceRevision = 'a'.repeat(40)
    let siblingStarted = false
    let siblingAborted = false
    let siblingSettled = false
    const sourceGit: CandidateDevelopmentSourceGit = {
      text: (_repositoryRoot, args) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return Promise.resolve(directory)
        if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return Promise.resolve('false')
        if (args[0] === 'for-each-ref') return Promise.resolve('')
        if (args[0] === 'config' && args[1] === '--list') return Promise.resolve('')
        if (args[0] === 'rev-parse' && args[1] === '--git-path') return Promise.resolve(args[2] ?? '')
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return Promise.resolve(sourceRevision)
        return Promise.reject(new Error(`unexpected Git text command: ${args.join(' ')}`))
      },
      bytes: (_repositoryRoot, args, signal) => {
        const spec = args.at(-1) ?? ''
        if (spec.endsWith(':program.mjs')) return Promise.reject(new Error('module blob failed'))
        return new Promise((_resolve, reject) => {
          siblingStarted = true
          if (signal === undefined) {
            siblingSettled = true
            reject(new Error('paired source read did not receive an abort signal'))
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              siblingAborted = true
              siblingSettled = true
              reject(signal.reason ?? new Error('paired source read aborted'))
            },
            { once: true },
          )
        })
      },
    }

    try {
      await writeFile(modulePath, 'export const candidateDevelopmentArtifact = {}\n')
      await writeFile(sourceManifestPath, '{}\n')
      const failure = await Effect.runPromise(
        Effect.flip(verifyCandidateDevelopmentSourceFiles(modulePath, sourceManifestPath, sourceGit)),
      )

      expect(failure).toMatchObject({
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-module-blob',
      })
      expect(siblingStarted).toBe(true)
      expect(siblingAborted).toBe(true)
      expect(siblingSettled).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('interrupts dynamic module evaluation without detaching it', async () => {
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
        const fiber = yield* loadCandidateDevelopmentExecutableProgram(
          '/tmp/candidate-development-program.ts',
          '/tmp/candidate-development-source-manifest.json',
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.tap(() =>
                Effect.sync(() => {
                  completed = true
                }),
              ),
              Effect.as({ candidateDevelopmentProgram: program }),
            ),
          () => Effect.succeed(fixtureVerifiedModuleSource),
        ).pipe(Effect.forkChild)

        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect(completed).toBe(false)

        yield* Deferred.succeed(release, undefined)
        yield* Effect.yieldNow

        expect(completed).toBe(false)
      }),
    )
  })
})
