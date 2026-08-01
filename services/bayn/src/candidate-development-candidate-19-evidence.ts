import rawSourceManifest from '../candidates/ordinal-19-inverse-volatility-risk-diversification-source-manifest.json' with { type: 'json' }

import { pipe, Result, Schema } from 'effect'

import { candidate19ArchiveReceipt } from './candidate-archive/legacy-candidate-receipts'
import { CandidateDevelopmentSourceManifestSchema } from './candidate-development-command'
import { canonicalHashV1Result, sha256, type CanonicalHashFailure } from './hash'
import {
  GitSourceRevisionSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'

const Candidate19VerifiedSourceSchema = Schema.Struct({
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

export const Candidate19DevelopmentFailureEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-attempt-failure-evidence.v2'),
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
  verifiedSource: Candidate19VerifiedSourceSchema,
  protocolBindings: Schema.Struct({
    strategyProtocolHash: Sha256Schema,
    strategyIdentityHash: Sha256Schema,
    candidateDevelopmentProtocolHash: Sha256Schema,
    calendarHash: Sha256Schema,
    priorTrialsHash: Sha256Schema,
  }),
  preMetricEvidence: Schema.Struct({
    exactSourceLoadSha256: Sha256Schema,
    preMetricDiagnosticSha256: Sha256Schema,
    registrationSourceManifestSha256: Sha256Schema,
    preflightStatus: Schema.Literal('PASS'),
    registrationStatus: Schema.Literal('PASS'),
  }),
  attempt: Schema.Struct({
    attemptedAt: UtcInstantSchema,
    finishedAt: UtcInstantSchema,
    stage: Schema.Literal('development-evaluation'),
    developmentMetricsObserved: Schema.Literal(true),
    developmentReportWritten: Schema.Literal(false),
    evaluationRerunAuthorized: Schema.Literal(false),
    exitCode: Schema.Literal(1),
    failure: Schema.Struct({
      _tag: Schema.Literal('CandidateDevelopmentCommandError'),
      structuredFailureRendered: Schema.Literal(false),
      disposition: Schema.Literal('DEFAULT_CLI_RENDERER_OMITTED_STRUCTURED_FAILURE'),
      capturedOutputPath: StrictNonEmptyStringSchema,
      capturedOutputSha256: Sha256Schema,
      capturedOutputBytes: PositiveIntegerSchema,
    }),
  }),
  contentHash: Sha256Schema,
})

export type Candidate19DevelopmentFailureEvidence = Schema.Schema.Type<
  typeof Candidate19DevelopmentFailureEvidenceSchema
>

export type Candidate19DevelopmentFailureEvidenceIssue =
  | { readonly _tag: 'Candidate19DevelopmentFailureEvidenceDecodeFailed'; readonly cause: unknown }
  | { readonly _tag: 'Candidate19DevelopmentFailureEvidenceHashFailed'; readonly cause: CanonicalHashFailure }
  | {
      readonly _tag: 'Candidate19DevelopmentFailureEvidenceContentHashMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'Candidate19DevelopmentFailureEvidenceBindingMismatch'
      readonly field: string
      readonly expected: unknown
      readonly observed: unknown
    }

const candidate19DevelopmentFailureEvidenceContentHash =
  '6170af41ddc14c04412a1929a60c88f35062ec2440f6e4b3beb0539bd411f364'

const decodeCandidate19DevelopmentFailureEvidenceBoundary = Schema.decodeUnknownResult(
  Candidate19DevelopmentFailureEvidenceSchema,
  strictParseOptions,
)

const candidate19BindingMismatch = (
  field: string,
  expected: unknown,
  observed: unknown,
): Candidate19DevelopmentFailureEvidenceIssue => ({
  _tag: 'Candidate19DevelopmentFailureEvidenceBindingMismatch',
  field,
  expected,
  observed,
})

export const validateCandidate19DevelopmentFailureEvidence = (
  value: unknown,
  capturedOutput?: string,
): Result.Result<Candidate19DevelopmentFailureEvidence, Candidate19DevelopmentFailureEvidenceIssue> => {
  const decoded = decodeCandidate19DevelopmentFailureEvidenceBoundary(value)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'Candidate19DevelopmentFailureEvidenceDecodeFailed', cause: decoded.failure })
  }
  const evidence = decoded.success
  const { contentHash, ...material } = evidence
  const computedHash = canonicalHashV1Result(material)
  if (Result.isFailure(computedHash)) {
    return Result.fail({ _tag: 'Candidate19DevelopmentFailureEvidenceHashFailed', cause: computedHash.failure })
  }
  if (contentHash !== computedHash.success || contentHash !== candidate19DevelopmentFailureEvidenceContentHash) {
    return Result.fail({
      _tag: 'Candidate19DevelopmentFailureEvidenceContentHashMismatch',
      expected: candidate19DevelopmentFailureEvidenceContentHash,
      observed: contentHash,
    })
  }

  const bindings = [
    ['recordedAt', candidate19ArchiveReceipt.facts.recordedAt, evidence.recordedAt],
    ['candidateOrdinal', 19, evidence.candidateOrdinal],
    ['priorTrialCount', 18, evidence.priorTrialCount],
    [
      'preregistration.sourceRevision',
      candidate19ArchiveReceipt.facts.preregistrationSourceRevision,
      evidence.preregistration.sourceRevision,
    ],
    ['preregistration.blobOid', '02d9150a1f0007a644a084b3fca4cd543131374e', evidence.preregistration.blobOid],
    [
      'verifiedSource.sourceRevision',
      candidate19ArchiveReceipt.facts.sourceRevision,
      evidence.verifiedSource.sourceRevision,
    ],
    ['verifiedSource.moduleBlobOid', 'cc06d8506ba408aa8e24436a6b60faeadfb96d23', evidence.verifiedSource.moduleBlobOid],
    [
      'verifiedSource.moduleSha256',
      '90813ab3a3d3cb000bb894309694f94588f98730a6f78b8e1418a5c38d8cb45f',
      evidence.verifiedSource.moduleSha256,
    ],
    [
      'verifiedSource.sourceManifestBlobOid',
      '4c34e00d3b9e695cf5b7977ddc635b522fc14e31',
      evidence.verifiedSource.sourceManifestBlobOid,
    ],
    [
      'verifiedSource.sourceManifestSha256',
      'e6c1556e16d31df727929fd883899debfad43c31ad21e964f5da33820429a6bc',
      evidence.verifiedSource.sourceManifestSha256,
    ],
    [
      'verifiedSource.baselineRunId',
      candidate19ArchiveReceipt.facts.baselineRunId,
      evidence.verifiedSource.baselineRunId,
    ],
    [
      'verifiedSource.stressedRunId',
      candidate19ArchiveReceipt.facts.stressedRunId,
      evidence.verifiedSource.stressedRunId,
    ],
    [
      'protocolBindings.strategyProtocolHash',
      candidate19ArchiveReceipt.facts.strategyProtocolHash,
      evidence.protocolBindings.strategyProtocolHash,
    ],
    [
      'protocolBindings.strategyIdentityHash',
      candidate19ArchiveReceipt.facts.strategyIdentityHash,
      evidence.protocolBindings.strategyIdentityHash,
    ],
    [
      'protocolBindings.candidateDevelopmentProtocolHash',
      candidate19ArchiveReceipt.facts.candidateDevelopmentProtocolHash,
      evidence.protocolBindings.candidateDevelopmentProtocolHash,
    ],
    [
      'protocolBindings.calendarHash',
      candidate19ArchiveReceipt.facts.calendarHash,
      evidence.protocolBindings.calendarHash,
    ],
    [
      'protocolBindings.priorTrialsHash',
      candidate19ArchiveReceipt.facts.priorTrialsHash,
      evidence.protocolBindings.priorTrialsHash,
    ],
    [
      'preMetricEvidence.exactSourceLoadSha256',
      candidate19ArchiveReceipt.facts.exactSourceLoadSha256,
      evidence.preMetricEvidence.exactSourceLoadSha256,
    ],
    [
      'preMetricEvidence.preMetricDiagnosticSha256',
      candidate19ArchiveReceipt.facts.preMetricDiagnosticSha256,
      evidence.preMetricEvidence.preMetricDiagnosticSha256,
    ],
    ['attempt.attemptedAt', candidate19ArchiveReceipt.facts.attemptedAt, evidence.attempt.attemptedAt],
    ['attempt.finishedAt', candidate19ArchiveReceipt.facts.recordedAt, evidence.attempt.finishedAt],
    [
      'attempt.failure.capturedOutputPath',
      candidate19ArchiveReceipt.facts.capturedOutputPath,
      evidence.attempt.failure.capturedOutputPath,
    ],
    [
      'attempt.failure.capturedOutputSha256',
      candidate19ArchiveReceipt.facts.capturedOutputSha256,
      evidence.attempt.failure.capturedOutputSha256,
    ],
    [
      'attempt.failure.capturedOutputBytes',
      candidate19ArchiveReceipt.facts.capturedOutputBytes,
      evidence.attempt.failure.capturedOutputBytes,
    ],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) return Result.fail(candidate19BindingMismatch(field, expected, observed))
  }

  const manifestHashes = Result.all({
    expected: canonicalHashV1Result(rawSourceManifest),
    observed: canonicalHashV1Result(evidence.verifiedSource.sourceManifest),
  })
  if (Result.isFailure(manifestHashes)) {
    return Result.fail({ _tag: 'Candidate19DevelopmentFailureEvidenceHashFailed', cause: manifestHashes.failure })
  }
  if (manifestHashes.success.expected !== manifestHashes.success.observed) {
    return Result.fail(
      candidate19BindingMismatch(
        'verifiedSource.sourceManifest',
        manifestHashes.success.expected,
        manifestHashes.success.observed,
      ),
    )
  }

  if (capturedOutput !== undefined) {
    const capturedOutputHash = sha256(capturedOutput)
    if (capturedOutputHash !== evidence.attempt.failure.capturedOutputSha256) {
      return Result.fail(
        candidate19BindingMismatch(
          'attempt.failure.capturedOutputSha256',
          evidence.attempt.failure.capturedOutputSha256,
          capturedOutputHash,
        ),
      )
    }
    const capturedOutputBytes = Buffer.byteLength(capturedOutput)
    if (capturedOutputBytes !== evidence.attempt.failure.capturedOutputBytes) {
      return Result.fail(
        candidate19BindingMismatch(
          'attempt.failure.capturedOutputBytes',
          evidence.attempt.failure.capturedOutputBytes,
          capturedOutputBytes,
        ),
      )
    }
  }

  return Result.succeed(evidence)
}

const candidate19EvidenceArtifact = candidate19ArchiveReceipt.historicalArtifacts.find(
  ({ kind }) => kind === 'development-evidence',
)
const candidate19PreregistrationArtifact = candidate19ArchiveReceipt.historicalArtifacts.find(
  ({ kind }) => kind === 'preregistration',
)
const candidate19SourceManifestArtifact = candidate19ArchiveReceipt.historicalArtifacts.find(
  ({ kind }) => kind === 'source-manifest',
)

if (
  candidate19EvidenceArtifact === undefined ||
  candidate19PreregistrationArtifact === undefined ||
  candidate19SourceManifestArtifact === undefined
) {
  throw new Error('Candidate 19 archive receipt is missing a required historical artifact')
}

const candidate19HistoricalEvidence = {
  schemaVersion: 'bayn.candidate-development-attempt-failure-evidence.v2' as const,
  recordedAt: candidate19ArchiveReceipt.facts.recordedAt,
  candidateOrdinal: 19,
  priorTrialCount: 18,
  status: 'DEVELOPMENT_REJECTED' as const,
  qualificationAttemptConsumed: false as const,
  nextCandidatePreregistration: null,
  preregistration: {
    sourceRevision: candidate19ArchiveReceipt.facts.preregistrationSourceRevision,
    path: candidate19PreregistrationArtifact.path,
    blobOid: candidate19PreregistrationArtifact.blobOid,
  },
  verifiedSource: {
    schemaVersion: 'bayn.candidate-development-verified-source.v1' as const,
    sourceRevision: candidate19ArchiveReceipt.facts.sourceRevision,
    modulePath: 'services/bayn/src/strategy/inverse-volatility-risk-diversification/candidate-19.ts',
    moduleBlobOid: 'cc06d8506ba408aa8e24436a6b60faeadfb96d23',
    moduleSha256: '90813ab3a3d3cb000bb894309694f94588f98730a6f78b8e1418a5c38d8cb45f',
    sourceManifestPath: candidate19SourceManifestArtifact.path,
    sourceManifestBlobOid: candidate19SourceManifestArtifact.blobOid,
    sourceManifestSha256: candidate19SourceManifestArtifact.sha256,
    sourceManifest: rawSourceManifest,
    baselineRunId: candidate19ArchiveReceipt.facts.baselineRunId,
    stressedRunId: candidate19ArchiveReceipt.facts.stressedRunId,
  },
  protocolBindings: {
    strategyProtocolHash: candidate19ArchiveReceipt.facts.strategyProtocolHash,
    strategyIdentityHash: candidate19ArchiveReceipt.facts.strategyIdentityHash,
    candidateDevelopmentProtocolHash: candidate19ArchiveReceipt.facts.candidateDevelopmentProtocolHash,
    calendarHash: candidate19ArchiveReceipt.facts.calendarHash,
    priorTrialsHash: candidate19ArchiveReceipt.facts.priorTrialsHash,
  },
  preMetricEvidence: {
    exactSourceLoadSha256: candidate19ArchiveReceipt.facts.exactSourceLoadSha256,
    preMetricDiagnosticSha256: candidate19ArchiveReceipt.facts.preMetricDiagnosticSha256,
    registrationSourceManifestSha256: candidate19ArchiveReceipt.facts.registrationSourceManifestSha256,
    preflightStatus: 'PASS' as const,
    registrationStatus: 'PASS' as const,
  },
  attempt: {
    attemptedAt: candidate19ArchiveReceipt.facts.attemptedAt,
    finishedAt: candidate19ArchiveReceipt.facts.recordedAt,
    stage: 'development-evaluation' as const,
    developmentMetricsObserved: true as const,
    developmentReportWritten: false as const,
    evaluationRerunAuthorized: false as const,
    exitCode: 1 as const,
    failure: {
      _tag: 'CandidateDevelopmentCommandError' as const,
      structuredFailureRendered: false as const,
      disposition: 'DEFAULT_CLI_RENDERER_OMITTED_STRUCTURED_FAILURE' as const,
      capturedOutputPath: candidate19ArchiveReceipt.facts.capturedOutputPath,
      capturedOutputSha256: candidate19ArchiveReceipt.facts.capturedOutputSha256,
      capturedOutputBytes: candidate19ArchiveReceipt.facts.capturedOutputBytes,
    },
  },
  contentHash: candidate19ArchiveReceipt.facts.evidenceContentHash,
} as const

export const candidate19DevelopmentFailureEvidenceResult = pipe(
  candidate19HistoricalEvidence,
  validateCandidate19DevelopmentFailureEvidence,
)

export const candidate19DevelopmentFailureEvidenceExpectation = {
  contentHash: candidate19DevelopmentFailureEvidenceContentHash,
  sourceRevision: '276805b77d783db907dcb86cba934d7a4f6a0147',
  status: 'DEVELOPMENT_REJECTED',
  developmentMetricsObserved: true,
  qualificationAttemptConsumed: false,
  nextCandidatePreregistration: null,
} as const
