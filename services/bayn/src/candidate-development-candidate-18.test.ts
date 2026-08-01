import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  candidate18ArchiveReceipt,
  validateLegacyCandidateArchiveReceipt,
} from './candidate-archive/legacy-candidate-receipts'
import {
  candidate18DevelopmentFailureEvidenceExpectation,
  candidate18DevelopmentFailureEvidenceResult,
} from './candidate-development-candidate-18-evidence'

describe('Candidate 18 archived development rejection', () => {
  test('keeps the preflight failure and immutable source identities', () => {
    expect(validateLegacyCandidateArchiveReceipt(candidate18ArchiveReceipt)).toEqual(
      Result.succeed(candidate18ArchiveReceipt),
    )
    expect(candidate18DevelopmentFailureEvidenceResult).toMatchObject({
      _tag: 'Success',
      success: {
        candidateOrdinal: 18,
        priorTrialCount: 17,
        status: 'DEVELOPMENT_REJECTED',
        qualificationAttemptConsumed: false,
        nextCandidatePreregistration: null,
        attempt: {
          stage: 'buildEvaluation-preflight',
          developmentMetricsObserved: false,
          evaluationRerunAuthorized: false,
        },
      },
    })
    expect(candidate18DevelopmentFailureEvidenceExpectation).toEqual({
      contentHash: candidate18ArchiveReceipt.facts.evidenceContentHash,
      sourceRevision: candidate18ArchiveReceipt.facts.sourceRevision,
      status: 'DEVELOPMENT_REJECTED',
      qualificationAttemptConsumed: false,
      nextCandidatePreregistration: null,
    })
  })

  test('retains only digests for the removed bundle and evidence payload', () => {
    expect(candidate18ArchiveReceipt.historicalArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'strategy-module', byteCount: 2_960_908, lineCount: 122_932 }),
        expect.objectContaining({ kind: 'development-evidence', byteCount: 3_956, lineCount: 69 }),
      ]),
    )
    expect(candidate18ArchiveReceipt.facts.embeddedEvaluationProtocolHash).not.toBe(
      candidate18ArchiveReceipt.facts.strategyProtocolHash,
    )
  })
})
