import { pipe, Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type {
  QualificationAnalysis,
  QualificationSeries,
  QualificationStatisticsFailure,
  QualificationStatisticsPolicy,
} from '../qualification-statistics'
import { compoundedReturn, maximumDrawdown, roundStatistic } from './numerical-methods'

const fail = <A = never>(failure: QualificationStatisticsFailure): Result.Result<A, QualificationStatisticsFailure> =>
  Result.fail(failure)

const hashFold = (value: unknown): Result.Result<string, QualificationStatisticsFailure> =>
  pipe(
    canonicalHashV1Result(value),
    Result.mapError(
      (cause): QualificationStatisticsFailure => ({
        _tag: 'QualificationStatisticsCanonicalizationFailed',
        operation: 'walk-forward-fold',
        cause,
      }),
    ),
  )

export const calculateWalkForward = (
  series: QualificationSeries,
  policy: QualificationStatisticsPolicy,
): Result.Result<QualificationAnalysis['walkForward'], QualificationStatisticsFailure> => {
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
            return fail({
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
                hashFold(material),
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
