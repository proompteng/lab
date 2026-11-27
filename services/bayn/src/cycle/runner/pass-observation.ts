import { Schema } from 'effect'

import { ExecutionBuildSchema } from '../../build'

import {
  IsoDateSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcDatabaseInstantSchema,
  UtcInstantSchema,
} from '../../schemas'
import { MarketCalendarObservationSchema } from '../../broker/alpaca/model'
import { CycleExecutionPolicySchema } from '../model'
import { CycleWaitReasonSchema, DecisionReadinessReason, DecisionReadinessSchema } from './readiness'
import { JevPositionHoldSchema } from '../../jev/hold'
import { JevEntryTargetSchema } from '../../jev/decision'
import { EntryAblationTargetSchema } from '../../jev/entry-ablation'
import { RepeatedMomentumTargetSchema } from '../../strategy/repeated-momentum/decision'
import { IntradayAlphaTargetSchema } from '../../strategy/intraday-alpha/decision'
import { AccountProtectionInputsSchema } from '../../jev/account-protection'

export const AdmissionProtectionEvidenceSchema = Schema.Struct({
  authorityGenerationHash: Sha256Schema,
  authorityUpdatedAt: UtcDatabaseInstantSchema,
  reconciliationId: Sha256Schema,
  tradingDate: IsoDateSchema,
  validUntil: UtcInstantSchema,
  inputs: Schema.optionalKey(AccountProtectionInputsSchema),
})

export type AdmissionProtectionEvidence = typeof AdmissionProtectionEvidenceSchema.Type

export const ClosedEntryWindowSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.closed-entry-window.v1'),
  accountId: StrictNonEmptyStringSchema,
  authorityGenerationHash: Schema.NullOr(Sha256Schema),
  strategyProtocolHash: Sha256Schema,
  evaluatedAt: UtcInstantSchema,
  decidedAt: UtcInstantSchema,
  executionPolicy: CycleExecutionPolicySchema,
  calendar: MarketCalendarObservationSchema,
  calendarRead: Schema.Struct({
    requestId: StrictNonEmptyStringSchema,
    status: Schema.Int,
    contentHash: Sha256Schema,
    observedAt: UtcInstantSchema,
  }),
})
export type ClosedEntryWindow = typeof ClosedEntryWindowSchema.Type

export const maximumRetainedJevObservationReferences = 16
export const maximumRetainedAlphaObservationReferences = 16
export const AlphaObservationReferencesSchema = Schema.Struct({
  hashes: Schema.Array(Sha256Schema).check(
    Schema.isMaxLength(maximumRetainedAlphaObservationReferences),
    Schema.makeFilter((hashes) => hashes.every((hash, index) => hash > (hashes[index - 1] ?? '')), {
      expected: 'unique alpha observation hashes in canonical order',
    }),
  ),
  complete: Schema.Boolean,
})
export const JevObservationReferencesSchema = Schema.Struct({
  hashes: Schema.Array(Sha256Schema).check(
    Schema.isMaxLength(maximumRetainedJevObservationReferences),
    Schema.makeFilter((hashes) => hashes.every((hash, index) => hash > (hashes[index - 1] ?? '')), {
      expected: 'unique Jev observation hashes in canonical order',
    }),
  ),
  complete: Schema.Boolean,
})

export const cyclePassObservationSchemaForHold = <Hold extends { readonly evidence: { readonly observedAt: string } }>(
  positionHold: Schema.Codec<Hold>,
) =>
  Schema.Union([
    Schema.Struct({
      result: Schema.Literal('SUCCESS'),
      executionIssuedAt: Schema.optionalKey(UtcInstantSchema),
      executionBuild: Schema.optionalKey(ExecutionBuildSchema),
      observedAt: UtcInstantSchema,
      jevObservationReferences: Schema.optionalKey(JevObservationReferencesSchema),
      alphaObservationReferences: Schema.optionalKey(AlphaObservationReferencesSchema),
      outcome: Schema.Literals([
        'WAITING',
        'ADMISSION_WAITING',
        'WINDOW_CLOSED',
        'ALREADY_ACQUIRED',
        'ALREADY_TERMINAL',
        'RECOVERED',
        'ACQUIRED',
        'REACQUIRED',
      ]),
      closedEntryWindow: Schema.optionalKey(ClosedEntryWindowSchema),
      recoveryAction: Schema.optionalKey(
        Schema.Literals(['ACTIVATED', 'BLOCKED', 'BOUND_DECISION', 'COMPLETED', 'NO_TRADE', 'WAITING']),
      ),
      waitReason: Schema.optionalKey(CycleWaitReasonSchema),
      positionHold: Schema.optionalKey(positionHold),
      protectionReleaseCycleId: Schema.optionalKey(Sha256Schema),
      entryAbstention: Schema.optionalKey(
        Schema.Union([
          JevEntryTargetSchema,
          EntryAblationTargetSchema,
          RepeatedMomentumTargetSchema,
          IntradayAlphaTargetSchema,
        ]).check(
          Schema.makeFilter((target) => target.selectedSymbols.length === 0, {
            expected: 'a reproduced decision with no selected entries',
          }),
        ),
      ),
      readiness: Schema.optionalKey(DecisionReadinessSchema),
      admissionProtection: Schema.optionalKey(AdmissionProtectionEvidenceSchema),
      nextWakeAt: Schema.optionalKey(UtcInstantSchema),
    }).check(
      Schema.makeFilter(
        (observation) => {
          if (observation.closedEntryWindow !== undefined && observation.outcome !== 'WINDOW_CLOSED') return false
          if (
            observation.entryAbstention !== undefined &&
            (observation.outcome !== 'RECOVERED' ||
              observation.recoveryAction !== 'WAITING' ||
              observation.readiness?.reason !== DecisionReadinessReason.NoEligibleCandidate ||
              observation.entryAbstention.evidence.decidedAt > observation.observedAt)
          )
            return false
          if (
            observation.positionHold !== undefined &&
            (observation.outcome !== 'RECOVERED' ||
              observation.recoveryAction !== 'WAITING' ||
              observation.waitReason !== 'JEV_POSITION_HELD' ||
              observation.positionHold.evidence.observedAt > observation.observedAt)
          )
            return false
          if (observation.recoveryAction !== undefined && observation.outcome !== 'RECOVERED') return false
          if (
            observation.protectionReleaseCycleId !== undefined &&
            (observation.recoveryAction !== 'WAITING' || observation.waitReason !== 'POST_MUTATION_RECONCILIATION')
          )
            return false
          if (observation.outcome === 'ADMISSION_WAITING')
            return (
              observation.waitReason === undefined &&
              (observation.readiness?.reason === DecisionReadinessReason.AccountProtection ||
                observation.readiness?.reason === DecisionReadinessReason.TurnoverBudgetExhausted) &&
              observation.admissionProtection !== undefined &&
              observation.admissionProtection.validUntil > observation.observedAt &&
              observation.nextWakeAt === undefined
            )
          if (observation.admissionProtection !== undefined) return false
          if (observation.outcome === 'ALREADY_TERMINAL' && observation.readiness !== undefined)
            return (
              observation.waitReason === undefined &&
              observation.readiness.reason === DecisionReadinessReason.SignalWindowObserved &&
              observation.readiness.availableAt !== undefined &&
              observation.readiness.availableAt > observation.observedAt
            )
          if (observation.outcome === 'WAITING')
            return observation.waitReason === 'BROKER_OBSERVATION_PENDING' && observation.readiness === undefined
          if (observation.recoveryAction === 'WAITING')
            return (observation.waitReason === undefined) !== (observation.readiness === undefined)
          return observation.waitReason === undefined && observation.readiness === undefined
        },
        { expected: 'exactly one readiness or lifecycle reason on each tagged waiting pass and none on other passes' },
      ),
    ),
    Schema.Struct({
      result: Schema.Literal('FAILURE'),
      executionIssuedAt: Schema.optionalKey(UtcInstantSchema),
      executionBuild: Schema.optionalKey(ExecutionBuildSchema),
      observedAt: UtcInstantSchema,
      jevObservationReferences: Schema.optionalKey(JevObservationReferencesSchema),
      alphaObservationReferences: Schema.optionalKey(AlphaObservationReferencesSchema),
      operation: Schema.Literals([
        'acquire-cycle',
        'build-decision',
        'build-cycle',
        'configure',
        'market-calendar',
        'reconcile',
        'read-oldest-unfinished',
        'read-authority-slot',
        'recover-cycle',
        'run-cycle-pass',
        'select-session',
      ]),
      failure: Schema.Literals([
        'calendar-read',
        'calendar-unavailable',
        'context',
        'contract',
        'database',
        'invalid-config',
        'market-data',
        'operational',
        'store',
      ]),
      message: Schema.NonEmptyString,
      brokerObservationFailure: Schema.optionalKey(Schema.Literal('NO_ADMISSIBLE_CUT')),
    }).check(
      Schema.makeFilter(
        (observation) =>
          observation.brokerObservationFailure === undefined ||
          (observation.failure === 'market-data' &&
            (observation.operation === 'reconcile' || observation.operation === 'build-decision')),
        { expected: 'local broker observation absence on a reconciliation or decision market-data failure' },
      ),
    ),
  ])

export const RetainedAutonomousCyclePassObservationSchema = cyclePassObservationSchemaForHold(JevPositionHoldSchema)
export type RetainedAutonomousCyclePassObservation = typeof RetainedAutonomousCyclePassObservationSchema.Type
