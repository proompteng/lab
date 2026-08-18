import { Schema } from 'effect'

import { MonthEndCadenceCondition, MonthEndCadenceReason, type MonthEndCadenceDecision } from '../observability'
import { IsoDateSchema, UtcInstantSchema } from '../../schemas'
import { CycleNotDueReason, type CycleRunResult, type CycleRunnerError } from './model'

export const MonthEndCadenceDecisionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.month-end-cadence-decision.v1'),
  condition: Schema.Literals([
    MonthEndCadenceCondition.Due,
    MonthEndCadenceCondition.ExpectedWait,
    MonthEndCadenceCondition.Unknown,
  ]),
  reason: Schema.Literals([
    MonthEndCadenceReason.SignalAndExecutionSessionSameMonth,
    MonthEndCadenceReason.SignalToExecutionMonthTransition,
    MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence,
  ]),
  signalSessionDate: Schema.NullOr(IsoDateSchema),
  executionSessionDate: Schema.NullOr(IsoDateSchema),
  nextEligibility: Schema.Union([
    Schema.Struct({
      status: Schema.Literal('PROVEN'),
      sessionDate: IsoDateSchema,
      basis: Schema.Literal('EXECUTION_SESSION_MONTH_TRANSITION'),
    }),
    Schema.Struct({
      status: Schema.Literal('UNKNOWN'),
      reason: Schema.Literals([
        MonthEndCadenceReason.FutureCalendarEvidenceUnavailable,
        MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence,
      ]),
    }),
  ]),
})

export const RetainedAutonomousCyclePassObservationSchema = Schema.Union([
  Schema.Struct({
    result: Schema.Literal('SUCCESS'),
    observedAt: UtcInstantSchema,
    outcome: Schema.Literals([
      'NO_PUBLICATION',
      'ALREADY_ACQUIRED',
      'ALREADY_TERMINAL',
      'RESUMED',
      'RECOVERED',
      'NOT_DUE',
      'ACQUIRED',
      'REACQUIRED',
    ]),
    cadence: Schema.optionalKey(Schema.Literals(['MONTHLY', 'EVERY_SESSION'])),
    notDueReason: Schema.optionalKey(Schema.Enum(CycleNotDueReason)),
    cadenceDecision: Schema.optionalKey(MonthEndCadenceDecisionSchema),
  }),
  Schema.Struct({
    result: Schema.Literal('FAILURE'),
    observedAt: UtcInstantSchema,
    cadence: Schema.optionalKey(Schema.Literals(['MONTHLY', 'EVERY_SESSION'])),
    operation: Schema.Literals([
      'acquire-cycle',
      'bind-publication',
      'build-decision',
      'build-cycle',
      'configure',
      'inspect-publication',
      'load-context',
      'market-calendar',
      'read-oldest-unfinished',
      'read-authority-slot',
      'reconcile-not-due',
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

export type RetainedAutonomousCyclePassObservation =
  | {
      readonly result: 'SUCCESS'
      readonly observedAt: string
      readonly outcome: CycleRunResult['outcome']
      readonly cadence?: 'MONTHLY' | 'EVERY_SESSION'
      readonly notDueReason?: CycleNotDueReason
      readonly cadenceDecision?: MonthEndCadenceDecision
    }
  | {
      readonly result: 'FAILURE'
      readonly observedAt: string
      readonly cadence?: 'MONTHLY' | 'EVERY_SESSION'
      readonly operation: CycleRunnerError['operation']
      readonly failure: CycleRunnerError['failure']
      readonly message: string
    }
