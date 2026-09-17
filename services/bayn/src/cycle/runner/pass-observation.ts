import { Schema } from 'effect'

import { UtcInstantSchema } from '../../schemas'
import { CycleWaitReasonSchema, DecisionReadinessSchema } from './readiness'

export const RetainedAutonomousCyclePassObservationSchema = Schema.Union([
  Schema.Struct({
    result: Schema.Literal('SUCCESS'),
    observedAt: UtcInstantSchema,
    outcome: Schema.Literals([
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
        ((observation.waitReason === undefined && observation.readiness === undefined) ||
          (observation.outcome === 'RECOVERED' && observation.recoveryAction === 'WAITING')) &&
        (observation.waitReason === undefined || observation.readiness === undefined),
      { expected: 'waiting details only on a recovered waiting pass, with one readiness or lifecycle reason' },
    ),
  ),
  Schema.Struct({
    result: Schema.Literal('FAILURE'),
    observedAt: UtcInstantSchema,
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
