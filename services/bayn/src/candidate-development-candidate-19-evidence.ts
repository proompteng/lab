import { readFileSync } from 'node:fs'

import rawEvidence from '../candidates/ordinal-19-inverse-volatility-risk-diversification-development-evidence.json' with { type: 'json' }
import rawSourceManifest from '../candidates/ordinal-19-inverse-volatility-risk-diversification-source-manifest.json' with { type: 'json' }

import { pipe, Result, Schema } from 'effect'

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

const candidate19AttemptOutputPath =
  'services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-development-attempt.log'

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
  capturedOutput: string,
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
    ['recordedAt', '2026-07-31T17:24:03.530Z', evidence.recordedAt],
    ['candidateOrdinal', 19, evidence.candidateOrdinal],
    ['priorTrialCount', 18, evidence.priorTrialCount],
    [
      'preregistration.sourceRevision',
      'bb24ec2ab4225b13920a2b50fb137c4134d2d75f',
      evidence.preregistration.sourceRevision,
    ],
    ['preregistration.blobOid', '02d9150a1f0007a644a084b3fca4cd543131374e', evidence.preregistration.blobOid],
    [
      'verifiedSource.sourceRevision',
      '276805b77d783db907dcb86cba934d7a4f6a0147',
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
      '28b3e80d0d817a2883e86c448851da9ef5b7d6bacd601cca0d314e7fc366bfab',
      evidence.verifiedSource.baselineRunId,
    ],
    [
      'verifiedSource.stressedRunId',
      '8ee52762be3fe38b71dcef30f8b07a123eeb79ca155c8919b67f42239dffa07f',
      evidence.verifiedSource.stressedRunId,
    ],
    [
      'protocolBindings.strategyProtocolHash',
      'b4a2a6c65a7fa5973f7cbc1fd5031e77d529f4884562e5cc8a105fc870ced78f',
      evidence.protocolBindings.strategyProtocolHash,
    ],
    [
      'protocolBindings.strategyIdentityHash',
      'ccf8f03db1f0f9eb54f7ad42194c938e5a53e11573488fd31e7af871967af25a',
      evidence.protocolBindings.strategyIdentityHash,
    ],
    [
      'protocolBindings.candidateDevelopmentProtocolHash',
      '663b59d6c570bbe3373d6e160609e0ad6294a687f435416f2a0956888d960738',
      evidence.protocolBindings.candidateDevelopmentProtocolHash,
    ],
    [
      'protocolBindings.calendarHash',
      '4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237',
      evidence.protocolBindings.calendarHash,
    ],
    [
      'protocolBindings.priorTrialsHash',
      '1dfc9b6832d4841093becd2c276141110afdfce28a0a88b301cfe9959b900d62',
      evidence.protocolBindings.priorTrialsHash,
    ],
    [
      'preMetricEvidence.exactSourceLoadSha256',
      '4d3274ac428093ecc52a17669af5d1c677a05f25052065fe1a9a58f821e4dd3e',
      evidence.preMetricEvidence.exactSourceLoadSha256,
    ],
    [
      'preMetricEvidence.preMetricDiagnosticSha256',
      'fd3682f152ed1c72e7e3aea0ba20f0694ae98f9857fa117ff8626815b0e533a8',
      evidence.preMetricEvidence.preMetricDiagnosticSha256,
    ],
    ['attempt.attemptedAt', '2026-07-31T17:23:55.178Z', evidence.attempt.attemptedAt],
    ['attempt.finishedAt', '2026-07-31T17:24:03.530Z', evidence.attempt.finishedAt],
    ['attempt.failure.capturedOutputPath', candidate19AttemptOutputPath, evidence.attempt.failure.capturedOutputPath],
    [
      'attempt.failure.capturedOutputSha256',
      '702aed20f08899cf84500e67321cce42b24d1425595f3fa9f313aea46224d3c1',
      evidence.attempt.failure.capturedOutputSha256,
    ],
    ['attempt.failure.capturedOutputBytes', 1268, evidence.attempt.failure.capturedOutputBytes],
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

  return Result.succeed(evidence)
}

const candidate19AttemptOutput = readFileSync(
  new URL('../candidates/ordinal-19-inverse-volatility-risk-diversification-development-attempt.log', import.meta.url),
  'utf8',
)

export const candidate19DevelopmentFailureEvidenceResult = pipe(rawEvidence, (value) =>
  validateCandidate19DevelopmentFailureEvidence(value, candidate19AttemptOutput),
)

export const candidate19DevelopmentFailureEvidenceExpectation = {
  contentHash: candidate19DevelopmentFailureEvidenceContentHash,
  sourceRevision: '276805b77d783db907dcb86cba934d7a4f6a0147',
  status: 'DEVELOPMENT_REJECTED',
  developmentMetricsObserved: true,
  qualificationAttemptConsumed: false,
  nextCandidatePreregistration: null,
} as const
