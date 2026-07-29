import { pipe, Result } from 'effect'

import { MICROS } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import {
  analyzeQualificationWithSelectionMultiplicity,
  type QualificationObservation,
  type QualificationSeries,
} from '../qualification-statistics'
import {
  buildVerdict,
  directVolatilityWeights,
  simulate,
  type AlignedSession,
  type SimulationResult,
  type SimulationTarget,
} from '../simulation'
import { calculateExactPerformanceMetrics } from '../simulation/metrics'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyPerformancePoint,
  type IsoDate,
  type SimulationProtocol,
} from '../types'
import type { CandidateDevelopmentPreflightPass } from '../candidate-development'
import {
  CANDIDATE_10_DEVELOPMENT_END,
  CANDIDATE_10_DEVELOPMENT_START,
  CANDIDATE_10_HOLDOUT_END,
  CANDIDATE_10_HOLDOUT_START,
  CANDIDATE_10_SNAPSHOT_ID,
  candidate10BehaviorMaterial,
  candidate10DevelopmentSessions,
  candidate10DevelopmentStatisticsPolicy,
  candidate10PriorAttemptIds,
  candidate10Protocol,
  candidate10SelectionMultiplicity,
  candidate10SimulationProtocol,
  candidate10Specifications,
  candidate10Universe,
  type Candidate10Dataset,
  type Candidate10DevelopmentReport,
  type Candidate10Failure,
  type Candidate10Plan,
  type Candidate10PreparedData,
  type Candidate10Registration,
  type Candidate10SpecificationReport,
  type Candidate10Symbol,
} from './model'
import { buildCandidate10Plan, candidate10TerminalLiquidationIsComplete } from './strategy'

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate10Failure> =>
  Result.fail({ _tag: 'Candidate10InvalidInput', operation, reason })

const canonicalHash = (operation: string, material: unknown): Result.Result<string, Candidate10Failure> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError((cause): Candidate10Failure => ({ _tag: 'Candidate10HashFailure', operation, cause })),
  )

const exactDates = (left: readonly IsoDate[], right: readonly IsoDate[]): boolean =>
  left.length === right.length && left.every((date, index) => date === right[index])

export const candidate10DatasetHashes = (
  sessions: readonly IsoDate[],
  bars: Candidate10Dataset['bars'],
): Result.Result<{ readonly sessionsContentHash: string; readonly barsContentHash: string }, Candidate10Failure> =>
  Result.all({
    sessionsContentHash: canonicalHash('development-sessions', {
      schemaVersion: 'bayn.candidate-10-development-sessions.v1',
      snapshotId: CANDIDATE_10_SNAPSHOT_ID,
      sessions,
    }),
    barsContentHash: canonicalHash('development-bars', {
      schemaVersion: 'bayn.candidate-10-development-bars.v1',
      snapshotId: CANDIDATE_10_SNAPSHOT_ID,
      universe: candidate10Universe,
      bars,
    }),
  })

const validDatasetBar = (bar: Candidate10Dataset['bars'][number]): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
  Number.isFinite(bar.volume) &&
  bar.volume >= 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

export const prepareCandidate10DevelopmentData = (
  dataset: Candidate10Dataset,
): Result.Result<Candidate10PreparedData, Candidate10Failure> => {
  const expectedSessions = candidate10DevelopmentSessions()
  if (dataset.snapshotId !== CANDIDATE_10_SNAPSHOT_ID) {
    return fail('dataset', `snapshot ${dataset.snapshotId} differs from ${CANDIDATE_10_SNAPSHOT_ID}`)
  }
  if (!exactDates(dataset.sessions, expectedSessions)) return fail('dataset', 'official development sessions differ')
  const expectedBarCount = expectedSessions.length * candidate10Universe.length
  if (dataset.bars.length !== expectedBarCount) {
    return fail('dataset', `expected ${expectedBarCount} bars, observed ${dataset.bars.length}`)
  }
  return pipe(
    candidate10DatasetHashes(dataset.sessions, dataset.bars),
    Result.flatMap((hashes) => {
      if (hashes.sessionsContentHash !== dataset.sessionsContentHash) {
        return fail('dataset', 'sessions content hash differs')
      }
      if (hashes.barsContentHash !== dataset.barsContentHash) return fail('dataset', 'bars content hash differs')
      const sessions: AlignedSession[] = []
      for (let sessionIndex = 0; sessionIndex < expectedSessions.length; sessionIndex += 1) {
        const date = expectedSessions.at(sessionIndex)
        if (date === undefined) return fail('dataset', `session ${sessionIndex} is missing`)
        const bars: Partial<Record<Candidate10Symbol, AlignedSession['bars'][string]>> = {}
        for (let symbolIndex = 0; symbolIndex < candidate10Universe.length; symbolIndex += 1) {
          const symbol = candidate10Universe.at(symbolIndex)
          const bar = dataset.bars.at(sessionIndex * candidate10Universe.length + symbolIndex)
          if (symbol === undefined || bar === undefined)
            return fail('dataset', `bar ${sessionIndex}:${symbolIndex} missing`)
          if (bar.sessionDate !== date || bar.symbol !== symbol) {
            return fail(
              'dataset',
              `expected ${date}:${symbol}, observed ${bar.sessionDate}:${bar.symbol} at ${sessionIndex}:${symbolIndex}`,
            )
          }
          if (!validDatasetBar(bar)) return fail('dataset', `invalid OHLCV on ${date}:${symbol}`)
          bars[symbol] = {
            symbol,
            sessionDate: date,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            source: DataSource.Alpaca,
            sourceFeed: DataFeed.Sip,
            adjustment: PriceAdjustment.All,
            publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
          }
        }
        sessions.push({ date, bars: bars as AlignedSession['bars'] })
      }
      return Result.succeed({ dataset, sessions })
    }),
  )
}

const spyBenchmarkProtocol: SimulationProtocol = {
  ...candidate10SimulationProtocol,
  universe: ['SPY'],
}

const benchmarkTargets = (
  sessions: readonly AlignedSession[],
  strategyTargets: readonly SimulationTarget[],
  startIndex: number,
): Result.Result<
  { readonly buyAndHold: readonly SimulationTarget[]; readonly directVolatility: readonly SimulationTarget[] },
  Candidate10Failure
> => {
  const terminal = strategyTargets.at(-1)
  if (terminal === undefined || terminal.executionIndex !== sessions.length - 1) {
    return fail('benchmarks', 'terminal target is missing')
  }
  const benchmarkTerminal: SimulationTarget = {
    signalIndex: terminal.signalIndex,
    executionIndex: terminal.executionIndex,
    weights: { SPY: 0 },
  }
  return pipe(
    Result.all(
      strategyTargets.slice(0, -1).map((target) =>
        pipe(
          directVolatilityWeights(sessions, target.signalIndex, spyBenchmarkProtocol),
          Result.mapError(
            (cause): Candidate10Failure => ({
              _tag: 'Candidate10SimulationFailure',
              simulation: 'direct-volatility-target',
              cause,
            }),
          ),
          Result.map(
            (weights): SimulationTarget => ({
              signalIndex: target.signalIndex,
              executionIndex: target.executionIndex,
              weights,
            }),
          ),
        ),
      ),
    ),
    Result.map((directVolatility) => ({
      buyAndHold: [
        {
          signalIndex: startIndex - 1,
          executionIndex: startIndex,
          weights: { SPY: 1 },
        },
        benchmarkTerminal,
      ],
      directVolatility: [...directVolatility, benchmarkTerminal],
    })),
  )
}

const runSimulation = (
  simulation: string,
  sessions: readonly AlignedSession[],
  targets: readonly SimulationTarget[],
  simulationStartIndex: number,
  evaluationStartIndex: number,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
): Result.Result<SimulationResult, Candidate10Failure> => {
  const raw = simulate(sessions, targets, simulationStartIndex, protocol, costMultiplierMicros, runId, false)
  if (Result.isFailure(raw)) {
    return Result.fail({ _tag: 'Candidate10SimulationFailure', simulation, cause: raw.failure })
  }
  const evaluationStartDate = sessions.at(evaluationStartIndex)?.date
  if (evaluationStartDate === undefined) return fail(simulation, `evaluation index ${evaluationStartIndex} is missing`)
  const selectedOffset = raw.success.dailyPerformance.findIndex((point) => point.sessionDate === evaluationStartDate)
  if (selectedOffset < 0) return fail(simulation, `evaluation date ${evaluationStartDate} is missing`)
  const selected = raw.success.dailyPerformance.slice(selectedOffset)
  const expectedObservations = sessions.length - evaluationStartIndex
  const first = selected.at(0)
  const last = selected.at(-1)
  if (selected.length !== expectedObservations || first === undefined || last === undefined) {
    return fail(simulation, `expected ${expectedObservations} selected observations, observed ${selected.length}`)
  }
  const initialCapitalMicros = BigInt(protocol.initialCapitalMicros)
  const firstEquityMicros = BigInt(first.equityMicros)
  const firstNetReturn = Number(firstEquityMicros) / Number(initialCapitalMicros) - 1
  if (!Number.isFinite(firstNetReturn)) return fail(simulation, 'first selected return is not finite')
  const normalizedDailyPerformance = [{ ...first, netReturn: firstNetReturn }, ...selected.slice(1)]
  const metrics = calculateExactPerformanceMetrics(
    normalizedDailyPerformance.map((point) => BigInt(point.equityMicros)),
    BigInt(last.cumulativeTurnoverMicros),
    BigInt(last.cumulativeFeesMicros),
    BigInt(last.cumulativeSpreadCostMicros),
    BigInt(last.cumulativeSlippageCostMicros),
    BigInt(last.cumulativeCashYieldMicros),
    initialCapitalMicros,
  )
  if (Result.isFailure(metrics)) {
    return Result.fail({ _tag: 'Candidate10SimulationFailure', simulation, cause: metrics.failure })
  }
  return Result.succeed({ ...raw.success, metrics: metrics.success, dailyPerformance: normalizedDailyPerformance })
}

const performanceByDate = (
  points: readonly DailyPerformancePoint[],
  name: string,
): Result.Result<ReadonlyMap<IsoDate, DailyPerformancePoint>, Candidate10Failure> => {
  const map = new Map<IsoDate, DailyPerformancePoint>()
  for (const point of points) {
    if (map.has(point.sessionDate)) return fail(name, `duplicate daily performance ${point.sessionDate}`)
    map.set(point.sessionDate, point)
  }
  return Result.succeed(map)
}

const qualificationSeries = (
  runId: string,
  strategy: SimulationResult,
  buyAndHold: SimulationResult,
  directVolatility: SimulationResult,
  rebalanceExecutionDates: readonly IsoDate[],
): Result.Result<QualificationSeries, Candidate10Failure> =>
  pipe(
    Result.all({
      buyAndHold: performanceByDate(buyAndHold.dailyPerformance, 'buy-and-hold-series'),
      directVolatility: performanceByDate(directVolatility.dailyPerformance, 'direct-volatility-series'),
    }),
    Result.flatMap((benchmarks) => {
      const observations: QualificationObservation[] = []
      for (const point of strategy.dailyPerformance) {
        const buyAndHoldPoint = benchmarks.buyAndHold.get(point.sessionDate)
        const directVolatilityPoint = benchmarks.directVolatility.get(point.sessionDate)
        if (buyAndHoldPoint === undefined || directVolatilityPoint === undefined) {
          return fail('qualification-series', `benchmark alignment missing ${point.sessionDate}`)
        }
        observations.push({
          sessionDate: point.sessionDate,
          strategyReturn: point.netReturn,
          cashReturn: 0,
          buyAndHoldReturn: buyAndHoldPoint.netReturn,
          directVolatilityReturn: directVolatilityPoint.netReturn,
        })
      }
      if (
        observations.length !== buyAndHold.dailyPerformance.length ||
        observations.length !== directVolatility.dailyPerformance.length
      ) {
        return fail('qualification-series', 'daily performance lengths differ')
      }
      return Result.succeed({
        schemaVersion: 'bayn.qualification-series.v1',
        runId,
        observations,
        rebalanceExecutionDates,
      })
    }),
  )

interface Candidate10BenchmarkResults {
  readonly buyAndHold: SimulationResult
  readonly directVolatility: SimulationResult
  readonly terminalCash: boolean
}

const evaluateSpecification = (
  prepared: Candidate10PreparedData,
  plan: Candidate10Plan,
  familyStrategyHash: string,
  familyRunId: string,
  benchmarks: Candidate10BenchmarkResults,
): Result.Result<Candidate10SpecificationReport, Candidate10Failure> =>
  pipe(
    canonicalHash('specification-strategy', {
      schemaVersion: 'bayn.candidate-10-specification-strategy.v1',
      familyStrategyHash,
      specification: plan.specification,
    }),
    Result.flatMap((strategyHash) =>
      pipe(
        canonicalHash('specification-run', {
          schemaVersion: 'bayn.candidate-10-specification-run.v1',
          familyRunId,
          strategyHash,
        }),
        Result.flatMap((runId) =>
          pipe(
            Result.all({
              strategy: runSimulation(
                `strategy:${plan.specification.id}`,
                prepared.sessions,
                plan.targets,
                plan.simulationStartIndex,
                plan.evaluationStartIndex,
                candidate10SimulationProtocol,
                MICROS,
                runId,
              ),
              doubleCostStrategy: runSimulation(
                `double-cost:${plan.specification.id}`,
                prepared.sessions,
                plan.targets,
                plan.simulationStartIndex,
                plan.evaluationStartIndex,
                candidate10SimulationProtocol,
                BigInt(candidate10SimulationProtocol.executionModel.doubleCostMultiplier) * MICROS,
                runId,
              ),
            }),
            Result.flatMap((simulations) => {
              const economicVerdict = buildVerdict(
                simulations.strategy.metrics,
                benchmarks.buyAndHold.metrics,
                benchmarks.directVolatility.metrics,
                simulations.doubleCostStrategy.metrics,
                candidate10SimulationProtocol,
              )
              return pipe(
                qualificationSeries(
                  runId,
                  simulations.strategy,
                  benchmarks.buyAndHold,
                  benchmarks.directVolatility,
                  plan.rebalanceExecutionDates,
                ),
                Result.flatMap((series) =>
                  pipe(
                    analyzeQualificationWithSelectionMultiplicity(
                      series,
                      candidate10DevelopmentStatisticsPolicy,
                      candidate10PriorAttemptIds,
                      candidate10SelectionMultiplicity,
                    ),
                    Result.mapError(
                      (cause): Candidate10Failure => ({ _tag: 'Candidate10QualificationFailure', cause }),
                    ),
                    Result.map((analysis): Candidate10SpecificationReport => {
                      const directIsStronger =
                        benchmarks.directVolatility.metrics.sharpe > benchmarks.buyAndHold.metrics.sharpe
                      const selectedBenchmark = directIsStronger
                        ? ('direct-volatility-timing' as const)
                        : ('buy-and-hold' as const)
                      const benchmarkMetrics = directIsStronger
                        ? benchmarks.directVolatility.metrics
                        : benchmarks.buyAndHold.metrics
                      const terminalCash = {
                        strategy: benchmarks.terminalCash,
                        buyAndHold: benchmarks.terminalCash,
                        directVolatility: benchmarks.terminalCash,
                        doubleCostStrategy: benchmarks.terminalCash,
                      }
                      const developmentPass =
                        economicVerdict.status === 'PASS' &&
                        analysis.status === 'PASS' &&
                        Object.values(terminalCash).every(Boolean)
                      return {
                        specification: plan.specification,
                        identity: { strategyHash, runId },
                        metrics: {
                          strategy: simulations.strategy.metrics,
                          buyAndHold: benchmarks.buyAndHold.metrics,
                          directVolatility: benchmarks.directVolatility.metrics,
                          doubleCostStrategy: simulations.doubleCostStrategy.metrics,
                          benchmarkRelativeAnnualizedReturn:
                            simulations.strategy.metrics.annualizedReturn - benchmarkMetrics.annualizedReturn,
                          benchmarkSharpeDifference: simulations.strategy.metrics.sharpe - benchmarkMetrics.sharpe,
                        },
                        selectedBenchmark,
                        economicVerdict,
                        terminalCash,
                        uncertainty: {
                          status: analysis.status,
                          reasonCodes: analysis.reasonCodes,
                          adjustedOneSidedAlpha: analysis.bootstrap.adjustedOneSidedAlpha,
                          producedBootstrapSamples: analysis.bootstrap.producedSamples,
                          bootstrapSamplesHash: analysis.bootstrap.samplesHash,
                          annualizedExcessReturnLowerBound: analysis.bootstrap.annualizedExcessReturnLowerBound,
                          sharpeDifferenceLowerBound: analysis.bootstrap.sharpeDifferenceLowerBound,
                          completeRebalanceBlocks: analysis.completeBlocks.length,
                          requiredCompleteRebalanceBlocks: analysis.power.requiredCompleteRebalanceBlocks,
                          availableCompleteSessions: analysis.power.availableCompleteSessions,
                          requiredCompleteSessions: analysis.power.requiredSessions,
                          walkForwardFolds: analysis.walkForward.folds.map((fold) => ({
                            ordinal: fold.ordinal,
                            trainingStart: fold.trainingStart,
                            trainingEnd: fold.trainingEnd,
                            testStart: fold.testStart,
                            testEnd: fold.testEnd,
                            testObservationCount: fold.testObservationCount,
                            excessReturn: fold.excessReturn,
                            maximumDrawdown: fold.maximumDrawdown,
                            positiveExcess: fold.positiveExcess,
                          })),
                          positiveWalkForwardFolds: analysis.walkForward.positiveFolds,
                          analysisHash: analysis.analysisHash,
                        },
                        developmentPass,
                      }
                    }),
                  ),
                ),
              )
            }),
          ),
        ),
      ),
    ),
  )

export interface Candidate10SelectionFact {
  readonly specificationId: Candidate10SpecificationReport['specification']['id']
  readonly developmentPass: boolean
  readonly annualizedExcessReturnLowerBound: number
  readonly sharpeDifferenceLowerBound: number
  readonly annualTurnover: number
}

export const selectCandidate10SpecificationId = (
  facts: readonly Candidate10SelectionFact[],
): Candidate10SelectionFact['specificationId'] | null =>
  facts
    .filter((fact) => fact.developmentPass)
    .toSorted(
      (left, right) =>
        right.annualizedExcessReturnLowerBound - left.annualizedExcessReturnLowerBound ||
        right.sharpeDifferenceLowerBound - left.sharpeDifferenceLowerBound ||
        left.annualTurnover - right.annualTurnover ||
        left.specificationId.localeCompare(right.specificationId),
    )
    .at(0)?.specificationId ?? null

export const selectCandidate10Specification = (
  reports: readonly Candidate10SpecificationReport[],
): Candidate10SpecificationReport | undefined => {
  const selectedId = selectCandidate10SpecificationId(
    reports.map((report) => ({
      specificationId: report.specification.id,
      developmentPass: report.developmentPass,
      annualizedExcessReturnLowerBound: report.uncertainty.annualizedExcessReturnLowerBound,
      sharpeDifferenceLowerBound: report.uncertainty.sharpeDifferenceLowerBound,
      annualTurnover: report.metrics.strategy.annualTurnover,
    })),
  )
  return selectedId === null ? undefined : reports.find((report) => report.specification.id === selectedId)
}

export const evaluateCandidate10Development = (
  registration: Candidate10Registration,
  dataset: Candidate10Dataset,
  preflight: CandidateDevelopmentPreflightPass,
): Result.Result<Candidate10DevelopmentReport, Candidate10Failure> => {
  const prepared = prepareCandidate10DevelopmentData(dataset)
  if (Result.isFailure(prepared)) return Result.fail(prepared.failure)
  const parameterHash = canonicalHash('parameters', {
    strategy: candidate10Protocol,
    simulation: candidate10SimulationProtocol,
    statistics: candidate10DevelopmentStatisticsPolicy,
    selectionMultiplicity: candidate10Specifications.length,
    priorAttemptIds: candidate10PriorAttemptIds,
  })
  if (Result.isFailure(parameterHash)) return Result.fail(parameterHash.failure)
  const behaviorHash = canonicalHash('behavior', candidate10BehaviorMaterial)
  if (Result.isFailure(behaviorHash)) return Result.fail(behaviorHash.failure)
  const terminalCash = candidate10TerminalLiquidationIsComplete()
  if (Result.isFailure(terminalCash)) return Result.fail(terminalCash.failure)
  const familyStrategyHash = canonicalHash('family-strategy', {
    schemaVersion: 'bayn.candidate-10-family-strategy.v1',
    parameterHash: parameterHash.success,
    behaviorHash: behaviorHash.success,
    preregistrationHash: registration.preregistrationHash,
    preregistrationCommit: registration.preregistrationCommit,
  })
  if (Result.isFailure(familyStrategyHash)) return Result.fail(familyStrategyHash.failure)
  const familyRunId = canonicalHash('development-run', {
    schemaVersion: 'bayn.candidate-10-development-run.v1',
    evaluatedCommit: registration.evaluatedCommit,
    familyStrategyHash: familyStrategyHash.success,
    snapshotId: dataset.snapshotId,
    barsContentHash: dataset.barsContentHash,
    sessionsContentHash: dataset.sessionsContentHash,
    developmentStart: CANDIDATE_10_DEVELOPMENT_START,
    developmentEnd: CANDIDATE_10_DEVELOPMENT_END,
    selectedObservationStart: preflight.selectedObservationStart,
    selectedObservationEnd: preflight.selectedObservationEnd,
  })
  if (Result.isFailure(familyRunId)) return Result.fail(familyRunId.failure)
  const plans = Result.all(
    candidate10Specifications.map((specification) =>
      buildCandidate10Plan(prepared.success.sessions, preflight, specification),
    ),
  )
  if (Result.isFailure(plans)) return Result.fail(plans.failure)
  const firstPlan = plans.success.at(0)
  if (firstPlan === undefined) return fail('evaluation', 'no frozen specification plan')
  const targets = benchmarkTargets(prepared.success.sessions, firstPlan.targets, firstPlan.simulationStartIndex)
  if (Result.isFailure(targets)) return Result.fail(targets.failure)
  const benchmarkRunId = canonicalHash('benchmark-run', {
    schemaVersion: 'bayn.candidate-10-benchmark-run.v1',
    familyRunId: familyRunId.success,
    benchmark: 'SPY-buy-and-hold-and-direct-ten-percent-volatility',
  })
  if (Result.isFailure(benchmarkRunId)) return Result.fail(benchmarkRunId.failure)
  const buyAndHold = runSimulation(
    'buy-and-hold',
    prepared.success.sessions,
    targets.success.buyAndHold,
    firstPlan.simulationStartIndex,
    firstPlan.evaluationStartIndex,
    spyBenchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
  )
  if (Result.isFailure(buyAndHold)) return Result.fail(buyAndHold.failure)
  const directVolatility = runSimulation(
    'direct-volatility',
    prepared.success.sessions,
    targets.success.directVolatility,
    firstPlan.simulationStartIndex,
    firstPlan.evaluationStartIndex,
    spyBenchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
  )
  if (Result.isFailure(directVolatility)) return Result.fail(directVolatility.failure)
  const benchmarks: Candidate10BenchmarkResults = {
    buyAndHold: buyAndHold.success,
    directVolatility: directVolatility.success,
    terminalCash: terminalCash.success,
  }
  const specificationReports = Result.all(
    plans.success.map((plan) =>
      evaluateSpecification(prepared.success, plan, familyStrategyHash.success, familyRunId.success, benchmarks),
    ),
  )
  if (Result.isFailure(specificationReports)) return Result.fail(specificationReports.failure)
  const selected = selectCandidate10Specification(specificationReports.success)
  const alpha = specificationReports.success.at(0)?.uncertainty.adjustedOneSidedAlpha
  if (alpha === undefined) return fail('evaluation', 'specification analysis missing')
  const reportMaterial = {
    schemaVersion: 'bayn.candidate-10-development-report.v1' as const,
    status: selected === undefined ? ('HOLD_REJECT' as const) : ('PASS' as const),
    evaluatedCommit: registration.evaluatedCommit,
    preregistrationHash: registration.preregistrationHash,
    preregistrationCommit: registration.preregistrationCommit,
    identity: {
      parameterHash: parameterHash.success,
      behaviorHash: behaviorHash.success,
      familyStrategyHash: familyStrategyHash.success,
      familyRunId: familyRunId.success,
    },
    dataset: {
      snapshotId: dataset.snapshotId,
      firstSession: prepared.success.sessions.at(0)?.date ?? CANDIDATE_10_DEVELOPMENT_START,
      lastSession: prepared.success.sessions.at(-1)?.date ?? CANDIDATE_10_DEVELOPMENT_END,
      sessionCount: prepared.success.sessions.length,
      barCount: dataset.bars.length,
      sessionsContentHash: dataset.sessionsContentHash,
      barsContentHash: dataset.barsContentHash,
    },
    geometry: preflight,
    selection: {
      specificationCount: candidate10Specifications.length,
      familyMultiplicityDivisor: candidate10Specifications.length,
      priorAttemptCount: candidate10PriorAttemptIds.length,
      adjustedOneSidedAlpha: alpha,
      selectedSpecificationId: selected?.specification.id ?? null,
    },
    specifications: specificationReports.success,
    holdout: {
      start: CANDIDATE_10_HOLDOUT_START,
      end: CANDIDATE_10_HOLDOUT_END,
      inspected: false as const,
      accessCount: 0 as const,
    },
  }
  const reportHash = canonicalHash('development-report', reportMaterial)
  if (Result.isFailure(reportHash)) return Result.fail(reportHash.failure)
  return Result.succeed({
    ...reportMaterial,
    identity: { ...reportMaterial.identity, reportHash: reportHash.success },
  })
}
