import { pipe, Result } from 'effect'

import type { CandidateDevelopmentPreflightPass } from '../candidate-development'
import { candidateDevelopmentStatisticsPolicy } from '../candidate-development'
import { MICROS } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import {
  analyzeQualification,
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
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyPerformancePoint,
  type IsoDate,
} from '../types'
import {
  CANDIDATE_9_DEVELOPMENT_END,
  CANDIDATE_9_DEVELOPMENT_START,
  CANDIDATE_9_HOLDOUT_END,
  CANDIDATE_9_HOLDOUT_START,
  CANDIDATE_9_SNAPSHOT_ID,
  CANDIDATE_9_SYMBOL,
  candidate9BehaviorMaterial,
  candidate9DevelopmentSessions,
  candidate9PriorAttemptIds,
  candidate9Protocol,
  candidate9SimulationProtocol,
  type Candidate9Dataset,
  type Candidate9DevelopmentReport,
  type Candidate9Failure,
  type Candidate9PreparedData,
  type Candidate9Registration,
} from './model'
import { buildCandidate9Plan, candidate9TerminalLiquidationIsComplete } from './strategy'

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate9Failure> =>
  Result.fail({ _tag: 'Candidate9InvalidInput', operation, reason })

const canonicalHash = (operation: string, material: unknown): Result.Result<string, Candidate9Failure> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError((cause): Candidate9Failure => ({ _tag: 'Candidate9HashFailure', operation, cause })),
  )

const exactDates = (left: readonly IsoDate[], right: readonly IsoDate[]): boolean =>
  left.length === right.length && left.every((date, index) => date === right[index])

export const candidate9DatasetHashes = (
  sessions: readonly IsoDate[],
  bars: Candidate9Dataset['bars'],
): Result.Result<{ readonly sessionsContentHash: string; readonly barsContentHash: string }, Candidate9Failure> =>
  Result.all({
    sessionsContentHash: canonicalHash('development-sessions', {
      schemaVersion: 'bayn.candidate-9-development-sessions.v1',
      snapshotId: CANDIDATE_9_SNAPSHOT_ID,
      sessions,
    }),
    barsContentHash: canonicalHash('development-bars', {
      schemaVersion: 'bayn.candidate-9-development-bars.v1',
      snapshotId: CANDIDATE_9_SNAPSHOT_ID,
      symbol: CANDIDATE_9_SYMBOL,
      bars,
    }),
  })

export const prepareCandidate9DevelopmentData = (
  dataset: Candidate9Dataset,
): Result.Result<Candidate9PreparedData, Candidate9Failure> => {
  const expectedSessions = candidate9DevelopmentSessions()
  if (dataset.snapshotId !== CANDIDATE_9_SNAPSHOT_ID) {
    return fail('dataset', `snapshot ${dataset.snapshotId} differs from ${CANDIDATE_9_SNAPSHOT_ID}`)
  }
  if (!exactDates(dataset.sessions, expectedSessions)) return fail('dataset', 'official development sessions differ')
  if (dataset.bars.length !== expectedSessions.length) {
    return fail('dataset', `expected ${expectedSessions.length} SPY bars, observed ${dataset.bars.length}`)
  }
  return pipe(
    candidate9DatasetHashes(dataset.sessions, dataset.bars),
    Result.flatMap((hashes) => {
      if (hashes.sessionsContentHash !== dataset.sessionsContentHash) {
        return fail('dataset', 'sessions content hash differs')
      }
      if (hashes.barsContentHash !== dataset.barsContentHash) return fail('dataset', 'bars content hash differs')
      const sessions: AlignedSession[] = []
      for (let index = 0; index < expectedSessions.length; index += 1) {
        const date = expectedSessions[index]
        const bar = dataset.bars[index]
        if (date === undefined || bar === undefined || bar.sessionDate !== date) {
          return fail('dataset', `bar/session alignment differs at index ${index}`)
        }
        if (
          ![bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) ||
          !Number.isFinite(bar.volume) ||
          bar.volume < 0 ||
          bar.low > Math.min(bar.open, bar.close) ||
          bar.high < Math.max(bar.open, bar.close)
        ) {
          return fail('dataset', `invalid OHLCV on ${date}`)
        }
        sessions.push({
          date,
          bars: {
            [CANDIDATE_9_SYMBOL]: {
              symbol: CANDIDATE_9_SYMBOL,
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
            },
          },
        })
      }
      return Result.succeed({ dataset, sessions })
    }),
  )
}

const benchmarkTargets = (
  sessions: readonly AlignedSession[],
  strategyTargets: readonly SimulationTarget[],
  startIndex: number,
): Result.Result<
  { readonly buyAndHold: readonly SimulationTarget[]; readonly directVolatility: readonly SimulationTarget[] },
  Candidate9Failure
> => {
  const terminal = strategyTargets.at(-1)
  if (terminal === undefined || terminal.executionIndex !== sessions.length - 1) {
    return fail('benchmarks', 'terminal target is missing')
  }
  return pipe(
    Result.all(
      strategyTargets.slice(0, -1).map((target) =>
        pipe(
          directVolatilityWeights(sessions, target.signalIndex, candidate9SimulationProtocol),
          Result.mapError(
            (cause): Candidate9Failure => ({
              _tag: 'Candidate9SimulationFailure',
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
          weights: { [CANDIDATE_9_SYMBOL]: 1 },
        },
        terminal,
      ],
      directVolatility: [...directVolatility, terminal],
    })),
  )
}

const runSimulation = (
  simulation: string,
  sessions: readonly AlignedSession[],
  targets: readonly SimulationTarget[],
  startIndex: number,
  costMultiplierMicros: bigint,
  runId: string,
): Result.Result<SimulationResult, Candidate9Failure> =>
  pipe(
    simulate(sessions, targets, startIndex, candidate9SimulationProtocol, costMultiplierMicros, runId, false),
    Result.mapError((cause): Candidate9Failure => ({ _tag: 'Candidate9SimulationFailure', simulation, cause })),
  )

const performanceByDate = (
  points: readonly DailyPerformancePoint[],
  name: string,
): Result.Result<ReadonlyMap<IsoDate, DailyPerformancePoint>, Candidate9Failure> => {
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
): Result.Result<QualificationSeries, Candidate9Failure> =>
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

export const evaluateCandidate9Development = (
  registration: Candidate9Registration,
  dataset: Candidate9Dataset,
  preflight: CandidateDevelopmentPreflightPass,
): Result.Result<Candidate9DevelopmentReport, Candidate9Failure> =>
  pipe(
    Result.all({
      prepared: prepareCandidate9DevelopmentData(dataset),
      parameterHash: canonicalHash('parameters', {
        strategy: candidate9Protocol,
        simulation: candidate9SimulationProtocol,
        statistics: candidateDevelopmentStatisticsPolicy,
        priorAttemptIds: candidate9PriorAttemptIds,
      }),
      behaviorHash: canonicalHash('behavior', candidate9BehaviorMaterial),
    }),
    Result.flatMap(({ behaviorHash, parameterHash, prepared }) =>
      pipe(
        Result.all({
          plan: buildCandidate9Plan(prepared.sessions, preflight),
          terminalLiquidationComplete: candidate9TerminalLiquidationIsComplete(),
          strategyHash: canonicalHash('strategy', {
            schemaVersion: 'bayn.candidate-9-strategy.v1',
            parameterHash,
            behaviorHash,
            preregistrationHash: registration.preregistrationHash,
          }),
        }),
        Result.flatMap(({ plan, strategyHash, terminalLiquidationComplete }) =>
          pipe(
            canonicalHash('development-run', {
              schemaVersion: 'bayn.candidate-9-development-run.v1',
              evaluatedCommit: registration.evaluatedCommit,
              strategyHash,
              snapshotId: dataset.snapshotId,
              barsContentHash: dataset.barsContentHash,
              sessionsContentHash: dataset.sessionsContentHash,
              developmentStart: CANDIDATE_9_DEVELOPMENT_START,
              developmentEnd: CANDIDATE_9_DEVELOPMENT_END,
              selectedObservationStart: preflight.selectedObservationStart,
              selectedObservationEnd: preflight.selectedObservationEnd,
            }),
            Result.flatMap((runId) =>
              pipe(
                benchmarkTargets(prepared.sessions, plan.targets, plan.startIndex),
                Result.flatMap((benchmarks) =>
                  pipe(
                    Result.all({
                      strategy: runSimulation(
                        'strategy',
                        prepared.sessions,
                        plan.targets,
                        plan.startIndex,
                        MICROS,
                        runId,
                      ),
                      buyAndHold: runSimulation(
                        'buy-and-hold',
                        prepared.sessions,
                        benchmarks.buyAndHold,
                        plan.startIndex,
                        MICROS,
                        runId,
                      ),
                      directVolatility: runSimulation(
                        'direct-volatility',
                        prepared.sessions,
                        benchmarks.directVolatility,
                        plan.startIndex,
                        MICROS,
                        runId,
                      ),
                      doubleCostStrategy: runSimulation(
                        'double-cost-strategy',
                        prepared.sessions,
                        plan.targets,
                        plan.startIndex,
                        BigInt(candidate9SimulationProtocol.executionModel.doubleCostMultiplier) * MICROS,
                        runId,
                      ),
                    }),
                    Result.flatMap((simulations) => {
                      const economicVerdict = buildVerdict(
                        simulations.strategy.metrics,
                        simulations.buyAndHold.metrics,
                        simulations.directVolatility.metrics,
                        simulations.doubleCostStrategy.metrics,
                        candidate9SimulationProtocol,
                      )
                      const terminalCashEvidence = {
                        strategy: terminalLiquidationComplete,
                        buyAndHold: terminalLiquidationComplete,
                        directVolatility: terminalLiquidationComplete,
                        doubleCostStrategy: terminalLiquidationComplete,
                      }
                      return pipe(
                        qualificationSeries(
                          runId,
                          simulations.strategy,
                          simulations.buyAndHold,
                          simulations.directVolatility,
                          plan.rebalanceExecutionDates,
                        ),
                        Result.flatMap((series) =>
                          pipe(
                            analyzeQualification(
                              series,
                              candidateDevelopmentStatisticsPolicy,
                              candidate9PriorAttemptIds,
                            ),
                            Result.mapError(
                              (cause): Candidate9Failure => ({ _tag: 'Candidate9QualificationFailure', cause }),
                            ),
                            Result.flatMap((analysis) => {
                              const directIsStronger =
                                simulations.directVolatility.metrics.sharpe > simulations.buyAndHold.metrics.sharpe
                              const selectedBenchmark = directIsStronger
                                ? ('direct-volatility-timing' as const)
                                : ('buy-and-hold' as const)
                              const benchmarkMetrics = directIsStronger
                                ? simulations.directVolatility.metrics
                                : simulations.buyAndHold.metrics
                              const status =
                                economicVerdict.status === 'PASS' &&
                                analysis.status === 'PASS' &&
                                Object.values(terminalCashEvidence).every(Boolean)
                                  ? ('PASS' as const)
                                  : ('HOLD_REJECT' as const)
                              const reportMaterial = {
                                schemaVersion: 'bayn.candidate-9-development-report.v1' as const,
                                status,
                                evaluatedCommit: registration.evaluatedCommit,
                                preregistrationHash: registration.preregistrationHash,
                                identity: { parameterHash, behaviorHash, strategyHash, runId },
                                dataset: {
                                  snapshotId: dataset.snapshotId,
                                  firstSession: prepared.sessions.at(0)?.date ?? CANDIDATE_9_DEVELOPMENT_START,
                                  lastSession: prepared.sessions.at(-1)?.date ?? CANDIDATE_9_DEVELOPMENT_END,
                                  sessionCount: prepared.sessions.length,
                                  barCount: dataset.bars.length,
                                  sessionsContentHash: dataset.sessionsContentHash,
                                  barsContentHash: dataset.barsContentHash,
                                },
                                geometry: preflight,
                                metrics: {
                                  strategy: simulations.strategy.metrics,
                                  buyAndHold: simulations.buyAndHold.metrics,
                                  directVolatility: simulations.directVolatility.metrics,
                                  doubleCostStrategy: simulations.doubleCostStrategy.metrics,
                                  benchmarkRelativeAnnualizedReturn:
                                    simulations.strategy.metrics.annualizedReturn - benchmarkMetrics.annualizedReturn,
                                  benchmarkSharpeDifference:
                                    simulations.strategy.metrics.sharpe - benchmarkMetrics.sharpe,
                                },
                                selectedBenchmark,
                                economicVerdict,
                                terminalCash: terminalCashEvidence,
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
                                holdout: {
                                  start: CANDIDATE_9_HOLDOUT_START,
                                  end: CANDIDATE_9_HOLDOUT_END,
                                  inspected: false as const,
                                  accessCount: 0 as const,
                                },
                              }
                              return pipe(
                                canonicalHash('development-report', reportMaterial),
                                Result.map(
                                  (reportHash): Candidate9DevelopmentReport => ({
                                    ...reportMaterial,
                                    identity: { ...reportMaterial.identity, reportHash },
                                  }),
                                ),
                              )
                            }),
                          ),
                        ),
                      )
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )
