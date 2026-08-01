import { Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import type { CandidateDevelopmentNextPreregistration } from '../candidate-development-decision'
import type {
  CandidateDevelopmentEvidenceBindings,
  CandidateDevelopmentEvidenceExpectation,
  CandidateDevelopmentEvidenceIssue,
  CandidateDevelopmentImmutableEvidence,
} from './model'

export type CandidateDevelopmentCanonicalBinding = readonly [string, unknown, unknown]

export const sameCanonical = (left: unknown, right: unknown): Result.Result<boolean, CanonicalHashFailure> => {
  const leftHash = canonicalHashV1Result(left)
  if (Result.isFailure(leftHash)) return Result.fail(leftHash.failure)
  const rightHash = canonicalHashV1Result(right)
  return Result.isFailure(rightHash)
    ? Result.fail(rightHash.failure)
    : Result.succeed(leftHash.success === rightHash.success)
}

export const collectCanonicalBinding = (
  issues: CandidateDevelopmentEvidenceIssue[],
  field: string,
  expected: unknown,
  observed: unknown,
): void => {
  const equal = sameCanonical(expected, observed)
  if (Result.isFailure(equal)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: equal.failure })
  } else if (!equal.success) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceBindingMismatch', field, expected, observed })
  }
}

export const collectCanonicalBindings = (
  issues: CandidateDevelopmentEvidenceIssue[],
  bindings: readonly CandidateDevelopmentCanonicalBinding[],
): void => {
  for (const [field, expected, observed] of bindings) collectCanonicalBinding(issues, field, expected, observed)
}

export const collectEvidenceBindings = (
  issues: CandidateDevelopmentEvidenceIssue[],
  expected: CandidateDevelopmentEvidenceBindings,
  observed: CandidateDevelopmentEvidenceBindings,
): void => {
  collectCanonicalBindings(issues, [
    ['schemaVersion', expected.schemaVersion, observed.schemaVersion],
    ['candidateOrdinal', expected.candidateOrdinal, observed.candidateOrdinal],
    ['priorTrialCount', expected.priorTrialCount, observed.priorTrialCount],
    ['preregistration', expected.preregistration, observed.preregistration],
    ['reviewedSourceRevision', expected.reviewedSourceRevision, observed.reviewedSourceRevision],
    ['mergedSourceRevision', expected.mergedSourceRevision, observed.mergedSourceRevision],
    ['module', expected.module, observed.module],
    ['sourceManifest', expected.sourceManifest, observed.sourceManifest],
    ['strategyProtocolHash', expected.strategyProtocolHash, observed.strategyProtocolHash],
    [
      'candidateDevelopmentProtocolHash',
      expected.candidateDevelopmentProtocolHash,
      observed.candidateDevelopmentProtocolHash,
    ],
    ['marketData', expected.marketData, observed.marketData],
    ['calendar', expected.calendar, observed.calendar],
  ])
}

export const expectedPreregistrationFromBindings = (
  bindings: CandidateDevelopmentEvidenceBindings,
): CandidateDevelopmentNextPreregistration => ({
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal: bindings.candidateOrdinal,
  priorTrialCount: bindings.priorTrialCount,
  strategyProtocolHash: bindings.strategyProtocolHash,
  modulePath: bindings.module.path,
  moduleSha256: bindings.module.sha256,
  marketData: bindings.marketData,
  preregistration: bindings.preregistration,
})

export const collectCandidateDevelopmentEligibilityBindings = (
  issues: CandidateDevelopmentEvidenceIssue[],
  evidence: CandidateDevelopmentImmutableEvidence,
  expectation: CandidateDevelopmentEvidenceExpectation,
  preregistration: CandidateDevelopmentNextPreregistration,
): void => {
  collectEvidenceBindings(issues, expectation.bindings, evidence.bindings)
  collectCanonicalBindings(issues, [
    ['qualificationPreregistration', expectedPreregistrationFromBindings(evidence.bindings), preregistration],
    ['input.candidateOrdinal', evidence.bindings.candidateOrdinal, evidence.input.candidateOrdinal],
    ['input.priorTrialCount', evidence.bindings.priorTrialCount, evidence.input.priorTrialCount],
    ['verifiedSource.sourceRevision', evidence.bindings.reviewedSourceRevision, evidence.verifiedSource.sourceRevision],
    ['verifiedSource.modulePath', evidence.bindings.module.path, evidence.verifiedSource.modulePath],
    ['verifiedSource.moduleBlobOid', evidence.bindings.module.blobOid, evidence.verifiedSource.moduleBlobOid],
    ['verifiedSource.moduleSha256', evidence.bindings.module.sha256, evidence.verifiedSource.moduleSha256],
    [
      'verifiedSource.sourceManifestPath',
      evidence.bindings.sourceManifest.path,
      evidence.verifiedSource.sourceManifestPath,
    ],
    [
      'verifiedSource.sourceManifestBlobOid',
      evidence.bindings.sourceManifest.blobOid,
      evidence.verifiedSource.sourceManifestBlobOid,
    ],
    [
      'verifiedSource.sourceManifestSha256',
      evidence.bindings.sourceManifest.sha256,
      evidence.verifiedSource.sourceManifestSha256,
    ],
  ])
}
