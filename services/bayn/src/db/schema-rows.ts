import { Schema } from 'effect'

import type { InputManifest } from '../types'
import { ProtocolSchema } from '../protocol'
import {
  FinalizedSnapshotProvenanceSchema,
  IsoDateSchema,
} from '../contracts'
import { QualificationLockSchema, QualificationResultSchema } from '../qualification'

// ── Primitive validators ──────────────────────────────────────────────

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const GitRevision = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

// ── Row schemas ───────────────────────────────────────────────────────

export const HealthRow = Schema.Struct({ value: Schema.Literal(1) })

export const RunRequest = Schema.Struct({ runId: Sha256 })

export const InsertedRun = Schema.Struct({ run_id: Sha256 })

export const ProtocolRow = Schema.Struct({
  protocol_hash: Sha256,
  schema_version: Schema.String,
  strategy_name: Schema.String,
  behavior_hash: Sha256,
  parameter_hash: Sha256,
  parameters: ProtocolSchema,
})

export const SnapshotRow = Schema.Struct({
  snapshot_id: Sha256,
  schema_version: Schema.Literal('bayn.finalized-snapshot.v3'),
  database_name: Schema.Literal('signal'),
  table_name: Schema.Literal('adjusted_daily_bars_v2'),
  dataset_version: Schema.Literal('signal.adjusted-daily-snapshot.v2'),
  source: Schema.Literal('alpaca'),
  source_feed: Schema.Literal('sip'),
  adjustment: Schema.Literal('all'),
  content_hash: Sha256,
  row_count: PositiveInteger,
  first_session: Schema.String,
  last_session: Schema.String,
  manifest: FinalizedSnapshotProvenanceSchema,
})

export const snapshotRowEquivalence = Schema.toEquivalence(SnapshotRow)

export const ReceiptRow = Schema.Struct({
  run_id: Sha256,
  protocol_hash: Sha256,
  snapshot_id: Sha256,
  evaluation_schema_version: Schema.String,
  source_revision: GitRevision,
  image_repository: Schema.String,
  image_digest: ImageDigest,
  strategy_name: Schema.String,
  initial_capital_micros: Schema.String,
  status: Schema.Literal('COMPLETE'),
  expected_artifact_count: PositiveInteger,
  expected_event_count: NonNegativeInteger,
  expected_gate_count: PositiveInteger,
  artifact_count: NonNegativeInteger,
  event_count: NonNegativeInteger,
  gate_count: NonNegativeInteger,
})

export const ArtifactReferenceRow = Schema.Struct({
  artifact_name: Schema.String,
  schema_version: Schema.String,
  content_hash: Sha256,
  payload: Schema.Unknown,
})

export const ArtifactSeriesMetadataRow = Schema.Struct({
  schema_version: Schema.String,
  content_hash: Sha256,
  item_count: NonNegativeInteger,
})

export const ArtifactItemRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  payload: Schema.Unknown,
})

export const EventReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  event_id: Sha256,
  event_kind: Schema.Literals(['decision', 'fill', 'fee', 'cash-yield']),
  content_hash: Sha256,
  payload: Schema.Unknown,
})

export const GateReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  gate_name: Schema.String,
  passed: Schema.Boolean,
  actual: Schema.Unknown,
  required: Schema.Unknown,
  content_hash: Sha256,
})

export const StatusReferenceRow = Schema.Struct({
  status: Schema.Literals(['WRITING', 'COMPLETE']),
  detail: Schema.Unknown,
})

export const QualificationTrialRow = Schema.Struct({ run_id: Sha256 })

export const QualificationRow = Schema.Struct({
  lock_payload: Schema.Unknown,
  result_payload: Schema.NullOr(Schema.Unknown),
})

export const CandidateRunCountRow = Schema.Struct({ count: NonNegativeInteger })

export const InsertedLockRow = Schema.Struct({ lock_id: Sha256 })

export const InsertedResultRow = Schema.Struct({ lock_id: Sha256 })

// ── Strict parse options ──────────────────────────────────────────────

const StrictParseOptions = { onExcessProperty: 'error' } as const
export const decodeQualificationLock = Schema.decodeUnknownSync(QualificationLockSchema, StrictParseOptions)
export const decodeQualificationResult = Schema.decodeUnknownSync(QualificationResultSchema, StrictParseOptions)

// ── Snapshot reference matcher ────────────────────────────────────────

export const snapshotReferenceMatches = (row: typeof SnapshotRow.Type, inputManifest: InputManifest): boolean => {
  const snapshot = inputManifest.finalizedSnapshot
  return snapshotRowEquivalence(row, {
    snapshot_id: snapshot.snapshotId,
    schema_version: snapshot.schemaVersion,
    database_name: inputManifest.database,
    table_name: inputManifest.tables.bars,
    dataset_version: snapshot.publicationSchemaVersion,
    source: snapshot.source,
    source_feed: snapshot.sourceFeed,
    adjustment: snapshot.adjustment,
    content_hash: snapshot.contentHash,
    row_count: snapshot.rowCount,
    first_session: snapshot.firstSession,
    last_session: snapshot.lastSession,
    manifest: snapshot,
  })
}
