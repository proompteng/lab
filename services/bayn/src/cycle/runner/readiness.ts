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
  SignalWindowObserved = 'SIGNAL_WINDOW_OBSERVED',
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

export const CycleCompletionWaitReasonSchema = Schema.Literals([
  'accounting-inexact',
  'intent-nonterminal',
  'intent-unsuccessful',
  'reconciliation-not-later',
  'reconciliation-not-exact',
  'unknown-mutation',
  'unknown-order',
  'open-position',
])

export type CycleCompletionWaitReason = typeof CycleCompletionWaitReasonSchema.Type

export const CycleWaitReasonSchema = Schema.Union([
  CycleCompletionWaitReasonSchema,
  Schema.Literals([
    'ENTRY_INTENTS_SETTLED_UNTIL_CLOSE',
    'JEV_POSITION_AWAITING_RECONCILIATION',
    'JEV_POSITION_HELD',
    'POST_MUTATION_RECONCILIATION',
    'AWAITING_SUBMISSION_OPEN',
    'AWAITING_CLOSE_WINDOW',
    'CLOSE_STORE_UNAVAILABLE',
    'CLOSE_MARKET_DATA_UNAVAILABLE',
    'CLOSE_ONLY_UNTIL_CLOSE',
    'MUTATION_NOT_ADVANCED',
    'MUTATION_RECOVERY_BACKOFF',
    'MUTATION_EVIDENCE_PENDING',
    'COMPLETION_EVIDENCE_PENDING',
    'SUBMISSION_NOT_ALLOWED',
  ]),
])

export type CycleWaitReason = typeof CycleWaitReasonSchema.Type

export type CycleWaitingDetails =
  | { readonly waitReason: CycleWaitReason; readonly readiness?: never }
  | { readonly readiness: DecisionReadiness; readonly waitReason?: never }
