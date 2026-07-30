import { pipe, Result } from 'effect'

import { selectQualificationBenchmark, type QualificationSelectedBenchmark } from './bootstrap'
import { statisticsFailure, type QualificationStatisticsFailure } from './failure'
import { hashQualificationEvidence } from './hashing'
import type { QualificationSeries, QualificationStatisticsPolicy, WalkForwardAnalysis } from './model'
import { compoundedReturn, maximumDrawdown, roundStatistic } from './numerical-methods'

export interface QualificationSelectedBenchmarkWalkForwardFold {
  readonly schemaVersion: 'bayn.selected-benchmark-walk-forward-fold.v1'
  readonly ordinal: number
  readonly trainingStart: string
  readonly trainingEnd: string
  readonly testStart: string
  readonly testEnd: string
  readonly testObservationCount: number
  readonly strategyReturn: number
  readonly selectedBenchmark: QualificationSelectedBenchmark
  readonly selectedBenchmarkReturn: number
  readonly returnDifference: number
  readonly maximumDrawdown: number
  readonly positiveDifference: boolean
  readonly drawdownWithinLimit: boolean
  readonly contentHash: string
}

export interface QualificationSelectedBenchmarkWalkForwardComparison {
  readonly schemaVersion: 'bayn.selected-benchmark-walk-forward-comparison.v1'
  readonly selectedBenchmark: QualificationSelectedBenchmark
  readonly folds: readonly QualificationSelectedBenchmarkWalkForwardFold[]
  readonly requiredFolds: number
  readonly positiveFolds: number
  readonly positiveFoldFraction: number
  readonly requiredPositiveFoldFraction: number
  readonly allDrawdownsWithinLimit: boolean
  readonly maximumFoldDrawdown: number
  readonly sufficient: boolean
}

export const calculateWalkForward = (
  series: QualificationSeries,
  policy: QualificationStatisticsPolicy,
): Result.Result<WalkForwardAnalysis, QualificationStatisticsFailure> => {
  const { minimumTrainingSessions, testSessions } = policy.walkForward
  const foldCount = Math.max(0, Math.floor((series.observations.length - minimumTrainingSessions) / testSessions))
  return pipe(
    Result.all(
      Array.from({ length: foldCount }, (_, ordinal) => minimumTrainingSessions + ordinal * testSessions).map(
        (testStart, ordinal) => {
          const test = series.observations.slice(testStart, testStart + testSessions)
          const trainingStart = series.observations.at(0)
          const trainingEnd = series.observations.at(testStart - 1)
          const firstTestObservation = test.at(0)
          const lastTestObservation = test.at(-1)
          if (
            trainingStart === undefined ||
            trainingEnd === undefined ||
            firstTestObservation === undefined ||
            lastTestObservation === undefined
          ) {
            return statisticsFailure({
              _tag: 'QualificationWalkForwardBoundaryMissing',
              testStart,
              testSessions,
              observationCount: series.observations.length,
            })
          }
          const strategyReturns = test.map((observation) => observation.strategyReturn)
          const cashReturns = test.map((observation) => observation.cashReturn)
          const strategyReturn = compoundedReturn(strategyReturns)
          const cashReturn = compoundedReturn(cashReturns)
          const excessReturn = strategyReturn - cashReturn
          return pipe(
            Result.all({
              strategyReturn: roundStatistic(strategyReturn),
              cashReturn: roundStatistic(cashReturn),
              excessReturn: roundStatistic(excessReturn),
              maximumDrawdown: maximumDrawdown(strategyReturns),
            }),
            Result.flatMap((statistics) => {
              const material = {
                schemaVersion: 'bayn.walk-forward-fold.v1' as const,
                ordinal,
                trainingStart: trainingStart.sessionDate,
                trainingEnd: trainingEnd.sessionDate,
                testStart: firstTestObservation.sessionDate,
                testEnd: lastTestObservation.sessionDate,
                testObservationCount: test.length,
                strategyReturn: statistics.strategyReturn,
                cashReturn: statistics.cashReturn,
                excessReturn: statistics.excessReturn,
                maximumDrawdown: statistics.maximumDrawdown,
                positiveExcess: excessReturn > 0,
                drawdownWithinLimit: statistics.maximumDrawdown <= policy.walkForward.maximumFoldDrawdown,
              }
              return pipe(
                hashQualificationEvidence('walk-forward-fold', material),
                Result.map((contentHash) => ({ ...material, contentHash })),
              )
            }),
          )
        },
      ),
    ),
    Result.flatMap((folds) => {
      const positiveFolds = folds.filter((fold) => fold.positiveExcess).length
      const positiveFoldFraction = folds.length === 0 ? 0 : positiveFolds / folds.length
      return pipe(
        roundStatistic(positiveFoldFraction),
        Result.map((roundedPositiveFoldFraction) => ({
          schemaVersion: 'bayn.walk-forward.v1' as const,
          method: policy.walkForward.method,
          folds,
          requiredFolds: policy.walkForward.minimumFolds,
          positiveFolds,
          positiveFoldFraction: roundedPositiveFoldFraction,
          requiredPositiveFoldFraction: policy.walkForward.minimumPositiveFoldFraction,
          allDrawdownsWithinLimit: folds.every((fold) => fold.drawdownWithinLimit),
          maximumFoldDrawdown: folds.reduce((maximum, fold) => Math.max(maximum, fold.maximumDrawdown), 0),
          sufficient: folds.length >= policy.walkForward.minimumFolds,
        })),
      )
    }),
  )
}

export const calculateSelectedBenchmarkWalkForwardComparison = (
  series: QualificationSeries,
  policy: QualificationStatisticsPolicy,
): Result.Result<QualificationSelectedBenchmarkWalkForwardComparison, QualificationStatisticsFailure> => {
  const benchmark = selectQualificationBenchmark(series.observations, policy.annualizationSessions)
  const { minimumTrainingSessions, testSessions } = policy.walkForward
  const foldCount = Math.max(0, Math.floor((series.observations.length - minimumTrainingSessions) / testSessions))
  return pipe(
    Result.all(
      Array.from({ length: foldCount }, (_, ordinal) => minimumTrainingSessions + ordinal * testSessions).map(
        (testStart, ordinal) => {
          const test = series.observations.slice(testStart, testStart + testSessions)
          const trainingStart = series.observations.at(0)
          const trainingEnd = series.observations.at(testStart - 1)
          const firstTestObservation = test.at(0)
          const lastTestObservation = test.at(-1)
          if (
            trainingStart === undefined ||
            trainingEnd === undefined ||
            firstTestObservation === undefined ||
            lastTestObservation === undefined
          ) {
            return statisticsFailure({
              _tag: 'QualificationWalkForwardBoundaryMissing',
              testStart,
              testSessions,
              observationCount: series.observations.length,
            })
          }
          const strategyReturns = test.map((observation) => observation.strategyReturn)
          const benchmarkReturns = test.map((observation) =>
            benchmark.name === 'buy-and-hold' ? observation.buyAndHoldReturn : observation.directVolatilityReturn,
          )
          const strategyReturn = compoundedReturn(strategyReturns)
          const selectedBenchmarkReturn = compoundedReturn(benchmarkReturns)
          const returnDifference = strategyReturn - selectedBenchmarkReturn
          return pipe(
            Result.all({
              strategyReturn: roundStatistic(strategyReturn),
              selectedBenchmarkReturn: roundStatistic(selectedBenchmarkReturn),
              returnDifference: roundStatistic(returnDifference),
              maximumDrawdown: maximumDrawdown(strategyReturns),
            }),
            Result.flatMap((statistics) => {
              const material = {
                schemaVersion: 'bayn.selected-benchmark-walk-forward-fold.v1' as const,
                ordinal,
                trainingStart: trainingStart.sessionDate,
                trainingEnd: trainingEnd.sessionDate,
                testStart: firstTestObservation.sessionDate,
                testEnd: lastTestObservation.sessionDate,
                testObservationCount: test.length,
                strategyReturn: statistics.strategyReturn,
                selectedBenchmark: benchmark.name,
                selectedBenchmarkReturn: statistics.selectedBenchmarkReturn,
                returnDifference: statistics.returnDifference,
                maximumDrawdown: statistics.maximumDrawdown,
                positiveDifference: returnDifference > 0,
                drawdownWithinLimit: statistics.maximumDrawdown <= policy.walkForward.maximumFoldDrawdown,
              }
              return pipe(
                hashQualificationEvidence('selected-benchmark-walk-forward-fold', material),
                Result.map((contentHash) => ({ ...material, contentHash })),
              )
            }),
          )
        },
      ),
    ),
    Result.flatMap((folds) => {
      const positiveFolds = folds.filter((fold) => fold.positiveDifference).length
      const positiveFoldFraction = folds.length === 0 ? 0 : positiveFolds / folds.length
      return pipe(
        roundStatistic(positiveFoldFraction),
        Result.map((roundedPositiveFoldFraction) => ({
          schemaVersion: 'bayn.selected-benchmark-walk-forward-comparison.v1' as const,
          selectedBenchmark: benchmark.name,
          folds,
          requiredFolds: policy.walkForward.minimumFolds,
          positiveFolds,
          positiveFoldFraction: roundedPositiveFoldFraction,
          requiredPositiveFoldFraction: policy.walkForward.minimumPositiveFoldFraction,
          allDrawdownsWithinLimit: folds.every((fold) => fold.drawdownWithinLimit),
          maximumFoldDrawdown: folds.reduce((maximum, fold) => Math.max(maximum, fold.maximumDrawdown), 0),
          sufficient: folds.length >= policy.walkForward.minimumFolds,
        })),
      )
    }),
  )
}
