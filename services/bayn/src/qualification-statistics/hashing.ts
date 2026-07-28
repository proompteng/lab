import { pipe, Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { QualificationStatisticsFailure } from './failure'

export type QualificationStatisticsHashOperation = Extract<
  QualificationStatisticsFailure,
  { readonly _tag: 'QualificationStatisticsCanonicalizationFailed' }
>['operation']

export const hashQualificationEvidence = (
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
