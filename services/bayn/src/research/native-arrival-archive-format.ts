import { Schema } from 'effect'

import { NativeArrivalChunkHeaderSchema } from '../market-data/streaming/native-arrival'
import { NonNegativeIntegerSchema, Sha256Schema, StrictNonEmptyStringSchema, UtcInstantSchema } from '../schemas'

export const EvidenceObjectSchema = Schema.Struct({
  key: StrictNonEmptyStringSchema,
  sha256: Sha256Schema,
  bytes: NonNegativeIntegerSchema,
})

export const NativeArrivalArchivePageSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.native-arrival-export-page.v1'),
  captureId: Sha256Schema,
  epochHash: Sha256Schema,
  previousPage: Schema.NullOr(EvidenceObjectSchema),
  chunks: Schema.Array(
    Schema.Struct({
      header: NativeArrivalChunkHeaderSchema,
      contentHash: Sha256Schema,
      compressedBase64: Schema.String.check(Schema.isMaxLength(6 * 1024 * 1024)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
})

export const NativeArrivalArchiveReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.native-arrival-export.v1'),
  captureId: Sha256Schema,
  epoch: EvidenceObjectSchema,
  startedAt: UtcInstantSchema,
  finishedAt: UtcInstantSchema,
  firstOrdinal: NonNegativeIntegerSchema,
  nextOrdinal: NonNegativeIntegerSchema,
  pagesWritten: NonNegativeIntegerSchema,
  lastPage: Schema.NullOr(EvidenceObjectSchema),
  end: Schema.NullOr(EvidenceObjectSchema),
  caughtUpToReadCut: Schema.Boolean,
  qualification: Schema.Literal('UNQUALIFIED'),
  sourceCoverage: Schema.Literal('RETAINED_NATIVE_PREFIX'),
  completeSessionCoverage: Schema.Literal(false),
  limitations: Schema.Array(StrictNonEmptyStringSchema),
  receiptHash: Sha256Schema,
})
