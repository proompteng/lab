import { Schema } from 'effect'

import { Sha256Schema, UtcInstantSchema } from '../../schemas'
import { MarketFeatureDefinition } from '../../market-data/features/contract'

export enum DecisionReadinessReason {
  DecisionPending = 'DECISION_PENDING',
  LookbackWarmup = 'LOOKBACK_WARMUP',
  SnapshotUnavailable = 'SNAPSHOT_UNAVAILABLE',
  SnapshotCoverage = 'SNAPSHOT_COVERAGE',
  SnapshotStale = 'SNAPSHOT_STALE',
  ArchiveWatermark = 'ARCHIVE_WATERMARK',
  NoEligibleCandidate = 'NO_ELIGIBLE_CANDIDATE',
}

export const RequiredFeatureReadinessSchema = Schema.Struct({
  definitionId: Schema.Enum(MarketFeatureDefinition),
  definitionHash: Sha256Schema,
  windowStartAt: UtcInstantSchema,
  windowEndAt: UtcInstantSchema,
})

export const DecisionReadinessSchema = Schema.Struct({
  reason: Schema.Enum(DecisionReadinessReason),
  message: Schema.NonEmptyString,
  availableAt: Schema.optionalKey(UtcInstantSchema),
  symbol: Schema.optionalKey(Schema.NonEmptyString),
  eventAt: Schema.optionalKey(UtcInstantSchema),
  requiredFeature: Schema.optionalKey(RequiredFeatureReadinessSchema),
  snapshotQuery: Schema.optionalKey(
    Schema.Struct({
      rangeStartAt: UtcInstantSchema,
      rangeEndAt: UtcInstantSchema,
      symbols: Schema.Array(Schema.NonEmptyString),
    }),
  ),
})

export type DecisionReadiness = typeof DecisionReadinessSchema.Type

export const CycleWaitReasonSchema = Schema.Literals([
  'ENTRY_INTENTS_SETTLED_UNTIL_CLOSE',
  'POST_MUTATION_RECONCILIATION',
  'accounting-inexact',
  'intent-nonterminal',
  'intent-unsuccessful',
  'reconciliation-not-later',
  'reconciliation-not-exact',
  'unknown-mutation',
  'unknown-order',
  'open-position',
])

export type CycleWaitReason = typeof CycleWaitReasonSchema.Type
