import { Schema } from 'effect'

import { Sha256Schema, UtcInstantSchema } from '../../schemas'
import { CycleWaitReasonSchema, DecisionReadinessSchema } from './readiness'

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
    observedAt: UtcInstantSchema,
    jevObservationReferences: Schema.optionalKey(JevObservationReferencesSchema),
    outcome: Schema.Literals([
      'WAITING',
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
    readiness: Schema.optionalKey(DecisionReadinessSchema),
  }).check(
    Schema.makeFilter(
      (observation) =>
        (observation.recoveryAction === undefined || observation.outcome === 'RECOVERED') &&
        (observation.outcome === 'WAITING'
          ? observation.waitReason === 'BROKER_OBSERVATION_PENDING' && observation.readiness === undefined
          : observation.recoveryAction === 'WAITING'
            ? (observation.waitReason === undefined) !== (observation.readiness === undefined)
            : observation.waitReason === undefined && observation.readiness === undefined),
      { expected: 'exactly one readiness or lifecycle reason on each tagged waiting pass and none on other passes' },
    ),
  ),
  Schema.Struct({
    result: Schema.Literal('FAILURE'),
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
