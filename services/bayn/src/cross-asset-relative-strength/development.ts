import { pipe, Result } from 'effect'

import { defaultExecutionModel, MICROS } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import {
  analyzeQualification,
  defaultQualificationStatisticsPolicy,
  type QualificationObservation,
  type QualificationSeries,
} from '../qualification-statistics'
import {
  buildVerdict,
  directVolatilityWeights,
  roundWeight,
  simulate,
  type AlignedSession,
  type SimulationResult,
  type SimulationTarget,
} from '../simulation'
import type { DailyPerformancePoint, IsoDate, SimulationProtocol } from '../types'
import { prepareCandidate7Sessions } from './data'
import { buildCandidate7Plan } from './decision'
import {
  CANDIDATE_7_DEVELOPMENT_END,
  CANDIDATE_7_HOLDOUT_START,
  CANDIDATE_7_ORDINAL,
  CANDIDATE_7_SCHEMA_VERSION,
  CANDIDATE_7_STRATEGY_NAME,
  CANDIDATE_7_UNIVERSE,
  candidate7DatasetIdentity,
  candidate7Protocol,
  type Candidate7DevelopmentDataset,
  type Candidate7DevelopmentReport,
  type Candidate7DevelopmentReportMaterial,
  type Candidate7Failure,
} from './model'

const fail = <A>(failure: Candidate7Failure): Result.Result<A, Candidate7Failure> => Result.fail(failure)

export const candidate7SimulationProtocol: SimulationProtocol = {
  universe: CANDIDATE_7_UNIVERSE,
  directVolatilityTarget: candidate7Protocol.risk.targetAnnualizedVolatility,
  initialCapitalMicros: '1000000000000',
  executionModel: defaultExecutionModel,
  thresholds: {
    minimumObservations: 504,
    minimumAnnualizedReturn: 0,
    minimumSharpeImprovement: 0,
    maximumDrawdown: 0.35,
    maximumAnnualTurnover: 12,
    requirePositiveDoubleCostReturn: true,
  },
}

export const candidate7PriorTrialRunIds = [
  'b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7',
  '87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f',
  '7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32',
  '440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861',
  'a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217',
  '300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47',
].toSorted()

export const candidate7BehaviorMaterial = {
  schemaVersion: CANDIDATE_7_SCHEMA_VERSION,
  signal: 'rank-adjusted-close-t-minus-21-over-t-minus-252-minus-one',
  selection: 'top-two-strictly-positive-ties-by-symbol',
  allocation: 'equal-selected-weights-scaled-down-by-63-return-covariance-to-ten-percent-volatility',
  caps: 'fifty-percent-symbol-one-hundred-percent-gross-no-redistribution',
  schedule: 'official-month-end-finalized-close-to-next-session-open',
  terminal: '2022-12-29-finalized-close-to-2022-12-30-open-all-cash',
  missingData: 'fail-closed-no-imputation',
} as const

const canonicalHash = (operation: string, material: unknown): Result.Result<string, Candidate7Failure> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError((cause): Candidate7Failure => ({ _tag: 'Candidate7HashFailure', operation, cause })),
  )

const benchmarkTargets = (
  sessions: readonly AlignedSession[],
  strategyTargets: readonly SimulationTarget[],
  startIndex: number,
): Result.Result<
  { readonly buyAndHold: readonly SimulationTarget[]; readonly directVolatility: readonly SimulationTarget[] },
  Candidate7Failure
> => {
  const terminal = strategyTargets.at(-1)
  if (terminal === undefined || terminal.executionIndex !== sessions.length - 1) {
    return fail({ _tag: 'Candidate7InvalidSignal', reason: 'terminal target is missing', signalIndex: -1 })
  }
  return pipe(
    Result.all({
      equalWeight: pipe(
        roundWeight(1 / CANDIDATE_7_UNIVERSE.length),
        Result.mapError(
          (cause): Candidate7Failure => ({
            _tag: 'Candidate7InvalidSignal',
            reason: `benchmark weight quantization failed: ${cause._tag}`,
            signalIndex: startIndex - 1,
          }),
        ),
      ),
      direct: Result.all(
        strategyTargets.slice(0, -1).map((target) =>
          pipe(
            directVolatilityWeights(sessions, target.signalIndex, candidate7SimulationProtocol),
            Result.mapError(
              (cause): Candidate7Failure => ({
                _tag: 'Candidate7SimulationFailure',
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
    }),
    Result.map(({ direct, equalWeight }) => ({
      buyAndHold: [
        {
          signalIndex: startIndex - 1,
          executionIndex: startIndex,
          weights: Object.fromEntries(CANDIDATE_7_UNIVERSE.map((symbol) => [symbol, equalWeight])),
        },
        terminal,
      ],
      directVolatility: [...direct, terminal],
    })),
  )
}

const runSimulation = (
  name: string,
  sessions: readonly AlignedSession[],
  targets: readonly SimulationTarget[],
  startIndex: number,
  costMultiplierMicros: bigint,
  runId: string,
): Result.Result<SimulationResult, Candidate7Failure> =>
  pipe(
    simulate(sessions, targets, startIndex, candidate7SimulationProtocol, costMultiplierMicros, runId, false),
    Result.mapError((cause): Candidate7Failure => ({ _tag: 'Candidate7SimulationFailure', simulation: name, cause })),
  )

const performanceByDate = (
  values: readonly DailyPerformancePoint[],
  name: string,
): Result.Result<ReadonlyMap<IsoDate, DailyPerformancePoint>, Candidate7Failure> => {
  const map = new Map<IsoDate, DailyPerformancePoint>()
  for (const value of values) {
    if (map.has(value.sessionDate)) {
      return fail({
        _tag: 'Candidate7SimulationFailure',
        simulation: name,
        cause: `duplicate daily performance ${value.sessionDate}`,
      })
    }
    map.set(value.sessionDate, value)
  }
  return Result.succeed(map)
}

const qualificationSeries = (
  runId: string,
  strategy: SimulationResult,
  buyAndHold: SimulationResult,
  directVolatility: SimulationResult,
  rebalanceExecutionDates: readonly IsoDate[],
): Result.Result<QualificationSeries, Candidate7Failure> =>
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
          return fail({
            _tag: 'Candidate7SimulationFailure',
            simulation: 'qualification-series',
            cause: `benchmark alignment missing ${point.sessionDate}`,
          })
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
        return fail({
          _tag: 'Candidate7SimulationFailure',
          simulation: 'qualification-series',
          cause: 'daily performance lengths differ',
        })
      }
      return Result.succeed({
        schemaVersion: 'bayn.qualification-series.v1',
        runId,
        observations,
        rebalanceExecutionDates,
      })
    }),
  )

export const evaluateCandidate7Development = (
  dataset: Candidate7DevelopmentDataset,
  evaluatedCommit: string,
): Result.Result<Candidate7DevelopmentReport, Candidate7Failure> =>
  pipe(
    Result.all({
      sessions: prepareCandidate7Sessions(dataset),
      parameterHash: canonicalHash('parameters', {
        strategy: candidate7Protocol,
        simulation: candidate7SimulationProtocol,
        statistics: defaultQualificationStatisticsPolicy,
      }),
      behaviorHash: canonicalHash('behavior', candidate7BehaviorMaterial),
    }),
    Result.flatMap(({ behaviorHash, parameterHash, sessions }) =>
      pipe(
        Result.all({
          plan: buildCandidate7Plan(sessions),
          strategyHash: canonicalHash('strategy', {
            schemaVersion: CANDIDATE_7_SCHEMA_VERSION,
            parameterHash,
            behaviorHash,
          }),
        }),
        Result.flatMap(({ plan, strategyHash }) =>
          pipe(
            canonicalHash('run', {
              schemaVersion: 'bayn.candidate-7-development-run.v1',
              evaluatedCommit,
              strategyHash,
              snapshotId: candidate7DatasetIdentity.snapshotId,
              boundedBarsContentHash: candidate7DatasetIdentity.boundedBarsContentHash,
              boundedSessionsContentHash: candidate7DatasetIdentity.boundedSessionsContentHash,
              developmentEnd: CANDIDATE_7_DEVELOPMENT_END,
            }),
            Result.flatMap((runId) =>
              pipe(
                benchmarkTargets(sessions, plan.targets, plan.startIndex),
                Result.flatMap((benchmarks) =>
                  pipe(
                    Result.all({
                      strategy: runSimulation('strategy', sessions, plan.targets, plan.startIndex, MICROS, runId),
                      buyAndHold: runSimulation(
                        'buy-and-hold',
                        sessions,
                        benchmarks.buyAndHold,
                        plan.startIndex,
                        MICROS,
                        runId,
                      ),
                      directVolatility: runSimulation(
                        'direct-volatility',
                        sessions,
                        benchmarks.directVolatility,
                        plan.startIndex,
                        MICROS,
                        runId,
                      ),
                      doubleCostStrategy: runSimulation(
                        'double-cost-strategy',
                        sessions,
                        plan.targets,
                        plan.startIndex,
                        BigInt(candidate7SimulationProtocol.executionModel.doubleCostMultiplier) * MICROS,
                        runId,
                      ),
                    }),
                    Result.flatMap((simulations) => {
                      const economicVerdict = buildVerdict(
                        simulations.strategy.metrics,
                        simulations.buyAndHold.metrics,
                        simulations.directVolatility.metrics,
                        simulations.doubleCostStrategy.metrics,
                        candidate7SimulationProtocol,
                      )
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
                              defaultQualificationStatisticsPolicy,
                              candidate7PriorTrialRunIds,
                            ),
                            Result.mapError(
                              (cause): Candidate7Failure => ({ _tag: 'Candidate7QualificationFailure', cause }),
                            ),
                            Result.flatMap((analysis) => {
                              const benchmark =
                                simulations.directVolatility.metrics.sharpe > simulations.buyAndHold.metrics.sharpe
                                  ? {
                                      name: 'direct-volatility-timing' as const,
                                      sharpe: simulations.directVolatility.metrics.sharpe,
                                    }
                                  : {
                                      name: 'buy-and-hold' as const,
                                      sharpe: simulations.buyAndHold.metrics.sharpe,
                                    }
                              const passed = economicVerdict.status === 'PASS' && analysis.status === 'PASS'
                              const material: Candidate7DevelopmentReportMaterial = {
                                schemaVersion: 'bayn.candidate-7-development-report.v1',
                                candidateOrdinal: CANDIDATE_7_ORDINAL,
                                strategyName: CANDIDATE_7_STRATEGY_NAME,
                                evaluatedCommit,
                                status: passed ? 'PASS' : 'HOLD_REJECT',
                                identity: { parameterHash, behaviorHash, strategyHash, runId },
                                dataset: {
                                  snapshotId: dataset.snapshotId,
                                  publicationAsOf: dataset.publicationAsOf,
                                  firstSession: sessions.at(0)?.date ?? CANDIDATE_7_DEVELOPMENT_END,
                                  lastSession: sessions.at(-1)?.date ?? CANDIDATE_7_DEVELOPMENT_END,
                                  sessionCount: sessions.length,
                                  barCount: dataset.bars.length,
                                  boundedBarsContentHash: dataset.boundedBarsContentHash,
                                  boundedSessionsContentHash: dataset.boundedSessionsContentHash,
                                },
                                metrics: {
                                  strategy: simulations.strategy.metrics,
                                  buyAndHold: simulations.buyAndHold.metrics,
                                  directVolatility: simulations.directVolatility.metrics,
                                  doubleCostStrategy: simulations.doubleCostStrategy.metrics,
                                },
                                selectedBenchmark: {
                                  name: benchmark.name,
                                  sharpe: benchmark.sharpe,
                                  strategySharpeDifference: simulations.strategy.metrics.sharpe - benchmark.sharpe,
                                },
                                economicGates: economicVerdict.gates,
                                uncertainty: {
                                  status: analysis.status,
                                  reasonCodes: analysis.reasonCodes,
                                  adjustedOneSidedAlpha: analysis.bootstrap.adjustedOneSidedAlpha,
                                  annualizedExcessReturnLowerBound: analysis.bootstrap.annualizedExcessReturnLowerBound,
                                  sharpeDifferenceLowerBound: analysis.bootstrap.sharpeDifferenceLowerBound,
                                  completeRebalanceBlocks: analysis.completeBlocks.length,
                                  requiredCompleteRebalanceBlocks: analysis.power.requiredCompleteRebalanceBlocks,
                                  availableCompleteSessions: analysis.power.availableCompleteSessions,
                                  requiredSessions: analysis.power.requiredSessions,
                                  walkForwardFolds: analysis.walkForward.folds.length,
                                  requiredWalkForwardFolds: analysis.walkForward.requiredFolds,
                                  positiveWalkForwardFolds: analysis.walkForward.positiveFolds,
                                  analysisHash: analysis.analysisHash,
                                },
                                holdout: { start: CANDIDATE_7_HOLDOUT_START, inspected: false },
                                recommendation: passed
                                  ? 'RETAIN_RESEARCH_ONLY_AWAIT_APPROVAL'
                                  : 'REMOVE_IMPLEMENTATION_CLOSE_WITHOUT_MERGE',
                              }
                              return pipe(
                                canonicalHash('report', material),
                                Result.map((reportHash) => ({ ...material, reportHash })),
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
