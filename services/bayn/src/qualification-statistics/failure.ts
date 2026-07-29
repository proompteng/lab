import { Result, type Schema } from 'effect'

import { renderCanonicalJsonFailure, type CanonicalJsonFailure } from '../hash'
import type { IsoDate } from '../types'

export type QualificationStatisticsFailure =
  | {
      readonly _tag: 'QualificationStatisticsSchemaInvalid'
      readonly operation: 'analysis' | 'policy' | 'power' | 'prior-trial-run-ids' | 'series'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'QualificationStatisticsCanonicalizationFailed'
      readonly operation: 'analysis' | 'bootstrap-samples' | 'bootstrap-seed' | 'complete-block' | 'walk-forward-fold'
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly _tag: 'QualificationStatisticNotFinite'
      readonly operation: 'power' | 'round'
      readonly value: number
    }
  | {
      readonly _tag: 'QualificationDateOrderInvalid'
      readonly previous: IsoDate
      readonly current: IsoDate
    }
  | {
      readonly _tag: 'QualificationSeriesAlignmentFailed'
      readonly reason:
        | 'duplicate-buy-and-hold-date'
        | 'duplicate-direct-volatility-date'
        | 'missing-buy-and-hold-observation'
        | 'missing-direct-volatility-observation'
        | 'observation-count-mismatch'
      readonly sessionDate: IsoDate | null
      readonly strategyCount: number
      readonly buyAndHoldCount: number
      readonly directVolatilityCount: number
    }
  | {
      readonly _tag: 'QualificationLineageInvalid'
      readonly priorTrialRunIds: readonly string[]
    }
  | {
      readonly _tag: 'QualificationRandomIndexInvalid'
      readonly maximum: number
    }
  | {
      readonly _tag: 'QualificationSamplingBlockMissing'
      readonly index: number
      readonly blockCount: number
    }
  | {
      readonly _tag: 'QualificationWalkForwardBoundaryMissing'
      readonly testStart: number
      readonly testSessions: number
      readonly observationCount: number
    }

export const renderQualificationStatisticsFailure = (failure: QualificationStatisticsFailure): string => {
  switch (failure._tag) {
    case 'QualificationStatisticsSchemaInvalid':
      return `${failure.operation} schema validation failed: ${failure.cause.message}`
    case 'QualificationStatisticsCanonicalizationFailed':
      return `${failure.operation} canonicalization failed: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'QualificationStatisticNotFinite':
      return `${failure.operation} statistic is not finite: ${failure.value}`
    case 'QualificationDateOrderInvalid':
      return `qualification dates are not increasing: ${failure.previous} then ${failure.current}`
    case 'QualificationSeriesAlignmentFailed':
      return `qualification series ${failure.reason} at ${failure.sessionDate ?? 'no session'} (strategy=${failure.strategyCount}, buy-and-hold=${failure.buyAndHoldCount}, direct-volatility=${failure.directVolatilityCount})`
    case 'QualificationLineageInvalid':
      return `prior qualification run IDs are not canonical: ${failure.priorTrialRunIds.join(',')}`
    case 'QualificationRandomIndexInvalid':
      return `bootstrap random index maximum must be positive: ${failure.maximum}`
    case 'QualificationSamplingBlockMissing':
      return `bootstrap block ${failure.index} is outside ${failure.blockCount} blocks`
    case 'QualificationWalkForwardBoundaryMissing':
      return `walk-forward test window ${failure.testStart}+${failure.testSessions} exceeds ${failure.observationCount} observations`
  }
}

export const statisticsFailure = <A = never>(
  failure: QualificationStatisticsFailure,
): Result.Result<A, QualificationStatisticsFailure> => Result.fail(failure)
