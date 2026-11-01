import { Schema } from 'effect'

import { IsoDateSchema, Sha256Schema, UtcDatabaseInstantSchema, UtcInstantSchema } from '../../schemas'
import { CycleWaitReasonSchema, DecisionReadinessReason, DecisionReadinessSchema } from './readiness'
import { JevPositionHoldSchema } from '../../jev/hold'
import { JevEntryTargetSchema } from '../../jev/decision'
import { EntryAblationTargetSchema } from '../../jev/entry-ablation'
import { RepeatedMomentumTargetSchema } from '../../strategy/repeated-momentum/decision'
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

export const maximumRetainedJevObservationReferences = 16
export const JevObservationReferencesSchema = Schema.Struct({
  hashes: Schema.Array(Sha256Schema).check(
    Schema.isMaxLength(maximumRetainedJevObservationReferences),
    Schema.makeFilter((hashes) => hashes.every((hash, index) => hash > (hashes[index - 1] ?? '')), {
      expected: 'unique Jev observation hashes in canonical order',
    }),
  ),
  complete: Schema.Boolean,
})

export const RetainedAutonomousCyclePassObservationSchema = Schema.Union([
  Schema.Struct({
    result: Schema.Literal('SUCCESS'),
    executionIssuedAt: Schema.optionalKey(UtcInstantSchema),
    observedAt: UtcInstantSchema,
    jevObservationReferences: Schema.optionalKey(JevObservationReferencesSchema),
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
    recoveryAction: Schema.optionalKey(
      Schema.Literals(['ACTIVATED', 'BLOCKED', 'BOUND_DECISION', 'COMPLETED', 'NO_TRADE', 'WAITING']),
    ),
    waitReason: Schema.optionalKey(CycleWaitReasonSchema),
    positionHold: Schema.optionalKey(JevPositionHoldSchema),
    entryAbstention: Schema.optionalKey(
      Schema.Union([JevEntryTargetSchema, EntryAblationTargetSchema, RepeatedMomentumTargetSchema]).check(
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
        if (observation.outcome === 'ADMISSION_WAITING')
          return (
            observation.waitReason === undefined &&
            observation.readiness?.reason === DecisionReadinessReason.AccountProtection &&
            observation.admissionProtection !== undefined &&
            observation.admissionProtection.validUntil > observation.observedAt &&
            observation.nextWakeAt === undefined
          )
        if (observation.admissionProtection !== undefined) return false
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
    observedAt: UtcInstantSchema,
    jevObservationReferences: Schema.optionalKey(JevObservationReferencesSchema),
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
  }),
])

export type RetainedAutonomousCyclePassObservation = typeof RetainedAutonomousCyclePassObservationSchema.Type
