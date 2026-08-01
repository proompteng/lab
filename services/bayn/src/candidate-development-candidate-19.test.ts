import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  candidate19ArchiveReceipt,
  validateLegacyCandidateArchiveReceipt,
} from './candidate-archive/legacy-candidate-receipts'
import {
  candidate19DevelopmentFailureEvidenceExpectation,
  candidate19DevelopmentFailureEvidenceResult,
  validateCandidate19DevelopmentFailureEvidence,
} from './candidate-development-candidate-19-evidence'

describe('Candidate 19 archived development rejection', () => {
  test('preserves the observed metric-bearing failure without authorizing a rerun', () => {
    expect(validateLegacyCandidateArchiveReceipt(candidate19ArchiveReceipt)).toEqual(
      Result.succeed(candidate19ArchiveReceipt),
    )
    expect(candidate19DevelopmentFailureEvidenceResult).toMatchObject({
      _tag: 'Success',
      success: {
        candidateOrdinal: 19,
        priorTrialCount: 18,
        status: 'DEVELOPMENT_REJECTED',
        qualificationAttemptConsumed: false,
        nextCandidatePreregistration: null,
        preMetricEvidence: { preflightStatus: 'PASS', registrationStatus: 'PASS' },
        attempt: {
          stage: 'development-evaluation',
          developmentMetricsObserved: true,
          evaluationRerunAuthorized: false,
          exitCode: 1,
        },
      },
    })
    expect(candidate19DevelopmentFailureEvidenceExpectation).toMatchObject({
      contentHash: candidate19ArchiveReceipt.facts.evidenceContentHash,
      sourceRevision: candidate19ArchiveReceipt.facts.sourceRevision,
      developmentMetricsObserved: true,
      qualificationAttemptConsumed: false,
    })
  })

  test('keeps the captured-output digest while rejecting substituted output', () => {
    if (Result.isFailure(candidate19DevelopmentFailureEvidenceResult)) {
      throw new Error('expected Candidate 19 archive evidence to validate')
    }
    expect(
      validateCandidate19DevelopmentFailureEvidence(candidate19DevelopmentFailureEvidenceResult.success, 'tampered'),
    ).toMatchObject({
      failure: {
        _tag: 'Candidate19DevelopmentFailureEvidenceBindingMismatch',
        field: 'attempt.failure.capturedOutputSha256',
      },
    })
    expect(candidate19ArchiveReceipt.historicalArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'attempt-output',
          sha256: candidate19DevelopmentFailureEvidenceResult.success.attempt.failure.capturedOutputSha256,
          byteCount: 1_268,
        }),
      ]),
    )
  })
})
