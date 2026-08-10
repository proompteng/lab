import { pipe, Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { QualificationConstructionFailure } from './failure'
import { Pipeable } from '../pipeable'

const canonicalHashMatchesDataFirst = (expected: string, value: unknown): boolean => {
  const result = canonicalHashV1Result(value)
  return Result.isSuccess(result) && result.success === expected
}

export const canonicalHashMatches = Pipeable.dual(2, canonicalHashMatchesDataFirst)

const hashQualificationMaterialDataFirst = (
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

export const hashQualificationMaterial = Pipeable.dual(2, hashQualificationMaterialDataFirst)
