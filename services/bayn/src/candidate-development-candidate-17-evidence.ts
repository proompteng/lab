import rawEvidence from '../candidates/ordinal-17-volatility-managed-trend-overlay-development-evidence.json' with { type: 'json' }

import { pipe, Result } from 'effect'

import {
  buildCandidateDevelopmentIndependentReproduction,
  decodeCandidateDevelopmentImmutableEvidence,
} from './candidate-development-evidence'
import { candidateDevelopmentArtifact } from './strategy/volatility-managed-trend-overlay/candidate-17'

export const candidate17DevelopmentEvidenceResult = decodeCandidateDevelopmentImmutableEvidence(rawEvidence)

export const candidate17DevelopmentIndependentReproductionResult = pipe(
  candidate17DevelopmentEvidenceResult,
  Result.flatMap((evidence) =>
    pipe(
      Result.try({
        try: () => candidateDevelopmentArtifact.buildEvaluation(evidence.verifiedSource),
        catch: (cause) => ({ _tag: 'CandidateDevelopmentEvidenceReproductionFailed' as const, cause }),
      }),
      Result.flatMap((evaluation) =>
        buildCandidateDevelopmentIndependentReproduction(evidence.verifiedSource, evaluation),
      ),
    ),
  ),
)
