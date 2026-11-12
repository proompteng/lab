import { Schema } from 'effect'

import { sha256 } from '../hash'
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

export enum MarketChangeReason {
  Startup = 'Startup',
  Data = 'Data',
  Ready = 'Ready',
  Recovery = 'Recovery',
}

export const MarketChangedSchema = Schema.TaggedStruct('MarketChanged', {
  ...envelope,
  producerId: Schema.String.check(Schema.isUUID(4)),
  sequence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  reason: Schema.Enum(MarketChangeReason),
})
export type MarketChangedWakeup = typeof MarketChangedSchema.Type
export const marketChangedEventId = (producerId: string, sequence: number): string =>
  sha256(`bayn.market-change.v1:${producerId}:${sequence}`)

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
  MarketChangedSchema,
  InferenceCompletedWakeupSchema,
])
export type ExecutionWakeup = typeof ExecutionWakeupSchema.Type
export const decodeExecutionWakeup = Schema.decodeUnknownResult(ExecutionWakeupSchema, strictParseOptions)
