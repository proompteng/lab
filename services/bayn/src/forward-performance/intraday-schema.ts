import { Schema } from 'effect'
import { IsoDateSchema, NonNegativeIntegerSchema, Sha256Schema, UtcInstantSchema } from '../schemas'
import { SnapshotManifestFields } from '../market-data/streaming/manifest-schema'
import { StreamingSnapshotEvidenceSchema } from '../market-data/streaming/evidence-schema'

const ManifestFields = {
  ...SnapshotManifestFields,
  universe: Schema.optionalKey(Schema.Array(Schema.String)),
}

export const IntradayPerformanceManifestSchema = Schema.Struct({
  ...ManifestFields,
  schemaVersion: Schema.Literal('bayn.intraday-market-snapshot.v1'),
  archiveWatermarks: Schema.Array(
    Schema.Struct({
      sourceTopic: Schema.String,
      sourcePartition: NonNegativeIntegerSchema,
      inclusiveLastOffset: Schema.String,
    }),
  ),
})

export const StreamingPerformanceManifestSchema = Schema.Struct({
  ...ManifestFields,
  schemaVersion: Schema.Literal('bayn.streaming-market-snapshot.v1'),
  universe: Schema.Array(Schema.String),
  streaming: StreamingSnapshotEvidenceSchema,
})

export const IntradayPerformanceDecisionManifestSchema = Schema.Union([
  IntradayPerformanceManifestSchema,
  StreamingPerformanceManifestSchema,
])

export const IntradayPerformanceArchiveRequestSchema = Schema.Struct({
  sessionDate: IsoDateSchema,
  calendar: IntradayPerformanceManifestSchema.fields.calendar,
  rangeStartAt: UtcInstantSchema,
  rangeEndAt: UtcInstantSchema,
  observedAt: UtcInstantSchema,
  universeId: Schema.String,
  universeSymbolHash: Sha256Schema,
  universe: Schema.Array(Schema.String),
  symbols: Schema.Array(Schema.String),
  feed: SnapshotManifestFields.feed,
  delayClass: SnapshotManifestFields.delayClass,
  sourceTopics: IntradayPerformanceManifestSchema.fields.sourceTopics,
  maximumQuoteAgeMs: NonNegativeIntegerSchema,
  minimumWatermarkLagMs: NonNegativeIntegerSchema,
  archiveWatermarks: IntradayPerformanceManifestSchema.fields.archiveWatermarks,
})

export const IntradayPerformanceVolumeEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.forward-performance-intraday-volume-evidence.v2'),
  cycleId: Sha256Schema,
  decisionSnapshotId: Sha256Schema,
  decisionSnapshotAsOfSession: IsoDateSchema,
  symbol: Schema.String,
  executionSessionDate: IsoDateSchema,
  windowOpenedAt: UtcInstantSchema,
  windowClosedAt: UtcInstantSchema,
  evidenceCutoffAt: UtcInstantSchema,
  sourceFeed: SnapshotManifestFields.feed,
  decisionManifest: IntradayPerformanceDecisionManifestSchema,
  volumeScope: Schema.Literal('RECORDED_COMPLETE_MINUTE_VOLUME'),
  terminalPriceBasis: Schema.Literal('FINAL_MINUTE_BAR_CLOSE'),
  quantityAtoms: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  closePriceMicros: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  finalizedAt: UtcInstantSchema,
  archiveRequest: IntradayPerformanceArchiveRequestSchema,
  barsContentHash: Sha256Schema,
  barCount: NonNegativeIntegerSchema,
  missingMinutes: Schema.Array(UtcInstantSchema),
  contentHash: Sha256Schema,
})
