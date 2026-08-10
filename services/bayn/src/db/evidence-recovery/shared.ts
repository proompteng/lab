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

export interface RecoveryCanonicalHashInput {
  readonly operation: RecoveryCanonicalizationOperation
  readonly value: unknown
  readonly subject?: string
}

export const canonicalHash = (input: RecoveryCanonicalHashInput): Result.Result<string, EvidenceRecoveryIssue> =>
  Result.mapError(
    canonicalHashV1Result(input.value),
    (cause): EvidenceRecoveryIssue => ({
      _tag: 'CanonicalizationFailure',
      operation: input.operation,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      cause,
    }),
  )
