import { pipe, Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { QualificationStatisticsFailure } from './failure'
import { Pipeable } from '../pipeable'

export type QualificationStatisticsHashOperation = Extract<
  QualificationStatisticsFailure,
  { readonly _tag: 'QualificationStatisticsCanonicalizationFailed' }
>['operation']

const hashQualificationEvidenceDataFirst = (
  operation: QualificationStatisticsHashOperation,
  value: unknown,
): Result.Result<string, QualificationStatisticsFailure> =>
  pipe(
    canonicalHashV1Result(value),
    Result.mapError(
      (cause): QualificationStatisticsFailure => ({
        _tag: 'QualificationStatisticsCanonicalizationFailed',
        operation,
        cause,
      }),
    ),
  )

export const hashQualificationEvidence = Pipeable.dual(2, hashQualificationEvidenceDataFirst)
