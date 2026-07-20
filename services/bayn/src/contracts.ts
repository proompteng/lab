import { Schema } from 'effect'

import { canonicalHashV1, canonicalJsonV1 } from './hash'

const StrictParseOptions = { onExcessProperty: 'error' } as const

const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const isUtcInstant = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

const canCanonicalize = (value: unknown): boolean => {
  try {
    canonicalJsonV1(value)
    return true
  } catch {
    return false
  }
}

const NonEmptyString = Schema.String.check(
  Schema.makeFilter((value: string) => value.length > 0 && value.trim() === value, {
    expected: 'a non-empty string without surrounding whitespace',
  }),
)
const IsoDate = Schema.String.check(Schema.makeFilter(isIsoDate, { expected: 'a valid ISO date (YYYY-MM-DD)' }))
const UtcInstant = Schema.String.check(
  Schema.makeFilter(isUtcInstant, { expected: 'a canonical UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ)' }),
)
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const SourceRevision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const SymbolName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,15}$/))
const CanonicalJson = Schema.Unknown.check(Schema.makeFilter(canCanonicalize, { expected: 'a canonical JSON value' }))

const FinalizedSnapshotBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.finalized-snapshot.v1'),
  snapshotId: Sha256,
  publicationId: NonEmptyString,
  datasetVersion: NonEmptyString,
  source: NonEmptyString,
  sourceFeed: NonEmptyString,
  adjustment: NonEmptyString,
  calendarVersion: NonEmptyString,
  publishedAt: UtcInstant,
  finalizedAt: UtcInstant,
  firstSession: IsoDate,
  lastSession: IsoDate,
  asOfSession: IsoDate,
  symbols: Schema.Array(SymbolName).check(Schema.isMinLength(1)),
  rowCount: PositiveInteger,
  contentHash: Sha256,
})

export const FinalizedSnapshotProvenanceSchema = FinalizedSnapshotBase.check(
  Schema.makeFilter((snapshot: typeof FinalizedSnapshotBase.Type) => {
    const issues: Schema.FilterIssue[] = []
    if (snapshot.firstSession > snapshot.lastSession) {
      issues.push({ path: ['firstSession'], issue: 'must not be after lastSession' })
    }
    if (snapshot.asOfSession !== snapshot.lastSession) {
      issues.push({ path: ['asOfSession'], issue: 'must equal lastSession for a finalized snapshot' })
    }
    if (snapshot.finalizedAt > snapshot.publishedAt) {
      issues.push({ path: ['finalizedAt'], issue: 'must not be after publishedAt' })
    }
    if (snapshot.rowCount < snapshot.symbols.length) {
      issues.push({ path: ['rowCount'], issue: 'must contain at least one row per symbol' })
    }
    const canonicalSymbols = [...new Set(snapshot.symbols)].sort()
    if (canonicalSymbols.length !== snapshot.symbols.length) {
      issues.push({ path: ['symbols'], issue: 'must not contain duplicate symbols' })
    } else if (canonicalSymbols.some((symbol, index) => symbol !== snapshot.symbols[index])) {
      issues.push({ path: ['symbols'], issue: 'must be sorted in canonical order' })
    }
    return issues
  }),
)
export type FinalizedSnapshotProvenance = typeof FinalizedSnapshotProvenanceSchema.Type

const EvaluationBoundsBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.evaluation-bounds.v1'),
  dataStart: IsoDate,
  dataEnd: IsoDate,
  lookbackStart: IsoDate,
  evaluationStart: IsoDate,
  evaluationEnd: IsoDate,
})

export const EvaluationBoundsSchema = EvaluationBoundsBase.check(
  Schema.makeFilter((bounds: typeof EvaluationBoundsBase.Type) => {
    const issues: Schema.FilterIssue[] = []
    if (bounds.dataStart > bounds.dataEnd) {
      issues.push({ path: ['dataStart'], issue: 'must not be after dataEnd' })
    }
    if (bounds.lookbackStart < bounds.dataStart) {
      issues.push({ path: ['lookbackStart'], issue: 'must not precede dataStart' })
    }
    if (bounds.evaluationStart < bounds.lookbackStart) {
      issues.push({ path: ['evaluationStart'], issue: 'must not precede lookbackStart' })
    }
    if (bounds.evaluationEnd < bounds.evaluationStart) {
      issues.push({ path: ['evaluationEnd'], issue: 'must not precede evaluationStart' })
    }
    if (bounds.evaluationEnd > bounds.dataEnd) {
      issues.push({ path: ['evaluationEnd'], issue: 'must not follow dataEnd' })
    }
    return issues
  }),
)
export type EvaluationBounds = typeof EvaluationBoundsSchema.Type

const RunIdentityFields = {
  schemaVersion: Schema.Literal('bayn.run-identity.v1'),
  sourceRevision: SourceRevision,
  image: Schema.Struct({
    repository: NonEmptyString,
    digest: ImageDigest,
  }),
  strategy: Schema.Struct({
    name: NonEmptyString,
    behaviorHash: Sha256,
    parameters: CanonicalJson,
  }),
  finalizedSnapshot: FinalizedSnapshotProvenanceSchema,
  calendarVersion: NonEmptyString,
  bounds: EvaluationBoundsSchema,
} as const

const RunIdentityMaterialBase = Schema.Struct(RunIdentityFields)

const runIdentityMaterialIssues = (material: typeof RunIdentityMaterialBase.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (material.calendarVersion !== material.finalizedSnapshot.calendarVersion) {
    issues.push({ path: ['calendarVersion'], issue: 'must match finalizedSnapshot.calendarVersion' })
  }
  if (material.bounds.dataStart < material.finalizedSnapshot.firstSession) {
    issues.push({ path: ['bounds', 'dataStart'], issue: 'is outside the finalized snapshot' })
  }
  if (material.bounds.dataEnd > material.finalizedSnapshot.asOfSession) {
    issues.push({ path: ['bounds', 'dataEnd'], issue: 'is outside the finalized snapshot' })
  }
  return issues
}

export const RunIdentityMaterialSchema = RunIdentityMaterialBase.check(Schema.makeFilter(runIdentityMaterialIssues))
export type RunIdentityMaterial = typeof RunIdentityMaterialSchema.Type

const RunIdentityBase = Schema.Struct({ ...RunIdentityFields, runId: Sha256 })

export const RunIdentitySchema = RunIdentityBase.check(
  Schema.makeFilter((identity: typeof RunIdentityBase.Type) => {
    const { runId, ...material } = identity
    const issues = [...runIdentityMaterialIssues(material)]
    if (runId !== canonicalHashV1(material)) {
      issues.push({ path: ['runId'], issue: 'does not match the identity material' })
    }
    return issues
  }),
)
export type RunIdentity = typeof RunIdentitySchema.Type

const EvidenceFreshnessBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.evidence-freshness.v1'),
  observedAt: UtcInstant,
  validThrough: UtcInstant,
})

export const EvidenceFreshnessSchema = EvidenceFreshnessBase.check(
  Schema.makeFilter(
    (freshness: typeof EvidenceFreshnessBase.Type) =>
      freshness.observedAt <= freshness.validThrough ||
      ({ path: ['validThrough'], issue: 'must not precede observedAt' } as const),
  ),
)
export type EvidenceFreshness = typeof EvidenceFreshnessSchema.Type

export const OperationalStateSchema = Schema.Literals(['STARTING', 'RUNNING', 'STOPPING', 'FAILED'])
export const DependencyStateSchema = Schema.Literals(['UNKNOWN', 'AVAILABLE', 'UNAVAILABLE'])
export const DataStateSchema = Schema.Literals(['UNKNOWN', 'FRESH', 'STALE', 'INVALID'])
export const EvidenceStateSchema = Schema.Literals(['UNKNOWN', 'CURRENT', 'STALE', 'INVALID'])
export const EconomicStateSchema = Schema.Literals(['UNKNOWN', 'QUALIFIED', 'REJECTED'])
export const ReconciliationStateSchema = Schema.Literals(['UNKNOWN', 'EXACT', 'DISCREPANCY'])
export const KillStateSchema = Schema.Literals(['UNKNOWN', 'CLEAR', 'ENGAGED'])
export const MaximumAuthoritySchema = Schema.Literals(['observe', 'paper', 'live-bounded'])
export const ExercisableAuthoritySchema = Schema.Literals(['none', 'observe', 'paper', 'live-bounded'])

export type OperationalState = typeof OperationalStateSchema.Type
export type DependencyState = typeof DependencyStateSchema.Type
export type DataState = typeof DataStateSchema.Type
export type EvidenceState = typeof EvidenceStateSchema.Type
export type EconomicState = typeof EconomicStateSchema.Type
export type ReconciliationState = typeof ReconciliationStateSchema.Type
export type KillState = typeof KillStateSchema.Type
export type MaximumAuthority = typeof MaximumAuthoritySchema.Type
export type ExercisableAuthority = typeof ExercisableAuthoritySchema.Type

export interface StatusAxes {
  readonly operational: OperationalState
  readonly dependency: DependencyState
  readonly data: DataState
  readonly evidence: EvidenceState
  readonly economic: EconomicState
  readonly reconciliation: ReconciliationState
  readonly kill: KillState
}

const deriveExercisableAuthority = (
  state: StatusAxes & { readonly maximumAuthority: MaximumAuthority },
): ExercisableAuthority => {
  const canObserve =
    state.operational === 'RUNNING' &&
    state.dependency === 'AVAILABLE' &&
    state.data === 'FRESH' &&
    state.evidence === 'CURRENT' &&
    state.reconciliation === 'EXACT' &&
    state.kill === 'CLEAR'
  if (!canObserve) return 'none'
  if (state.maximumAuthority === 'observe' || state.economic !== 'QUALIFIED') return 'observe'
  return state.maximumAuthority
}

const StatusSnapshotBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.status.v1'),
  observedAt: UtcInstant,
  operational: OperationalStateSchema,
  dependency: DependencyStateSchema,
  data: DataStateSchema,
  evidence: EvidenceStateSchema,
  economic: EconomicStateSchema,
  reconciliation: ReconciliationStateSchema,
  kill: KillStateSchema,
  maximumAuthority: MaximumAuthoritySchema,
  exercisableAuthority: ExercisableAuthoritySchema,
})

export const StatusSnapshotSchema = StatusSnapshotBase.check(
  Schema.makeFilter(
    (state: typeof StatusSnapshotBase.Type) =>
      state.exercisableAuthority === deriveExercisableAuthority(state) ||
      ({
        path: ['exercisableAuthority'],
        issue: `must be ${deriveExercisableAuthority(state)} for the reported state`,
      } as const),
  ),
)
export type StatusSnapshot = typeof StatusSnapshotSchema.Type
export type StatusSnapshotInput = Omit<StatusSnapshot, 'schemaVersion' | 'exercisableAuthority'>

export const decodeFinalizedSnapshot = Schema.decodeUnknownEffect(FinalizedSnapshotProvenanceSchema, StrictParseOptions)
export const decodeEvaluationBounds = Schema.decodeUnknownEffect(EvaluationBoundsSchema, StrictParseOptions)
export const decodeRunIdentity = Schema.decodeUnknownEffect(RunIdentitySchema, StrictParseOptions)
export const decodeEvidenceFreshness = Schema.decodeUnknownEffect(EvidenceFreshnessSchema, StrictParseOptions)
export const decodeStatusSnapshot = Schema.decodeUnknownEffect(StatusSnapshotSchema, StrictParseOptions)

const decodeRunIdentityMaterialSync = Schema.decodeUnknownSync(RunIdentityMaterialSchema, StrictParseOptions)
const decodeRunIdentitySync = Schema.decodeUnknownSync(RunIdentitySchema, StrictParseOptions)
const decodeStatusSnapshotSync = Schema.decodeUnknownSync(StatusSnapshotSchema, StrictParseOptions)

export const makeRunIdentity = (input: RunIdentityMaterial): RunIdentity => {
  const material = decodeRunIdentityMaterialSync(input)
  return decodeRunIdentitySync({ ...material, runId: canonicalHashV1(material) })
}

export const classifyEvidenceFreshness = (freshness: EvidenceFreshness, now: string): EvidenceState => {
  if (!isUtcInstant(now)) throw new TypeError('now must be a canonical UTC instant')
  if (now < freshness.observedAt) return 'INVALID'
  return now <= freshness.validThrough ? 'CURRENT' : 'STALE'
}

export const makeStatusSnapshot = (input: StatusSnapshotInput): StatusSnapshot =>
  decodeStatusSnapshotSync({
    schemaVersion: 'bayn.status.v1',
    ...input,
    exercisableAuthority: deriveExercisableAuthority(input),
  })
