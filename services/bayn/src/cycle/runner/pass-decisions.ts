import { Result } from 'effect'

import { Pipeable } from '../../pipeable'
import { CycleState, type AutonomousCycle } from '../model'
import { decideMonthEndCadenceEligibility, type MonthEndCadenceDecision } from '../observability'
import type { CycleReadinessError } from '../readiness'
import type { CycleRecoverySelection } from '../recovery'
import {
  runnerError,
  type CycleNotDueReason,
  type CyclePassObservation,
  type CycleRunnerError,
  type CycleRunResult,
} from './model'

export const readinessFailure = (cause: CycleReadinessError): CycleRunnerError['failure'] => {
  switch (cause.failure) {
    case 'store':
      return 'store'
    case 'market-data':
      return 'market-data'
    case 'contract':
      return 'contract'
  }
}

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

const cadenceDecisionFromCycle = (cycle: AutonomousCycle): MonthEndCadenceDecision =>
  decideMonthEndCadenceEligibility({
    signalSessionDate: cycle.identity.signalSessionDate,
    executionSessionDate: cycle.identity.executionSessionDate,
  })

export const cycleRunResultCadenceDecision = (result: CycleRunResult): MonthEndCadenceDecision | undefined => {
  switch (result.outcome) {
    case 'NO_PUBLICATION':
      return undefined
    case 'NOT_DUE':
    case 'ACQUIRED':
    case 'REACQUIRED':
      return decideMonthEndCadenceEligibility({
        signalSessionDate: result.signalSessionDate,
        executionSessionDate: result.executionSessionDate,
      })
    case 'ALREADY_ACQUIRED':
    case 'ALREADY_TERMINAL':
    case 'RECOVERED':
      return cadenceDecisionFromCycle(result.cycle)
    case 'RESUMED':
      return cadenceDecisionFromCycle(result.readiness.cycle)
  }
}

export type RetainedAutonomousCyclePassObservation =
  | {
      readonly result: 'SUCCESS'
      readonly observedAt: string
      readonly outcome: CycleRunResult['outcome']
      readonly notDueReason?: CycleNotDueReason
      readonly cadenceDecision?: MonthEndCadenceDecision
    }
  | {
      readonly result: 'FAILURE'
      readonly observedAt: string
      readonly operation: CycleRunnerError['operation']
      readonly failure: CycleRunnerError['failure']
      readonly message: string
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
  const cadenceDecision = cycleRunResultCadenceDecision(observation.result)
  return {
    result: 'SUCCESS',
    observedAt: observation.observedAt,
    outcome: observation.result.outcome,
    ...(observation.result.outcome === 'NOT_DUE' && observation.result.reason !== undefined
      ? { notDueReason: observation.result.reason }
      : {}),
    ...(cadenceDecision === undefined ? {} : { cadenceDecision }),
  }
}

const cadenceLogAnnotations = (
  decision: MonthEndCadenceDecision,
): Readonly<Partial<Record<string, string | boolean>>> => ({
  cadenceCondition: decision.condition,
  cadenceReason: decision.reason,
  nextEligibilityStatus: decision.nextEligibility.status,
  ...(decision.nextEligibility.status === 'PROVEN'
    ? {
        nextEligibleSessionDate: decision.nextEligibility.sessionDate,
        nextEligibilityBasis: decision.nextEligibility.basis,
      }
    : { nextEligibilityReason: decision.nextEligibility.reason }),
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
  const cadenceDecision = cycleRunResultCadenceDecision(result)
  const cadenceAnnotations = cadenceDecision === undefined ? {} : cadenceLogAnnotations(cadenceDecision)
  switch (result.outcome) {
    case 'NO_PUBLICATION':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: { outcome: result.outcome, observedAt: result.observedAt },
      }
    case 'ALREADY_ACQUIRED':
    case 'ALREADY_TERMINAL':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          executionSessionDate: result.cycle.identity.executionSessionDate,
          observedAt: result.observedAt,
          cycleId: result.cycle.identity.cycleId,
          cycleState: result.cycle.state,
          ...cadenceAnnotations,
        },
      }
    case 'RESUMED':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          executionSessionDate: result.readiness.cycle.identity.executionSessionDate,
          observedAt: result.observedAt,
          cycleId: result.readiness.cycle.identity.cycleId,
          cycleState: result.readiness.cycle.state,
          publicationReadiness: result.readiness.outcome,
          ...cadenceAnnotations,
        },
      }
    case 'RECOVERED':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          recoveryAction: result.action,
          signalSessionDate: result.cycle.identity.signalSessionDate,
          executionSessionDate: result.cycle.identity.executionSessionDate,
          observedAt: result.observedAt,
          cycleId: result.cycle.identity.cycleId,
          cycleState: result.cycle.state,
          ...cadenceAnnotations,
        },
      }
    case 'NOT_DUE':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          ...(result.reason === undefined ? {} : { notDueReason: result.reason }),
          signalSessionDate: result.signalSessionDate,
          executionSessionDate: result.executionSessionDate,
          observedAt: result.observedAt,
          calendarResponseHash: result.calendarResponseHash,
          calendarReadContentHash: result.calendarReadContentHash,
          ...cadenceAnnotations,
        },
      }
    case 'ACQUIRED':
    case 'REACQUIRED':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          executionSessionDate: result.executionSessionDate,
          observedAt: result.observedAt,
          calendarResponseHash: result.calendarResponseHash,
          calendarReadContentHash: result.calendarReadContentHash,
          cycleId: result.readiness.cycle.identity.cycleId,
          cycleState: result.readiness.cycle.state,
          publicationReadiness: result.readiness.outcome,
          persistenceDeduplicated: !result.receipt.created,
          ...cadenceAnnotations,
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
