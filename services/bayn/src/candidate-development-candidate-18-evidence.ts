import rawEvidence from '../candidates/ordinal-18-global-equity-dual-momentum-development-evidence.json' with { type: 'json' }

import { pipe, Result, Schema } from 'effect'

import { CandidateDevelopmentSourceManifestSchema } from './candidate-development-command'
import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'
import {
  GitSourceRevisionSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'

const Candidate18VerifiedSourceSchema = Schema.Struct({
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

export const Candidate18DevelopmentFailureEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-attempt-failure-evidence.v1'),
  recordedAt: UtcInstantSchema,
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  status: Schema.Literal('DEVELOPMENT_REJECTED'),
  qualificationAttemptConsumed: Schema.Literal(false),
  nextCandidatePreregistration: Schema.Null,
  preregistration: Schema.Struct({
    sourceRevision: GitSourceRevisionSchema,
    path: StrictNonEmptyStringSchema,
    blobOid: GitSourceRevisionSchema,
  }),
  verifiedSource: Candidate18VerifiedSourceSchema,
  protocolBindings: Schema.Struct({
    strategyProtocolHash: Sha256Schema,
    strategyIdentityHash: Sha256Schema,
    candidateDevelopmentProtocolHash: Sha256Schema,
    calendarHash: Sha256Schema,
    priorTrialsHash: Sha256Schema,
    embeddedEvaluationProtocolHash: Sha256Schema,
  }),
  attempt: Schema.Struct({
    attemptedAt: UtcInstantSchema,
    stage: Schema.Literal('buildEvaluation-preflight'),
    developmentMetricsObserved: Schema.Literal(false),
    developmentReportWritten: Schema.Literal(false),
    evaluationRerunAuthorized: Schema.Literal(false),
    failure: Schema.Struct({
      _tag: Schema.Literal('CandidateDevelopmentCommandProgramExecutionFailed'),
      cause: Schema.Struct({
        _tag: Schema.Literal('Candidate18InvalidInput'),
        operation: Schema.Literal('preflight'),
        reason: Schema.Literal(
          'strategy protocol hash fa25d8c16bc4f4fde3bab99409ae60a6fd23332d295b3557231796cebb911390 differs from Candidate 18',
        ),
      }),
    }),
  }),
  contentHash: Sha256Schema,
})

export type Candidate18DevelopmentFailureEvidence = Schema.Schema.Type<
  typeof Candidate18DevelopmentFailureEvidenceSchema
>

export type Candidate18DevelopmentFailureEvidenceIssue =
  | { readonly _tag: 'Candidate18DevelopmentFailureEvidenceDecodeFailed'; readonly cause: unknown }
  | { readonly _tag: 'Candidate18DevelopmentFailureEvidenceHashFailed'; readonly cause: CanonicalHashFailure }
  | {
      readonly _tag: 'Candidate18DevelopmentFailureEvidenceContentHashMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'Candidate18DevelopmentFailureEvidenceBindingMismatch'
      readonly field: string
      readonly expected: unknown
      readonly observed: unknown
    }

const candidate18DevelopmentFailureEvidenceContentHash =
  '65d6f044f3f323aa87ff26a3dca011053aa3172c8a4ce422841497ccf370a5b6'

const decodeCandidate18DevelopmentFailureEvidenceBoundary = Schema.decodeUnknownResult(
  Candidate18DevelopmentFailureEvidenceSchema,
  strictParseOptions,
)

const candidate18BindingMismatch = (
  field: string,
  expected: unknown,
  observed: unknown,
): Candidate18DevelopmentFailureEvidenceIssue => ({
  _tag: 'Candidate18DevelopmentFailureEvidenceBindingMismatch',
  field,
  expected,
  observed,
})

export const validateCandidate18DevelopmentFailureEvidence = (
  value: unknown,
): Result.Result<Candidate18DevelopmentFailureEvidence, Candidate18DevelopmentFailureEvidenceIssue> => {
  const decoded = decodeCandidate18DevelopmentFailureEvidenceBoundary(value)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'Candidate18DevelopmentFailureEvidenceDecodeFailed', cause: decoded.failure })
  }
  const evidence = decoded.success
  const { contentHash, ...material } = evidence
  const computedHash = canonicalHashV1Result(material)
  if (Result.isFailure(computedHash)) {
    return Result.fail({ _tag: 'Candidate18DevelopmentFailureEvidenceHashFailed', cause: computedHash.failure })
  }
  if (contentHash !== computedHash.success || contentHash !== candidate18DevelopmentFailureEvidenceContentHash) {
    return Result.fail({
      _tag: 'Candidate18DevelopmentFailureEvidenceContentHashMismatch',
      expected: candidate18DevelopmentFailureEvidenceContentHash,
      observed: contentHash,
    })
  }

  const bindings = [
    ['recordedAt', '2026-07-31T14:59:03.363Z', evidence.recordedAt],
    ['candidateOrdinal', 18, evidence.candidateOrdinal],
    ['priorTrialCount', 17, evidence.priorTrialCount],
    [
      'preregistration.sourceRevision',
      '30614640c5dfa7a7d50bf053df153062ff0bbca4',
      evidence.preregistration.sourceRevision,
    ],
    ['preregistration.blobOid', '920a4afb8a7e5c1f6ef0875683ddc96a91008079', evidence.preregistration.blobOid],
    [
      'verifiedSource.sourceRevision',
      '24465ada2b5e1e04c5058ad812b1eedd9f58b0dd',
      evidence.verifiedSource.sourceRevision,
    ],
    ['verifiedSource.moduleBlobOid', '44357f3d98315e7d241e4f0184f7812f5a27e930', evidence.verifiedSource.moduleBlobOid],
    [
      'verifiedSource.moduleSha256',
      '27466a8c9a9acba475db9cd0d2916532208540a53bd1f0ece307df299e5e34e8',
      evidence.verifiedSource.moduleSha256,
    ],
    [
      'verifiedSource.sourceManifestBlobOid',
      '3007c3e088f1a83228d5be672c232645fa2effa4',
      evidence.verifiedSource.sourceManifestBlobOid,
    ],
    [
      'verifiedSource.sourceManifestSha256',
      '636ca2e6280523eb18c06dea84f3c0d738f6995ba2eaa8bb97ca0b922e7d1f73',
      evidence.verifiedSource.sourceManifestSha256,
    ],
    [
      'verifiedSource.baselineRunId',
      '8b326d204d0c0cabbddcd477cd2c2c8b0adfc1d3ccd1b60bfaa4c5bfa1eccb2b',
      evidence.verifiedSource.baselineRunId,
    ],
    [
      'verifiedSource.stressedRunId',
      'cfe9c71f6cb0d0badf95f850c2194dc3ed57f5b8ca2f45383127863e6dd0060b',
      evidence.verifiedSource.stressedRunId,
    ],
    [
      'protocolBindings.strategyProtocolHash',
      '7e27320b47cd170c1bc9c60ec3692593f2182af44bb48cef4d4a403b09601d75',
      evidence.protocolBindings.strategyProtocolHash,
    ],
    [
      'protocolBindings.strategyIdentityHash',
      'ff762a985c129055670224dca5827a65c689f6f50e1e3765e7b521a05417b1f0',
      evidence.protocolBindings.strategyIdentityHash,
    ],
    [
      'protocolBindings.candidateDevelopmentProtocolHash',
      '46657425873b4f766b5f49d0ebbe2ac3aa9cf53682a8508635be708406271877',
      evidence.protocolBindings.candidateDevelopmentProtocolHash,
    ],
    [
      'protocolBindings.calendarHash',
      '4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237',
      evidence.protocolBindings.calendarHash,
    ],
    [
      'protocolBindings.priorTrialsHash',
      '58f4e801380f35f483f998e00c82889e0cb6257e85542764e2dc8eaa4f3fd419',
      evidence.protocolBindings.priorTrialsHash,
    ],
    [
      'protocolBindings.embeddedEvaluationProtocolHash',
      'fa25d8c16bc4f4fde3bab99409ae60a6fd23332d295b3557231796cebb911390',
      evidence.protocolBindings.embeddedEvaluationProtocolHash,
    ],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) return Result.fail(candidate18BindingMismatch(field, expected, observed))
  }
  if (evidence.protocolBindings.embeddedEvaluationProtocolHash === evidence.protocolBindings.strategyProtocolHash) {
    return Result.fail(
      candidate18BindingMismatch(
        'protocolBindings.embeddedEvaluationProtocolHash',
        'a distinct stale protocol hash that caused the fail-closed attempt',
        evidence.protocolBindings.embeddedEvaluationProtocolHash,
      ),
    )
  }
  return Result.succeed(evidence)
}

export const candidate18DevelopmentFailureEvidenceResult = pipe(
  rawEvidence,
  validateCandidate18DevelopmentFailureEvidence,
)

export const candidate18DevelopmentFailureEvidenceExpectation = {
  contentHash: candidate18DevelopmentFailureEvidenceContentHash,
  sourceRevision: '24465ada2b5e1e04c5058ad812b1eedd9f58b0dd',
  status: 'DEVELOPMENT_REJECTED',
  qualificationAttemptConsumed: false,
  nextCandidatePreregistration: null,
} as const
