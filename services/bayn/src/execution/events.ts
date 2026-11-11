import { Schema } from 'effect'

import { Sha256Schema, SourceRevisionSchema, UtcInstantSchema, strictParseOptions } from '../schemas'

const envelope = {
  schemaVersion: Schema.Literal('bayn.execution-wakeup.v1'),
  sourceRevision: SourceRevisionSchema,
  eventId: Sha256Schema,
}

export const BrokerObservationWakeupSchema = Schema.TaggedStruct('BrokerObservation', {
  ...envelope,
  snapshotHash: Sha256Schema,
  observedAt: UtcInstantSchema,
})

export const MarketReadySchema = Schema.TaggedStruct('MarketReady', {
  ...envelope,
  captureId: Schema.NonEmptyString,
  sourceEpoch: Schema.NonEmptyString,
  consumerSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  projectionSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  originalAvailableAt: UtcInstantSchema,
  readyAt: UtcInstantSchema,
})
export type MarketReadyWakeup = typeof MarketReadySchema.Type

export const InferenceCompletedWakeupSchema = Schema.TaggedStruct('InferenceCompleted', {
  ...envelope,
  epoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  jobId: Sha256Schema,
  batchId: Sha256Schema,
  cycleId: Schema.NonEmptyString,
  authorityGenerationHash: Sha256Schema,
  expiresAt: UtcInstantSchema,
  completedAt: UtcInstantSchema,
})

export const ExecutionWakeupSchema = Schema.Union([
  BrokerObservationWakeupSchema,
  MarketReadySchema,
  InferenceCompletedWakeupSchema,
])
export type ExecutionWakeup = typeof ExecutionWakeupSchema.Type
export const decodeExecutionWakeup = Schema.decodeUnknownResult(ExecutionWakeupSchema, strictParseOptions)
