import { Schema } from 'effect'

import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
} from '../../schemas'
import { IntradaySnapshotPurpose } from '../intraday/model'
import { SimulatedSnapshotEvidenceSchema, StreamingSnapshotEvidenceSchema } from './evidence-schema'

export const SnapshotCalendarSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  source: Schema.Literal('alpaca-v2-calendar'),
  requestedRange: Schema.Struct({ start: IsoDateSchema, end: IsoDateSchema }),
  timeZone: Schema.Literal('UTC'),
  sessions: Schema.Array(
    Schema.Struct({ date: IsoDateSchema, openAt: UtcInstantSchema, closeAt: UtcInstantSchema }),
  ).check(Schema.isMinLength(1)),
  normalizedResponseHash: Sha256Schema,
})

const ExecutionLineageSchema = Schema.Struct({
  sourceTopic: StrictNonEmptyStringSchema,
  sourcePartition: NonNegativeIntegerSchema,
  firstOffset: UnsignedMicrosSchema,
  lastOffset: UnsignedMicrosSchema,
  recordCount: PositiveIntegerSchema,
})

const ExecutionCandidateExclusionSchema = Schema.Struct({
  symbol: SymbolSchema,
  reason: Schema.Literals(['not-ready', 'freshness']),
  message: StrictNonEmptyStringSchema,
})

export const SnapshotManifestFields = {
  sessionDate: IsoDateSchema,
  calendar: SnapshotCalendarSchema,
  rangeStartAt: UtcInstantSchema,
  rangeEndAt: UtcInstantSchema,
  observedAt: UtcInstantSchema,
  universeId: StrictNonEmptyStringSchema,
  universeSymbolHash: Sha256Schema,
  symbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  /** Independent entry evidence carries the complete candidate request and its availability result. */
  candidateSymbols: Schema.optionalKey(Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique())),
  candidateExclusions: Schema.optionalKey(Schema.Array(ExecutionCandidateExclusionSchema).check(Schema.isUnique())),
  purpose: Schema.optionalKey(Schema.Enum(IntradaySnapshotPurpose)),
  feed: Schema.Literals(['iex', 'sip', 'delayed_sip']),
  delayClass: Schema.Literals(['real_time_exchange_only', 'real_time_consolidated', 'delayed_15m_consolidated']),
  sourceTopics: Schema.Struct({
    bars: StrictNonEmptyStringSchema,
    quotes: StrictNonEmptyStringSchema,
    trades: StrictNonEmptyStringSchema,
  }),
  maximumQuoteAgeMs: PositiveIntegerSchema,
  minimumWatermarkLagMs: NonNegativeIntegerSchema,
  barCount: NonNegativeIntegerSchema,
  quoteCount: PositiveIntegerSchema,
  tradeCount: NonNegativeIntegerSchema,
  barsContentHash: Sha256Schema,
  quotesContentHash: Sha256Schema,
  tradesContentHash: Sha256Schema,
  lineage: Schema.Array(ExecutionLineageSchema).check(Schema.isMinLength(1)),
  contentHash: Sha256Schema,
  snapshotId: Sha256Schema,
} as const

export const StrategySnapshotManifestSchema = Schema.Union([
  Schema.Struct({
    ...SnapshotManifestFields,
    schemaVersion: Schema.Literal('bayn.streaming-market-snapshot.v1'),
    universe: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
    streaming: StreamingSnapshotEvidenceSchema,
  }),
  Schema.Struct({
    ...SnapshotManifestFields,
    schemaVersion: Schema.Literal('bayn.simulated-market-snapshot.v1'),
    universe: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
    streaming: SimulatedSnapshotEvidenceSchema,
  }),
])
