import { Schema } from 'effect'

import { canonicalHashV1, sha256 } from './hash'
import { ContractVersion, DataFeed, DataSource, PriceAdjustment, PublicationSchema } from './types'

const StrictParseOptions = { onExcessProperty: 'error' } as const

type IsoDateValue = `${number}-${number}-${number}`

const isIsoDate = (value: string): value is IsoDateValue => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const isUtcInstant = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

const NonEmptyString = Schema.String.check(
  Schema.makeFilter((value: string) => value.length > 0 && value.trim() === value, {
    expected: 'a non-empty string without surrounding whitespace',
  }),
)
export const IsoDateSchema = Schema.String.pipe(Schema.refine(isIsoDate, { expected: 'a valid ISO date (YYYY-MM-DD)' }))
const UtcInstant = Schema.String.check(
  Schema.makeFilter(isUtcInstant, { expected: 'a canonical UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ)' }),
)
export const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const SourceRevision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const SymbolName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,15}$/))
const UniverseId = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/))
const CanonicalJson = Schema.Unknown.check(Schema.makeFilter(Schema.is(Schema.Json), { expected: 'a JSON value' }))

const FinalizedSnapshotFields = {
  snapshotId: Sha256Schema,
  publicationId: Sha256Schema,
  source: Schema.Enum(DataSource),
  sourceFeed: Schema.Enum(DataFeed),
  adjustment: Schema.Enum(PriceAdjustment),
  calendarVersion: NonEmptyString,
  publisherSourceRevision: SourceRevision,
  publisherImage: Schema.Struct({
    repository: NonEmptyString,
    digest: ImageDigest,
  }),
  finalizedAt: UtcInstant,
  requestedStart: IsoDateSchema,
  firstSession: IsoDateSchema,
  lastSession: IsoDateSchema,
  asOfSession: IsoDateSchema,
  symbols: Schema.Array(SymbolName).check(Schema.isMinLength(1)),
  rowCount: PositiveInteger,
  sessionCount: PositiveInteger,
  contentHash: Sha256Schema,
  sessionsContentHash: Sha256Schema,
} as const

const FinalizedSnapshotBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.finalized-snapshot.v3'),
  publicationSchemaVersion: Schema.Literal(PublicationSchema.AdjustedDailySnapshotV2),
  universeId: UniverseId,
  universeSymbolHash: Sha256Schema,
  ...FinalizedSnapshotFields,
})

const finalizedSnapshotIssues = (snapshot: typeof FinalizedSnapshotBase.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (snapshot.firstSession > snapshot.lastSession) {
    issues.push({ path: ['firstSession'], issue: 'must not be after lastSession' })
  }
  if (snapshot.requestedStart > snapshot.firstSession) {
    issues.push({ path: ['requestedStart'], issue: 'must not be after firstSession' })
  }
  if (snapshot.asOfSession !== snapshot.lastSession) {
    issues.push({ path: ['asOfSession'], issue: 'must equal lastSession for a finalized snapshot' })
  }
  const canonicalSymbols = [...new Set(snapshot.symbols)].sort()
  if (canonicalSymbols.length !== snapshot.symbols.length) {
    issues.push({ path: ['symbols'], issue: 'must not contain duplicate symbols' })
  } else if (canonicalSymbols.some((symbol, index) => symbol !== snapshot.symbols[index])) {
    issues.push({ path: ['symbols'], issue: 'must be sorted in canonical order' })
  }
  if (snapshot.rowCount !== snapshot.sessionCount * snapshot.symbols.length) {
    issues.push({ path: ['rowCount'], issue: 'must equal sessionCount multiplied by the symbol count' })
  }
  if (snapshot.universeSymbolHash !== sha256(snapshot.symbols.join(','))) {
    issues.push({ path: ['universeSymbolHash'], issue: 'must match the canonical symbol list' })
  }
  return issues
}

export const FinalizedSnapshotProvenanceSchema = FinalizedSnapshotBase.check(Schema.makeFilter(finalizedSnapshotIssues))
export type FinalizedSnapshotProvenance = typeof FinalizedSnapshotProvenanceSchema.Type

const EvaluationBoundsBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.evaluation-bounds.v1'),
  dataStart: IsoDateSchema,
  dataEnd: IsoDateSchema,
  lookbackStart: IsoDateSchema,
  evaluationStart: IsoDateSchema,
  evaluationEnd: IsoDateSchema,
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
    name: Schema.Literal('risk-balanced-trend'),
    behaviorHash: Sha256Schema,
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

const RunIdentityBase = Schema.Struct({ ...RunIdentityFields, runId: Sha256Schema })

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

const RuntimeProvenanceBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.runtime-provenance.v2'),
  sourceRevision: SourceRevision,
  image: Schema.Struct({
    repository: NonEmptyString,
    digest: ImageDigest,
  }),
  strategy: Schema.Struct({
    name: Schema.Literal('risk-balanced-trend'),
    behaviorHash: Sha256Schema,
    parameterHash: Sha256Schema,
    parameterSchemaVersion: Schema.Literal('bayn.risk-balanced-trend.protocol.v2'),
  }),
  contractVersions: Schema.Struct({
    runtimeProvenance: Schema.Literal('bayn.runtime-provenance.v2'),
    inputManifest: Schema.Literal('bayn.input-manifest.v3'),
    evaluation: Schema.Literal(ContractVersion.Evaluation),
  }),
})

export const RuntimeProvenanceSchema = RuntimeProvenanceBase
export type RuntimeProvenance = typeof RuntimeProvenanceSchema.Type
export type RuntimeProvenanceInput = Omit<RuntimeProvenance, 'schemaVersion' | 'contractVersions'>

export const makeStrategyProtocolHash = (strategy: RuntimeProvenance['strategy']): string =>
  canonicalHashV1({
    schemaVersion: 'bayn.strategy-protocol.v1',
    name: strategy.name,
    behaviorHash: strategy.behaviorHash,
    parameterHash: strategy.parameterHash,
    parameterSchemaVersion: strategy.parameterSchemaVersion,
  })

export const decodeFinalizedSnapshot = Schema.decodeUnknownEffect(FinalizedSnapshotProvenanceSchema, StrictParseOptions)
export const decodeEvaluationBounds = Schema.decodeUnknownEffect(EvaluationBoundsSchema, StrictParseOptions)
export const decodeRunIdentity = Schema.decodeUnknownEffect(RunIdentitySchema, StrictParseOptions)
export const decodeRuntimeProvenance = Schema.decodeUnknownEffect(RuntimeProvenanceSchema, StrictParseOptions)

const decodeRunIdentityMaterialSync = Schema.decodeUnknownSync(RunIdentityMaterialSchema, StrictParseOptions)
const decodeRunIdentitySync = Schema.decodeUnknownSync(RunIdentitySchema, StrictParseOptions)
const decodeRuntimeProvenanceSync = Schema.decodeUnknownSync(RuntimeProvenanceSchema, StrictParseOptions)

export const makeRunIdentity = (input: RunIdentityMaterial): RunIdentity => {
  const material = decodeRunIdentityMaterialSync(input)
  return decodeRunIdentitySync({ ...material, runId: canonicalHashV1(material) })
}

export const makeRuntimeProvenance = (input: RuntimeProvenanceInput): RuntimeProvenance => {
  return decodeRuntimeProvenanceSync({
    schemaVersion: 'bayn.runtime-provenance.v2',
    ...input,
    contractVersions: {
      runtimeProvenance: 'bayn.runtime-provenance.v2',
      inputManifest: 'bayn.input-manifest.v3',
      evaluation: ContractVersion.Evaluation,
    },
  })
}
