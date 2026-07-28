import { pipe, Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { QualificationConstructionFailure } from './failure'

export const canonicalHashMatches = (expected: string, value: unknown): boolean => {
  const result = canonicalHashV1Result(value)
  return Result.isSuccess(result) && result.success === expected
}

export const hashQualificationMaterial = (
  operation: Extract<
    QualificationConstructionFailure,
    { readonly _tag: 'QualificationCanonicalizationFailed' }
  >['operation'],
  value: unknown,
): Result.Result<string, QualificationConstructionFailure> =>
  pipe(
    canonicalHashV1Result(value),
    Result.mapError(
      (cause): QualificationConstructionFailure => ({
        _tag: 'QualificationCanonicalizationFailed',
        operation,
        cause,
      }),
    ),
  )
