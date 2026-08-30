import { Result } from 'effect'

import { Pipeable } from '../../pipeable'
import { CycleState, type AutonomousCycle } from '../model'
import type { CycleRecoverySelection } from '../recovery'
import { runnerError, type CyclePassObservation, type CycleRunnerError, type CycleRunResult } from './model'
import type { RetainedAutonomousCyclePassObservation } from './pass-observation'

export type { RetainedAutonomousCyclePassObservation } from './pass-observation'

const finishRecoveryResultDataFirst = (
  selection: Extract<CycleRecoverySelection, { readonly action: 'FINISH' }>,
  cycle: AutonomousCycle,
): Result.Result<CycleRunResult, CycleRunnerError> => {
  const result = (
    action: Extract<CycleRunResult, { readonly outcome: 'RECOVERED' }>['action'],
  ): Result.Result<CycleRunResult, CycleRunnerError> =>
    Result.succeed({ outcome: 'RECOVERED', action, observedAt: selection.observedAt, cycle })

  switch (cycle.state) {
    case CycleState.Completed:
      return result('COMPLETED')
    case CycleState.NoTrade:
      return result('NO_TRADE')
    case CycleState.Blocked:
      return result('BLOCKED')
    default:
      return Result.fail(
        runnerError({
          operation: 'recover-cycle',
          failure: 'contract',
          message: 'cycle finish did not produce a terminal state',
        }),
      )
  }
}

export const finishRecoveryResult = Pipeable.dual(2, finishRecoveryResultDataFirst)

export interface CyclePassLogFacts {
  readonly level: 'INFO' | 'ERROR'
  readonly message: string
  readonly annotations: Readonly<Partial<Record<string, string | boolean>>>
}

export const retainAutonomousCyclePassObservation = (
  observation: CyclePassObservation,
): RetainedAutonomousCyclePassObservation => {
  if (observation.outcome === 'FAILED') {
    return {
      result: 'FAILURE',
      observedAt: observation.observedAt,
      operation: observation.error.operation,
      failure: observation.error.failure,
      message: observation.error.message,
    }
  }

  return {
    result: 'SUCCESS',
    observedAt: observation.observedAt,
    outcome: observation.result.outcome,
  }
}

const cycleAnnotations = (cycle: AutonomousCycle): Readonly<Partial<Record<string, string | boolean>>> => ({
  cycleId: cycle.identity.cycleId,
  cycleState: cycle.state,
  executionSessionDate: cycle.identity.executionSessionDate,
})

export const cyclePassLogFacts = (observation: CyclePassObservation): CyclePassLogFacts => {
  if (observation.outcome === 'FAILED') {
    return {
      level: 'ERROR',
      message: 'Bayn autonomous cycle pass failed',
      annotations: {
        operation: observation.error.operation,
        failure: observation.error.failure,
        message: observation.error.message,
      },
    }
  }

  const result = observation.result
  switch (result.outcome) {
    case 'WINDOW_CLOSED':
      return {
        level: 'INFO',
        message: 'Bayn intraday execution window is closed',
        annotations: { outcome: result.outcome, observedAt: result.observedAt },
      }
    case 'ACQUIRED':
    case 'REACQUIRED':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          executionSessionDate: result.executionSessionDate,
          observedAt: result.observedAt,
          calendarResponseHash: result.calendarResponseHash,
          calendarReadContentHash: result.calendarReadContentHash,
          persistenceDeduplicated: !result.receipt.created,
          ...cycleAnnotations(result.receipt.cycle),
        },
      }
    case 'ALREADY_ACQUIRED':
    case 'ALREADY_TERMINAL':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          observedAt: result.observedAt,
          ...cycleAnnotations(result.cycle),
        },
      }
    case 'RECOVERED':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          recoveryAction: result.action,
          observedAt: result.observedAt,
          ...cycleAnnotations(result.cycle),
        },
      }
  }
}

export const validateCycleLoopInterval = (pollIntervalMs: number): Result.Result<number, CycleRunnerError> =>
  Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0
    ? Result.succeed(pollIntervalMs)
    : Result.fail(
        runnerError({
          operation: 'configure',
          failure: 'invalid-config',
          message: 'cycle loop interval must be a positive safe integer',
        }),
      )
