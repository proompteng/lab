import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deferred, Effect, Fiber, Result } from 'effect'

import { frozenCandidateDevelopmentSessions } from './candidate-development-calendar'
import {
  bindCandidateDevelopmentVerifiedSource,
  buildCandidateDevelopmentCommandReport as buildCandidateDevelopmentCommandReportPure,
  candidateDevelopmentExecutableProgramSchemaVersion,
  evaluateCandidateDevelopmentArtifact,
  executeCandidateDevelopmentProgram,
  loadCandidateDevelopmentExecutableProgram,
  renderCandidateDevelopmentCommandReport,
  validateCandidateDevelopmentCommandEvaluation,
  validateCandidateDevelopmentExecutableProgram,
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
        stressedSimulation: fullAccountingSimulationFixture(stressedSimulation),
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
      buildCandidateDevelopmentCommandReport(report, { ...evaluation, accounting }, fixtureStrategyProtocol),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
        reason: 'binding-mismatch',
        field: 'baseline.calendar.start',
        expected: 'contiguous slice of official sessions',
        observed: fixtureAccountingStart,
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
            positions: [zeroPositionFixture(earlierSession)],
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
            typeof globalThis['Atomics'],
            typeof globalThis['SharedArrayBuffer'],
            typeof globalThis['Date'],
            typeof globalThis['Intl'],
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
