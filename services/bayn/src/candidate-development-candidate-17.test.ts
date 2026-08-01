import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  candidate17ArchiveReceipt,
  candidate18ArchiveReceipt,
  candidate19ArchiveReceipt,
  candidate20ArchiveReceipt,
  validateLegacyCandidateArchiveReceipt,
  type LegacyCandidateArchiveReceipt,
} from './candidate-archive/legacy-candidate-receipts'

const archiveArtifacts = (receipt: LegacyCandidateArchiveReceipt) =>
  receipt.historicalArtifacts.map(({ path, blobOid, sha256, byteCount, lineCount }) => ({
    path,
    blobOid,
    sha256,
    byteCount,
    lineCount,
  }))

describe('legacy candidate archive receipts', () => {
  test('preserves Candidate 17 content identity without retaining executable payloads', () => {
    expect(validateLegacyCandidateArchiveReceipt(candidate17ArchiveReceipt)).toEqual(
      Result.succeed(candidate17ArchiveReceipt),
    )
    expect(candidate17ArchiveReceipt).toMatchObject({
      candidateOrdinal: 17,
      priorTrialCount: 16,
      status: 'DEVELOPMENT_REJECTED',
      qualificationAttemptConsumed: false,
      nextCandidatePreregistration: null,
      facts: {
        evidenceContentHash: '97b9c2d6dc1d59d9b60686065bc4d595b8d1f22cdff9930b6131427b90e13f26',
        independentlyReproducedEvaluationHash: 'c7e551fc6352c4294f38e083b8743b882f2874ec4d614f46a04539d2a72d79a1',
        terminalVerdict: 'FAIL_CLOSED',
      },
    })
    expect(archiveArtifacts(candidate17ArchiveReceipt).every((artifact) => Object.keys(artifact).length === 5)).toBe(
      true,
    )
    expect(candidate17ArchiveReceipt.historicalArtifacts.find(({ kind }) => kind === 'strategy-module')).toMatchObject({
      byteCount: 2_961_718,
      lineCount: 122_955,
    })
  })

  test('retains the complete four-candidate lineage and zero-attempt terminal boundary', () => {
    expect(
      [candidate17ArchiveReceipt, candidate18ArchiveReceipt, candidate19ArchiveReceipt, candidate20ArchiveReceipt].map(
        ({ candidateOrdinal }) => candidateOrdinal,
      ),
    ).toEqual([17, 18, 19, 20])
    expect(candidate20ArchiveReceipt).toMatchObject({
      status: 'PRECOMMIT_INVALID',
      qualificationAttemptConsumed: false,
      nextCandidatePreregistration: null,
      facts: { attemptStatus: 'UNATTEMPTED', metricBearingAttemptsConsumed: 0 },
    })
    expect(candidate20ArchiveReceipt.historicalArtifacts.find(({ kind }) => kind === 'strategy-module')).toMatchObject({
      byteCount: 2_963_738,
      lineCount: 123_194,
    })
  })

  test('fails closed when a receipt binding is changed', () => {
    const tampered = {
      ...candidate17ArchiveReceipt,
      historicalArtifacts: candidate17ArchiveReceipt.historicalArtifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, sha256: '0'.repeat(64) } : artifact,
      ),
    } as LegacyCandidateArchiveReceipt

    expect(validateLegacyCandidateArchiveReceipt(tampered)).toMatchObject({
      failure: { _tag: 'LegacyCandidateArchiveReceiptHashMismatch' },
    })
  })
})
