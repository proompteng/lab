import { pipe, Result } from 'effect'

import {
  decodeQualificationPower,
  decodeQualificationStatisticsPolicy,
  qualificationStatisticsSchemaFailure,
} from './decoding'
import { statisticsFailure, type QualificationStatisticsFailure } from './failure'
import type { PowerAnalysis, QualificationStatisticsPolicy } from './model'
import { roundStatistic } from './numerical-methods'

const Z_ONE_SIDED_95 = 1.6448536269514722
const Z_POWER_80 = 0.8416212335729143

const finitePowerStatistic = (value: number): Result.Result<number, QualificationStatisticsFailure> =>
  Number.isFinite(value)
    ? Result.succeed(value)
    : statisticsFailure({ _tag: 'QualificationStatisticNotFinite', operation: 'power', value })

export const calculateQualificationPower = (
  policy: QualificationStatisticsPolicy,
  availableCompleteRebalanceBlocks: number,
  availableCompleteSessions: number,
): Result.Result<PowerAnalysis, QualificationStatisticsFailure> =>
  pipe(
    decodeQualificationStatisticsPolicy(policy),
    Result.mapError(qualificationStatisticsSchemaFailure('policy')),
    Result.flatMap((decoded) => {
      const standardizedEffect =
        decoded.power.minimumDetectableAnnualizedExcessReturn / decoded.power.assumedAnnualizedTrackingVolatility
      const estimatedBlocks = Math.ceil(((Z_ONE_SIDED_95 + Z_POWER_80) / standardizedEffect) ** 2)
      const requiredCompleteRebalanceBlocks = Math.max(decoded.power.absoluteMinimumRebalanceBlocks, estimatedBlocks)
      const requiredSessions = Math.max(
        decoded.power.absoluteMinimumSessions,
        requiredCompleteRebalanceBlocks * decoded.power.assumedSessionsPerRebalanceBlock,
      )
      return pipe(
        Result.all({
          standardizedEffect: roundStatistic(standardizedEffect),
          requiredCompleteRebalanceBlocks: pipe(
            finitePowerStatistic(requiredCompleteRebalanceBlocks),
            Result.map(Math.trunc),
          ),
          requiredSessions: pipe(finitePowerStatistic(requiredSessions), Result.map(Math.trunc)),
        }),
        Result.flatMap((values) =>
          pipe(
            decodeQualificationPower({
              schemaVersion: 'bayn.qualification-power.v1',
              method: decoded.power.method,
              oneSidedAlpha: decoded.power.oneSidedAlpha,
              targetPower: decoded.power.targetPower,
              minimumDetectableAnnualizedExcessReturn: decoded.power.minimumDetectableAnnualizedExcessReturn,
              assumedAnnualizedTrackingVolatility: decoded.power.assumedAnnualizedTrackingVolatility,
              standardizedEffect: values.standardizedEffect,
              requiredCompleteRebalanceBlocks: values.requiredCompleteRebalanceBlocks,
              requiredSessions: values.requiredSessions,
              availableCompleteRebalanceBlocks,
              availableCompleteSessions,
              sufficient:
                availableCompleteRebalanceBlocks >= values.requiredCompleteRebalanceBlocks &&
                availableCompleteSessions >= values.requiredSessions,
            }),
            Result.mapError(qualificationStatisticsSchemaFailure('power')),
          ),
        ),
      )
    }),
  )
