import { Schema } from 'effect'

import {
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
} from '../../schemas'
import { RollingMarketFeatureSchema } from '../features/contract'
import { KafkaBootstrapTimestampPolicy } from './bootstrap'

const PositionFields = { topic: StrictNonEmptyStringSchema, partition: NonNegativeIntegerSchema }
const Timestamp = NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(253402300799999))
const BootstrapSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.kafka-bootstrap.v1'),
  epoch: StrictNonEmptyStringSchema,
  observedAtMs: Timestamp,
  lowerTimestampMs: Timestamp,
  timestampPolicy: Schema.Enum(KafkaBootstrapTimestampPolicy),
  partitions: Schema.Array(
    Schema.Struct({
      ...PositionFields,
      logStartOffset: UnsignedMicrosSchema,
      startOffset: UnsignedMicrosSchema,
      endOffset: UnsignedMicrosSchema,
    }),
  ).check(Schema.isMinLength(1)),
})
const CutFields = {
  positions: Schema.Array(Schema.Struct({ ...PositionFields, offset: UnsignedMicrosSchema })).check(
    Schema.isMinLength(1),
  ),
  sequence: NonNegativeIntegerSchema,
  records: Schema.Array(
    Schema.Struct({
      sourceTopic: StrictNonEmptyStringSchema,
      sourcePartition: NonNegativeIntegerSchema,
      sourceOffset: UnsignedMicrosSchema,
      availableAtMs: Timestamp,
      sequence: PositiveIntegerSchema,
      contentHash: Sha256Schema,
    }),
  ),
  features: Schema.Array(
    Schema.Struct({
      ...PositionFields,
      offset: UnsignedMicrosSchema,
      availableAtMs: Timestamp,
      sequence: PositiveIntegerSchema,
      value: RollingMarketFeatureSchema,
    }),
  ),
} as const

export const StreamingSnapshotEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.streaming-input-cut.v1'),
  bootstrap: BootstrapSchema,
  ...CutFields,
})

export const SimulatedSnapshotSourceSchema = Schema.Struct({
  runId: Sha256Schema,
  sourceManifestHash: Sha256Schema,
  deliveryModel: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.supplied-arrival-times.v1'),
    description: StrictNonEmptyStringSchema,
    tieBreak: Schema.Literal('availability-topic-partition-offset'),
  }),
  featureTopic: StrictNonEmptyStringSchema,
  regeneratedFeaturesRecordedAtMs: Schema.optionalKey(Timestamp),
})
export const SimulatedSnapshotEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.simulated-input-cut.v1'),
  ...SimulatedSnapshotSourceSchema.fields,
  ...CutFields,
})
