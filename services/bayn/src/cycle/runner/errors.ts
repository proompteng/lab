import type { CycleCalendarQueryFailure } from './calendar-decisions'
import { runnerError, type CycleRunnerError } from './model'

export const calendarQueryFailureError = (cause: CycleCalendarQueryFailure): CycleRunnerError =>
  runnerError({
    operation: 'market-calendar',
    failure: 'invalid-config',
    message: 'intraday market-calendar query range is invalid',
    cause,
  })
