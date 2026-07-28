import { Schema } from 'effect'

import { EvaluationBoundsSchema, IsoDateSchema, Sha256Schema } from '../contracts'
import { sha256 } from '../hash'
import { QualificationAnalysisSchema } from '../qualification-statistics/model'
import { canonicalOrderIssues } from '../qualification-statistics/ordering'
import {
  ImageDigestSchema as ImageDigest,
  SourceRevisionSchema as SourceRevision,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
  UniverseIdSchema,
} from '../schemas'
import { canonicalHashMatches } from './hashing'

const MinimumSessions = Schema.Int.check(Schema.isGreaterThanOrEqualTo(504))
const MinimumRebalances = Schema.Int.check(Schema.isGreaterThanOrEqualTo(24))
const CanonicalJson = Schema.Unknown.check(Schema.makeFilter(Schema.is(Schema.Json), { expected: 'a JSON value' }))

const PolicyDocumentBase = Schema.Struct({
  schemaVersion: NonEmptyString,
  contentHash: Sha256Schema,
  content: CanonicalJson,
})

export const QualificationPolicyDocumentSchema = PolicyDocumentBase.check(
  Schema.makeFilter(
    (document: typeof PolicyDocumentBase.Type) =>
      canonicalHashMatches(document.contentHash, document.content) ||
      ({ path: ['contentHash'], issue: 'must match the canonical policy content hash' } as const),
  ),
)
export type QualificationPolicyDocument = typeof QualificationPolicyDocumentSchema.Type

const QualificationDataFields = {
  snapshotId: Sha256Schema,
  publicationId: Sha256Schema,
  contentHash: Sha256Schema,
  sessionsContentHash: Sha256Schema,
  provider: NonEmptyString,
  sourceFeed: NonEmptyString,
  adjustment: NonEmptyString,
  calendarVersion: NonEmptyString,
  firstSession: IsoDateSchema,
  lastSession: IsoDateSchema,
  selectedSessionCount: MinimumSessions,
  selectedRebalanceCount: MinimumRebalances,
  bounds: EvaluationBoundsSchema,
} as const

const QualificationDataBase = Schema.Struct({
  ...QualificationDataFields,
  inputManifestHash: Sha256Schema,
})

const qualificationDataIssues = (data: typeof QualificationDataBase.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (data.firstSession > data.lastSession) {
    issues.push({ path: ['firstSession'], issue: 'must not be after lastSession' })
  }
  if (data.bounds.dataStart < data.firstSession || data.bounds.dataEnd > data.lastSession) {
    issues.push({ path: ['bounds'], issue: 'must be contained by the finalized snapshot' })
  }
  return issues
}

export const QualificationDataSchema = QualificationDataBase.check(Schema.makeFilter(qualificationDataIssues))

const QualificationLockMaterialFields = {
  candidateRunId: Sha256Schema,
  protocolHash: Sha256Schema,
  sourceRevision: SourceRevision,
  image: Schema.Struct({
    repository: NonEmptyString,
    digest: ImageDigest,
  }),
  universe: Schema.Array(SymbolName).check(Schema.isMinLength(1)),
  universeRationale: NonEmptyString,
  policies: Schema.Struct({
    benchmark: QualificationPolicyDocumentSchema,
    thresholds: QualificationPolicyDocumentSchema,
    uncertainty: QualificationPolicyDocumentSchema,
    execution: QualificationPolicyDocumentSchema,
  }),
  priorTrialRunIds: Schema.Array(Sha256Schema),
} as const

const QualificationLockMaterialBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-lock.v3'),
  ...QualificationLockMaterialFields,
  universeId: UniverseIdSchema,
  universeSymbolHash: Sha256Schema,
  data: QualificationDataSchema,
})

const lockMaterialIssues = (lock: typeof QualificationLockMaterialBase.Type): readonly Schema.FilterIssue[] => {
  const issues = [
    ...canonicalOrderIssues('universe', lock.universe),
    ...canonicalOrderIssues('priorTrialRunIds', lock.priorTrialRunIds),
  ]
  if (lock.universeSymbolHash !== sha256(lock.universe.join(','))) {
    issues.push({ path: ['universeSymbolHash'], issue: 'must match the canonical universe' })
  }
  return issues
}

export const QualificationLockMaterialSchema = QualificationLockMaterialBase.check(
  Schema.makeFilter(lockMaterialIssues),
)
export type QualificationLockMaterial = typeof QualificationLockMaterialSchema.Type

const QualificationLockBase = Schema.Struct({
  ...QualificationLockMaterialBase.fields,
  lockId: Sha256Schema,
})

const qualificationLockIssues = (lock: typeof QualificationLockBase.Type): readonly Schema.FilterIssue[] => {
  const { lockId, ...material } = lock
  const issues = [...lockMaterialIssues(material)]
  if (!canonicalHashMatches(lockId, material)) {
    issues.push({ path: ['lockId'], issue: 'must match the canonical lock material hash' })
  }
  return issues
}

export const QualificationLockSchema = QualificationLockBase.check(Schema.makeFilter(qualificationLockIssues))
export type QualificationLock = typeof QualificationLockSchema.Type

const GateScalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String])
const EconomicVerdictSchema = Schema.Struct({
  status: Schema.Literals(['PASS', 'FAIL_CLOSED']),
  gates: Schema.Array(
    Schema.Struct({
      name: NonEmptyString,
      passed: Schema.Boolean,
      actual: GateScalar,
      required: GateScalar,
    }),
  ).check(Schema.isMinLength(1)),
})

export const QualificationResultMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-result.v2'),
  lockId: Sha256Schema,
  runId: Sha256Schema,
  verdict: Schema.Literals(['QUALIFIED', 'REJECTED']),
  evaluationVerdict: EconomicVerdictSchema,
  analysis: QualificationAnalysisSchema,
  reasonCodes: Schema.Array(NonEmptyString),
})

const QualificationResultBase = Schema.Struct({
  ...QualificationResultMaterialSchema.fields,
  resultHash: Sha256Schema,
})

export const QualificationResultSchema = QualificationResultBase.check(
  Schema.makeFilter((result: typeof QualificationResultBase.Type) => {
    const { resultHash, ...material } = result
    const economicPass = result.evaluationVerdict.gates.every((gate) => gate.passed)
    const shouldQualify = economicPass && result.analysis.status === 'PASS'
    const issues: Schema.FilterIssue[] = [...canonicalOrderIssues('reasonCodes', result.reasonCodes)]
    if (result.runId !== result.analysis.runId) {
      issues.push({ path: ['runId'], issue: 'must match the statistical analysis run ID' })
    }
    if (result.verdict !== (shouldQualify ? 'QUALIFIED' : 'REJECTED')) {
      issues.push({ path: ['verdict'], issue: 'must match the economic and statistical gates' })
    }
    if (result.evaluationVerdict.status !== (economicPass ? 'PASS' : 'FAIL_CLOSED')) {
      issues.push({ path: ['evaluationVerdict', 'status'], issue: 'must match every economic gate outcome' })
    }
    if ((shouldQualify && result.reasonCodes.length !== 0) || (!shouldQualify && result.reasonCodes.length === 0)) {
      issues.push({ path: ['reasonCodes'], issue: 'must explain every rejection and be empty only when qualified' })
    }
    if (!canonicalHashMatches(resultHash, material)) {
      issues.push({ path: ['resultHash'], issue: 'must match the canonical result content hash' })
    }
    return issues
  }),
)
export type QualificationResult = typeof QualificationResultSchema.Type

export const qualificationResultReasonCode = (name: string): string =>
  `EVALUATION_${name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}_FAILED`

export const qualificationResultReasonsAreCanonical = (reasonCodes: readonly string[]): boolean =>
  canonicalOrderIssues('reasonCodes', reasonCodes).length === 0
