import { Schema } from 'effect'

import { UtcInstantSchema } from '../../schemas'
import type { CycleRunResult, CycleRunnerError } from './model'

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
  }),
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

export type RetainedAutonomousCyclePassObservation =
  | {
      readonly result: 'SUCCESS'
      readonly observedAt: string
      readonly outcome: CycleRunResult['outcome']
    }
  | {
      readonly result: 'FAILURE'
      readonly observedAt: string
      readonly operation: CycleRunnerError['operation']
      readonly failure: CycleRunnerError['failure']
      readonly message: string
    }
