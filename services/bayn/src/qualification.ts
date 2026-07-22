import { Schema } from 'effect'

import { EvaluationBoundsSchema, IsoDateSchema, Sha256Schema } from './contracts'
import { canonicalHashV1, sha256 } from './hash'
import {
  QualificationAnalysisSchema,
  defaultQualificationStatisticsPolicy,
  type QualificationAnalysis,
} from './qualification-statistics'
import {
  ImageDigestSchema as ImageDigest,
  SourceRevisionSchema as SourceRevision,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
  strictParseOptions as StrictParseOptions,
} from './schemas'
import type { EconomicVerdict } from './types'

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
      document.contentHash === canonicalHashV1(document.content) ||
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
  universeId: Schema.Literal('equity-infrastructure-v1'),
  universeSymbolHash: Sha256Schema,
  data: QualificationDataSchema,
})

const canonicalListIssues = (path: string, values: readonly string[]): readonly Schema.FilterIssue[] => {
  const canonical = [...new Set(values)].sort()
  if (canonical.length !== values.length) return [{ path: [path], issue: 'must not contain duplicates' }]
  if (canonical.some((value, index) => value !== values[index])) {
    return [{ path: [path], issue: 'must be sorted in canonical order' }]
  }
  return []
}

const lockMaterialIssues = (lock: typeof QualificationLockMaterialBase.Type): readonly Schema.FilterIssue[] => {
  const issues = [
    ...canonicalListIssues('universe', lock.universe),
    ...canonicalListIssues('priorTrialRunIds', lock.priorTrialRunIds),
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
  if (lockId !== canonicalHashV1(material)) {
    issues.push({ path: ['lockId'], issue: 'must match the canonical lock material hash' })
  }
  return issues
}

export const QualificationLockSchema = QualificationLockBase.check(Schema.makeFilter(qualificationLockIssues))
export type QualificationLock = typeof QualificationLockSchema.Type

const decodePolicyDocumentSync = Schema.decodeUnknownSync(QualificationPolicyDocumentSchema, StrictParseOptions)
const decodeLockMaterialSync = Schema.decodeUnknownSync(QualificationLockMaterialSchema, StrictParseOptions)
const decodeLockSync = Schema.decodeUnknownSync(QualificationLockSchema, StrictParseOptions)

export const makeQualificationPolicyDocument = (schemaVersion: string, content: unknown): QualificationPolicyDocument =>
  decodePolicyDocumentSync({
    schemaVersion,
    contentHash: canonicalHashV1(content),
    content,
  })

export const makeQualificationLock = (input: QualificationLockMaterial): QualificationLock => {
  const material = decodeLockMaterialSync(input)
  return decodeLockSync({ ...material, lockId: canonicalHashV1(material) })
}

export const defaultQualificationStatisticsPolicyDocument = makeQualificationPolicyDocument(
  defaultQualificationStatisticsPolicy.schemaVersion,
  defaultQualificationStatisticsPolicy,
)

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

const QualificationResultMaterial = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-result.v2'),
  lockId: Sha256Schema,
  runId: Sha256Schema,
  verdict: Schema.Literals(['QUALIFIED', 'REJECTED']),
  evaluationVerdict: EconomicVerdictSchema,
  analysis: QualificationAnalysisSchema,
  reasonCodes: Schema.Array(NonEmptyString),
})

const QualificationResultBase = Schema.Struct({
  ...QualificationResultMaterial.fields,
  resultHash: Sha256Schema,
})

export const QualificationResultSchema = QualificationResultBase.check(
  Schema.makeFilter((result: typeof QualificationResultBase.Type) => {
    const { resultHash, ...material } = result
    const economicPass = result.evaluationVerdict.gates.every((gate) => gate.passed)
    const shouldQualify = economicPass && result.analysis.status === 'PASS'
    const issues: Schema.FilterIssue[] = [...canonicalListIssues('reasonCodes', result.reasonCodes)]
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
    if (resultHash !== canonicalHashV1(material)) {
      issues.push({ path: ['resultHash'], issue: 'must match the canonical result content hash' })
    }
    return issues
  }),
)
export type QualificationResult = typeof QualificationResultSchema.Type

const resultReason = (name: string): string =>
  `EVALUATION_${name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}_FAILED`

const decodeResultSync = Schema.decodeUnknownSync(QualificationResultSchema, StrictParseOptions)

export const makeQualificationResult = (
  lock: QualificationLock,
  evaluationVerdict: EconomicVerdict,
  analysis: QualificationAnalysis,
): QualificationResult => {
  if (lock.candidateRunId !== analysis.runId) {
    throw new TypeError('qualification lock, candidate, and analysis run IDs must match')
  }
  if (canonicalHashV1(lock.priorTrialRunIds) !== canonicalHashV1(analysis.priorTrialRunIds)) {
    throw new TypeError('qualification analysis must use the locked prior-trial lineage')
  }
  const economicReasons = evaluationVerdict.gates.filter((gate) => !gate.passed).map((gate) => resultReason(gate.name))
  const reasonCodes = [...new Set([...economicReasons, ...analysis.reasonCodes])].sort()
  const material = {
    schemaVersion: 'bayn.qualification-result.v2' as const,
    lockId: lock.lockId,
    runId: lock.candidateRunId,
    verdict:
      evaluationVerdict.status === 'PASS' && analysis.status === 'PASS'
        ? ('QUALIFIED' as const)
        : ('REJECTED' as const),
    evaluationVerdict,
    analysis,
    reasonCodes,
  }
  return decodeResultSync({ ...material, resultHash: canonicalHashV1(material) })
}
