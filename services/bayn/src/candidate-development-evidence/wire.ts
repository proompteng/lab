import { Result, Schema } from 'effect'

import {
  CandidateDevelopmentEvaluationSchema,
  CandidateDevelopmentPreflightInputSchema,
  CandidateDevelopmentSourceManifestSchema,
  CandidateDevelopmentStrategyProtocolSchema,
} from '../candidate-development-command/contracts'
import { validateCandidateDevelopmentCommandEvaluation } from '../candidate-development-command/runtime-policy'
import {
  GitSourceRevisionSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import type { CandidateDevelopmentEvidenceDecodeIssue, CandidateDevelopmentImmutableEvidence } from './model'

const CandidateDevelopmentMarketDataBindingSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-market-data-source.v1'),
  snapshotId: Sha256Schema,
  finalizedSnapshotContentHash: Sha256Schema,
  inputManifestHash: Sha256Schema,
  boundedContentHash: Sha256Schema,
})

const CandidateDevelopmentEvidenceBindingsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-evidence-bindings.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  preregistration: Schema.Struct({
    sourceRevision: GitSourceRevisionSchema,
    path: StrictNonEmptyStringSchema,
    blobOid: GitSourceRevisionSchema,
  }),
  reviewedSourceRevision: GitSourceRevisionSchema,
  mergedSourceRevision: GitSourceRevisionSchema,
  module: Schema.Struct({
    path: StrictNonEmptyStringSchema,
    blobOid: GitSourceRevisionSchema,
    sha256: Sha256Schema,
  }),
  sourceManifest: Schema.Struct({
    path: StrictNonEmptyStringSchema,
    blobOid: GitSourceRevisionSchema,
    sha256: Sha256Schema,
  }),
  strategyProtocolHash: Sha256Schema,
  candidateDevelopmentProtocolHash: Sha256Schema,
  marketData: CandidateDevelopmentMarketDataBindingSchema,
  calendar: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-calendar.v1'),
    calendarVersion: Schema.Literal('alpaca-us-equity-calendar-v1'),
    start: Schema.Literal('2016-01-04'),
    end: Schema.Literal('2022-12-30'),
    sessionCount: Schema.Literal(1_762),
    sessionsHash: Schema.Literal('a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1'),
  }),
})

const CandidateDevelopmentVerifiedSourceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-verified-source.v1'),
  sourceRevision: GitSourceRevisionSchema,
  modulePath: StrictNonEmptyStringSchema,
  moduleBlobOid: GitSourceRevisionSchema,
  moduleSha256: Sha256Schema,
  sourceManifestPath: StrictNonEmptyStringSchema,
  sourceManifestBlobOid: GitSourceRevisionSchema,
  sourceManifestSha256: Sha256Schema,
  sourceManifest: CandidateDevelopmentSourceManifestSchema,
  baselineRunId: Sha256Schema,
  stressedRunId: Sha256Schema,
})

const CandidateDevelopmentReviewedTerminalSummarySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-reviewed-terminal-summary.v1'),
  source: Schema.Literal('reviewed-development-only-evaluation'),
  strategyAnnualizedReturn: Schema.Finite,
  buyAndHoldAnnualizedReturn: Schema.Finite,
  annualizedReturnDifferenceLowerBound: Schema.Finite,
  sharpeDifferenceLowerBound: Schema.Finite,
  verdict: Schema.Literals(['PASS', 'FAIL_CLOSED']),
  researchContext: Schema.Tuple([
    Schema.Literal('https://doi.org/10.1111/1468-0262.00152'),
    Schema.Literal('https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253'),
  ]),
})

export const CandidateDevelopmentImmutableEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-immutable-evidence.v2'),
  recordedAt: UtcInstantSchema,
  bindings: CandidateDevelopmentEvidenceBindingsSchema,
  input: CandidateDevelopmentPreflightInputSchema,
  verifiedSource: CandidateDevelopmentVerifiedSourceSchema,
  strategyProtocol: CandidateDevelopmentStrategyProtocolSchema,
  evaluation: CandidateDevelopmentEvaluationSchema,
  reviewedTerminalSummary: CandidateDevelopmentReviewedTerminalSummarySchema,
  contentHash: Sha256Schema,
})

const decodeCandidateDevelopmentImmutableEvidenceBoundary = Schema.decodeUnknownResult(
  CandidateDevelopmentImmutableEvidenceSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentImmutableEvidence = (
  value: unknown,
): Result.Result<CandidateDevelopmentImmutableEvidence, CandidateDevelopmentEvidenceDecodeIssue> => {
  const decoded = decodeCandidateDevelopmentImmutableEvidenceBoundary(value)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'CandidateDevelopmentEvidenceDecodeFailed', cause: decoded.failure })
  }
  const evaluation = validateCandidateDevelopmentCommandEvaluation(decoded.success.evaluation)
  if (Result.isFailure(evaluation)) {
    return Result.fail({ _tag: 'CandidateDevelopmentEvidenceDecodeFailed', cause: evaluation.failure })
  }
  return Result.succeed({ ...decoded.success, evaluation: evaluation.success } as CandidateDevelopmentImmutableEvidence)
}
