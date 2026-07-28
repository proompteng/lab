import { pipe, Result } from 'effect'

import { analyzeQualificationInput } from '../qualification-statistics/analysis'
import {
  decodeQualificationStatisticsPolicy,
  qualificationStatisticsSchemaFailure,
} from '../qualification-statistics/decoding'
import type { QualificationAnalysis, QualificationSeries } from '../qualification-statistics/model'
import type { QualificationStatisticsFailure } from '../qualification-statistics/failure'
import type { EconomicVerdict } from '../types'
import type { QualificationConstructionFailure } from './failure'
import type { QualificationLock, QualificationResult } from './model'
import { makeQualificationResult } from './result'

export interface QualificationPipelineInput {
  readonly lock: QualificationLock
  readonly evaluationVerdict: EconomicVerdict
  readonly series: QualificationSeries
}

export interface QualificationEvidence {
  readonly lock: QualificationLock
  readonly analysis: QualificationAnalysis
  readonly result: QualificationResult
}

export type QualificationPipelineFailure = QualificationStatisticsFailure | QualificationConstructionFailure

export const runQualificationPipeline = (
  input: QualificationPipelineInput,
): Result.Result<QualificationEvidence, QualificationPipelineFailure> =>
  pipe(
    decodeQualificationStatisticsPolicy(input.lock.policies.uncertainty.content),
    Result.mapError(qualificationStatisticsSchemaFailure('policy')),
    Result.flatMap((policy) =>
      analyzeQualificationInput({
        series: input.series,
        policy,
        priorTrialRunIds: input.lock.priorTrialRunIds,
      }),
    ),
    Result.flatMap((analysis) =>
      pipe(
        makeQualificationResult(input.lock, input.evaluationVerdict, analysis),
        Result.map((result) => ({ lock: input.lock, analysis, result })),
      ),
    ),
  )
