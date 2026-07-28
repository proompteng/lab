import { pipe, Result } from 'effect'

import type { EvaluationResult, IsoDate } from '../types'
import { decodeQualificationSeries, qualificationStatisticsSchemaFailure } from './decoding'
import { statisticsFailure, type QualificationStatisticsFailure } from './failure'
import { hashQualificationEvidence } from './hashing'
import type { CompleteBlockEvidence, QualificationObservation, QualificationSeries } from './model'

export interface CompleteBlockWork {
  readonly evidence: CompleteBlockEvidence
  readonly observations: readonly QualificationObservation[]
}

const daysBetween = (left: IsoDate, right: IsoDate): Result.Result<number, QualificationStatisticsFailure> => {
  const milliseconds = Date.parse(`${right}T00:00:00.000Z`) - Date.parse(`${left}T00:00:00.000Z`)
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? Result.succeed(Math.round(milliseconds / 86_400_000))
    : statisticsFailure({ _tag: 'QualificationDateOrderInvalid', previous: left, current: right })
}

const dailyCashReturn = (annualYieldBps: number, elapsedDays: number): number =>
  (annualYieldBps / 10_000) * (elapsedDays / 365)

const duplicateDate = (points: readonly { readonly sessionDate: IsoDate }[]): IsoDate | null =>
  points.find((point, index) => points.findIndex((candidate) => candidate.sessionDate === point.sessionDate) !== index)
    ?.sessionDate ?? null

const alignmentFailure = (
  evaluation: EvaluationResult,
  reason: Extract<QualificationStatisticsFailure, { readonly _tag: 'QualificationSeriesAlignmentFailed' }>['reason'],
  sessionDate: IsoDate | null,
): Result.Result<never, QualificationStatisticsFailure> =>
  statisticsFailure({
    _tag: 'QualificationSeriesAlignmentFailed',
    reason,
    sessionDate,
    strategyCount: evaluation.simulation.dailyMarks.length,
    buyAndHoldCount: evaluation.benchmarkSeries.buyAndHold.length,
    directVolatilityCount: evaluation.benchmarkSeries.directVolTiming.length,
  })

export const prepareQualificationSeries = (
  evaluation: EvaluationResult,
): Result.Result<QualificationSeries, QualificationStatisticsFailure> => {
  const duplicateBuyAndHoldDate = duplicateDate(evaluation.benchmarkSeries.buyAndHold)
  if (duplicateBuyAndHoldDate !== null) {
    return alignmentFailure(evaluation, 'duplicate-buy-and-hold-date', duplicateBuyAndHoldDate)
  }
  const duplicateDirectVolatilityDate = duplicateDate(evaluation.benchmarkSeries.directVolTiming)
  if (duplicateDirectVolatilityDate !== null) {
    return alignmentFailure(evaluation, 'duplicate-direct-volatility-date', duplicateDirectVolatilityDate)
  }
  const buyAndHold = new Map(
    evaluation.benchmarkSeries.buyAndHold.map((point) => [point.sessionDate, point.netReturn] as const),
  )
  const directVolatility = new Map(
    evaluation.benchmarkSeries.directVolTiming.map((point) => [point.sessionDate, point.netReturn] as const),
  )
  const observations = Result.all(
    evaluation.simulation.dailyMarks.map((point, index) => {
      const buyAndHoldReturn = buyAndHold.get(point.sessionDate)
      if (buyAndHoldReturn === undefined) {
        return alignmentFailure(evaluation, 'missing-buy-and-hold-observation', point.sessionDate)
      }
      const directVolatilityReturn = directVolatility.get(point.sessionDate)
      if (directVolatilityReturn === undefined) {
        return alignmentFailure(evaluation, 'missing-direct-volatility-observation', point.sessionDate)
      }
      const previousDate = evaluation.simulation.dailyMarks.at(index - 1)?.sessionDate
      const elapsedDays =
        index === 0 || previousDate === undefined ? Result.succeed(1) : daysBetween(previousDate, point.sessionDate)
      return pipe(
        elapsedDays,
        Result.map((days) => ({
          sessionDate: point.sessionDate,
          strategyReturn: point.netReturn,
          cashReturn: dailyCashReturn(evaluation.simulation.executionModel.cash.annualYieldBps, days),
          buyAndHoldReturn,
          directVolatilityReturn,
        })),
      )
    }),
  )
  if (Result.isFailure(observations)) return statisticsFailure(observations.failure)
  if (buyAndHold.size !== observations.success.length || directVolatility.size !== observations.success.length) {
    return alignmentFailure(evaluation, 'observation-count-mismatch', null)
  }
  return pipe(
    decodeQualificationSeries({
      schemaVersion: 'bayn.qualification-series.v1',
      runId: evaluation.runId,
      observations: observations.success,
      rebalanceExecutionDates: evaluation.signalDecisions.map((decision) => decision.executionDate),
    }),
    Result.mapError(qualificationStatisticsSchemaFailure('series')),
  )
}

export const buildCompleteBlocks = (
  series: QualificationSeries,
): Result.Result<readonly CompleteBlockWork[], QualificationStatisticsFailure> =>
  Array.from({ length: Math.max(0, series.rebalanceExecutionDates.length - 1) }, (_, index) => index).reduce<
    Result.Result<readonly CompleteBlockWork[], QualificationStatisticsFailure>
  >(
    (accumulated, index) =>
      pipe(
        accumulated,
        Result.flatMap((blocks) => {
          const startSession = series.rebalanceExecutionDates.at(index)
          const nextRebalanceSession = series.rebalanceExecutionDates.at(index + 1)
          if (startSession === undefined || nextRebalanceSession === undefined) return Result.succeed(blocks)
          const observations = series.observations.filter(
            (observation) => observation.sessionDate >= startSession && observation.sessionDate < nextRebalanceSession,
          )
          if (observations.length === 0 || observations.at(0)?.sessionDate !== startSession) {
            return Result.succeed(blocks)
          }
          const lastObservation = observations.at(-1)
          if (lastObservation === undefined) return Result.succeed(blocks)
          const material = {
            schemaVersion: 'bayn.qualification-block.v1',
            ordinal: blocks.length,
            startSession,
            endSession: lastObservation.sessionDate,
            nextRebalanceSession,
            observations,
          }
          return pipe(
            hashQualificationEvidence('complete-block', material),
            Result.map((contentHash) => [
              ...blocks,
              {
                evidence: {
                  ordinal: material.ordinal,
                  startSession,
                  endSession: material.endSession,
                  nextRebalanceSession,
                  observationCount: observations.length,
                  contentHash,
                },
                observations,
              },
            ]),
          )
        }),
      ),
    Result.succeed([]),
  )
