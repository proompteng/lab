import { Schema } from 'effect'

import { EvaluationBoundsSchema, IsoDateSchema, Sha256Schema } from './contracts'
import { canonicalHashV1, canonicalJsonV1 } from './hash'

const StrictParseOptions = { onExcessProperty: 'error' } as const
const NonEmptyString = Schema.String.check(
  Schema.makeFilter((value: string) => value.length > 0 && value.trim() === value, {
    expected: 'a non-empty string without surrounding whitespace',
  }),
)
const SourceRevision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const SymbolName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,15}$/))
const MinimumSessions = Schema.Int.check(Schema.isGreaterThanOrEqualTo(504))
const MinimumRebalances = Schema.Int.check(Schema.isGreaterThanOrEqualTo(24))
const CanonicalJson = Schema.Unknown.check(
  Schema.makeFilter(
    (value: unknown) => {
      try {
        canonicalJsonV1(value)
        return true
      } catch {
        return false
      }
    },
    { expected: 'a canonical JSON value' },
  ),
)

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

const QualificationDataBase = Schema.Struct({
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
})

export const QualificationDataSchema = QualificationDataBase.check(
  Schema.makeFilter((data: typeof QualificationDataBase.Type) => {
    const issues: Schema.FilterIssue[] = []
    if (data.firstSession > data.lastSession) {
      issues.push({ path: ['firstSession'], issue: 'must not be after lastSession' })
    }
    if (data.bounds.dataStart < data.firstSession || data.bounds.dataEnd > data.lastSession) {
      issues.push({ path: ['bounds'], issue: 'must be contained by the finalized snapshot' })
    }
    return issues
  }),
)

const QualificationLockMaterialBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-lock.v1'),
  protocolHash: Sha256Schema,
  sourceRevision: SourceRevision,
  image: Schema.Struct({
    repository: NonEmptyString,
    digest: ImageDigest,
  }),
  universe: Schema.Array(SymbolName).check(Schema.isMinLength(1)),
  universeRationale: NonEmptyString,
  data: QualificationDataSchema,
  policies: Schema.Struct({
    benchmark: QualificationPolicyDocumentSchema,
    thresholds: QualificationPolicyDocumentSchema,
    uncertainty: QualificationPolicyDocumentSchema,
    execution: QualificationPolicyDocumentSchema,
  }),
  priorTrialRunIds: Schema.Array(Sha256Schema),
})

const canonicalListIssues = (path: string, values: readonly string[]): readonly Schema.FilterIssue[] => {
  const canonical = [...new Set(values)].sort()
  if (canonical.length !== values.length) return [{ path: [path], issue: 'must not contain duplicates' }]
  if (canonical.some((value, index) => value !== values[index])) {
    return [{ path: [path], issue: 'must be sorted in canonical order' }]
  }
  return []
}

export const QualificationLockMaterialSchema = QualificationLockMaterialBase.check(
  Schema.makeFilter((lock: typeof QualificationLockMaterialBase.Type) => [
    ...canonicalListIssues('universe', lock.universe),
    ...canonicalListIssues('priorTrialRunIds', lock.priorTrialRunIds),
  ]),
)
export type QualificationLockMaterial = typeof QualificationLockMaterialSchema.Type

const QualificationLockBase = Schema.Struct({
  ...QualificationLockMaterialBase.fields,
  lockId: Sha256Schema,
})

export const QualificationLockSchema = QualificationLockBase.check(
  Schema.makeFilter((lock: typeof QualificationLockBase.Type) => {
    const { lockId, ...material } = lock
    const issues = [
      ...canonicalListIssues('universe', material.universe),
      ...canonicalListIssues('priorTrialRunIds', material.priorTrialRunIds),
    ]
    if (lockId !== canonicalHashV1(material)) {
      issues.push({ path: ['lockId'], issue: 'must match the canonical lock material hash' })
    }
    return issues
  }),
)
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
