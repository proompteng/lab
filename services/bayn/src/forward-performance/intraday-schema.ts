import { Schema } from 'effect'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { IsoDateSchema, NonNegativeIntegerSchema, Sha256Schema, UtcInstantSchema } from '../schemas'
import { marketCalendarSchemaVersion, marketCalendarSource } from '../broker/alpaca/model'

export const IntradayPerformanceManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-market-snapshot.v1'),
  sessionDate: IsoDateSchema,
  calendar: Schema.Struct({
    schemaVersion: Schema.Literal(marketCalendarSchemaVersion),
    source: Schema.Literal(marketCalendarSource),
    requestedRange: Schema.Struct({ start: IsoDateSchema, end: IsoDateSchema }),
    timeZone: Schema.Literal('UTC'),
    sessions: Schema.Array(Schema.Struct({ date: IsoDateSchema, openAt: UtcInstantSchema, closeAt: UtcInstantSchema })),
    normalizedResponseHash: Sha256Schema,
  }),
  rangeStartAt: UtcInstantSchema,
  rangeEndAt: UtcInstantSchema,
  observedAt: UtcInstantSchema,
  universeId: Schema.String,
  universeSymbolHash: Sha256Schema,
  universe: Schema.optionalKey(Schema.Array(Schema.String)),
  symbols: Schema.Array(Schema.String),
  candidateSymbols: Schema.optionalKey(Schema.Array(Schema.String)),
  candidateExclusions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        symbol: Schema.String,
        reason: Schema.Literals(['not-ready', 'freshness']),
        message: Schema.String,
      }),
    ),
  ),
  purpose: Schema.optionalKey(Schema.Enum(IntradaySnapshotPurpose)),
  feed: Schema.Literal('iex'),
  delayClass: Schema.Literal('real_time_exchange_only'),
  sourceTopics: Schema.Struct({ bars: Schema.String, quotes: Schema.String, trades: Schema.String }),
  archiveWatermarks: Schema.Array(
    Schema.Struct({
      sourceTopic: Schema.String,
      sourcePartition: NonNegativeIntegerSchema,
      inclusiveLastOffset: Schema.String,
    }),
  ),
  maximumQuoteAgeMs: NonNegativeIntegerSchema,
  minimumWatermarkLagMs: NonNegativeIntegerSchema,
  barCount: NonNegativeIntegerSchema,
  quoteCount: NonNegativeIntegerSchema,
  tradeCount: NonNegativeIntegerSchema,
  barsContentHash: Sha256Schema,
  quotesContentHash: Sha256Schema,
  tradesContentHash: Sha256Schema,
  lineage: Schema.Array(
    Schema.Struct({
      sourceTopic: Schema.String,
      sourcePartition: NonNegativeIntegerSchema,
      firstOffset: Schema.String,
      lastOffset: Schema.String,
      recordCount: NonNegativeIntegerSchema,
    }),
  ),
  contentHash: Sha256Schema,
  snapshotId: Sha256Schema,
})

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
  feed: Schema.Literal('iex'),
  delayClass: Schema.Literal('real_time_exchange_only'),
  sourceTopics: IntradayPerformanceManifestSchema.fields.sourceTopics,
  maximumQuoteAgeMs: NonNegativeIntegerSchema,
  minimumWatermarkLagMs: NonNegativeIntegerSchema,
  archiveWatermarks: IntradayPerformanceManifestSchema.fields.archiveWatermarks,
})

export const IntradayPerformanceVolumeEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.forward-performance-intraday-volume-evidence.v1'),
  cycleId: Sha256Schema,
  decisionSnapshotId: Sha256Schema,
  decisionSnapshotAsOfSession: IsoDateSchema,
  symbol: Schema.String,
  executionSessionDate: IsoDateSchema,
  windowOpenedAt: UtcInstantSchema,
  windowClosedAt: UtcInstantSchema,
  evidenceCutoffAt: UtcInstantSchema,
  sourceFeed: Schema.Literal('iex'),
  decisionManifest: IntradayPerformanceManifestSchema,
  volumeScope: Schema.Literal('IEX_RECORDED_SESSION_VOLUME'),
  terminalPriceBasis: Schema.Literal('FINAL_MINUTE_BAR_CLOSE'),
  quantityMicros: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  closePriceMicros: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  finalizedAt: UtcInstantSchema,
  archiveRequest: IntradayPerformanceArchiveRequestSchema,
  barsContentHash: Sha256Schema,
  barCount: NonNegativeIntegerSchema,
  missingMinutes: Schema.Array(UtcInstantSchema),
  contentHash: Sha256Schema,
})
