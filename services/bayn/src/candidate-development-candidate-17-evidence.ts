import { execFileSync } from 'node:child_process'

import { pipe, Result } from 'effect'

import {
  candidate17ArchiveReceipt,
  type LegacyCandidateArchiveArtifact,
} from './candidate-archive/legacy-candidate-receipts'
import {
  buildCandidateDevelopmentIndependentReproduction,
  decodeCandidateDevelopmentImmutableEvidence,
} from './candidate-development-evidence'

// This compatibility bridge is imported only by the legacy Candidate 17 audit test.
// Runtime/status code uses the compact archive receipt and never needs the old blob.
const historicalEvidenceArtifact = candidate17ArchiveReceipt.historicalArtifacts.find(
  ({ kind }) => kind === 'development-evidence',
)

const readHistoricalEvidence = (
  artifact: LegacyCandidateArchiveArtifact | undefined,
): Result.Result<unknown, unknown> =>
  artifact === undefined
    ? Result.fail({ _tag: 'Candidate17ArchiveEvidenceArtifactMissing' as const })
    : Result.try({
        try: () =>
          JSON.parse(
            execFileSync('git', ['cat-file', 'blob', artifact.blobOid], {
              encoding: 'utf8',
              maxBuffer: artifact.byteCount + 1,
            }),
          ),
        catch: (cause) => ({ _tag: 'Candidate17ArchiveEvidenceBlobUnavailable' as const, cause }),
      })

export const candidate17DevelopmentEvidenceResult = pipe(
  readHistoricalEvidence(historicalEvidenceArtifact),
  Result.flatMap(decodeCandidateDevelopmentImmutableEvidence),
)

export const candidate17DevelopmentIndependentReproductionResult = pipe(
  candidate17DevelopmentEvidenceResult,
  Result.flatMap((evidence) =>
    // The generator was intentionally removed. The audit keeps the exact historical
    // evaluation content-addressed in Git and verifies it without loading executable code.
    buildCandidateDevelopmentIndependentReproduction(evidence.verifiedSource, evidence.evaluation),
  ),
)
