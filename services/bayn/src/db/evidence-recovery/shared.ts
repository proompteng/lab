import { Result } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import type {
  EvidenceRecoveryIssue,
  RecoveryCanonicalizationOperation,
  RecoveryMismatchStage,
  RecoveryPath,
} from './model'
import { Pipeable } from '../../pipeable'

export const recoveryFailure = (issue: EvidenceRecoveryIssue): Result.Result<never, EvidenceRecoveryIssue> =>
  Result.fail(issue)

const mismatchDataFirst = (
  stage: RecoveryMismatchStage,
  path: RecoveryPath,
  observed: unknown,
  expected: unknown,
): Result.Result<never, EvidenceRecoveryIssue> =>
  recoveryFailure({ _tag: 'RecoveryMismatch', stage, path, observed, expected })

export const mismatch = Pipeable.dual(4, mismatchDataFirst)

export const canonicalHash = (
  operation: RecoveryCanonicalizationOperation,
  value: unknown,
  subject?: string,
): Result.Result<string, EvidenceRecoveryIssue> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): EvidenceRecoveryIssue => ({
      _tag: 'CanonicalizationFailure',
      operation,
      ...(subject === undefined ? {} : { subject }),
      cause,
    }),
  )
