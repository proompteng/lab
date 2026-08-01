import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  candidate20ArchiveReceipt,
  validateLegacyCandidateArchiveReceipt,
} from './candidate-archive/legacy-candidate-receipts'
import { candidate20InvalidPrecommit } from './strategy/cross-sectional-short-term-reversal/candidate-20'

describe('Candidate 20 invalid-precommit tombstone', () => {
  test('preserves the sealed unattempted state and rejects executable promotion', () => {
    expect(validateLegacyCandidateArchiveReceipt(candidate20ArchiveReceipt)).toEqual(
      Result.succeed(candidate20ArchiveReceipt),
    )
    expect(candidate20InvalidPrecommit).toEqual({
      schemaVersion: 'bayn.candidate-development-precommit-tombstone.v1',
      candidateOrdinal: 20,
      status: 'PRECOMMIT_INVALID',
      attemptStatus: 'UNATTEMPTED',
      invalidatedModuleSha256: '15570022245f8bba1c121c6657369d66085d6c3659aa326b50048be1ab050441',
      nextCandidatePreregistration: null,
    })
    expect(candidate20ArchiveReceipt.facts.naturalBuild).toMatchObject({
      imagePublished: true,
      deploymentAllowed: false,
    })
    expect(candidate20ArchiveReceipt.facts.release).toMatchObject({
      conclusion: 'CANCELLED',
      promotionCompleted: false,
    })
  })

  test('retains the invalidated module identity without its generated body', () => {
    expect(candidate20ArchiveReceipt.historicalArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'strategy-module', byteCount: 2_963_738, lineCount: 123_194 }),
        expect.objectContaining({ kind: 'precommit-invalidation', byteCount: 1_910, lineCount: 49 }),
      ]),
    )
  })
})
