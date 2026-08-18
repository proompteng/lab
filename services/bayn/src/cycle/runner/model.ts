import { Data, Effect } from 'effect'

import type { SignalSessionRow } from '../../market-data'
import type { CycleDecisionDocument } from '../../shadow-decision-contract'
import type { AutonomousCycle, CycleExecutionPolicy } from '../model'
import type { CyclePublicationReadiness } from '../readiness'
import type { CycleAcquireReceipt } from '../store'

type SignalCycleSession = Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'close_time' | 'timezone'>

/**
 * `CAPITAL_BOOTSTRAP` is accepted only while pre-every-session callers are upgraded. New execution paths must use
 * `EVERY_SESSION`; neither value is persisted in an autonomous-cycle row.
 */
export type CycleCadence = 'MONTHLY' | 'EVERY_SESSION' | 'CAPITAL_BOOTSTRAP'

export const isEverySessionCycleCadence = (cadence: CycleCadence | undefined): boolean =>
  cadence === 'EVERY_SESSION' || cadence === 'CAPITAL_BOOTSTRAP'

export class CycleDecisionBuildError extends Data.TaggedError('CycleDecisionBuildError')<{
  readonly failure: 'contract' | 'database' | 'market-data' | 'operational' | 'store'
  readonly message: string
  readonly cause?: unknown
}> {}

export class CycleNotDueReconciliationError extends Data.TaggedError('CycleNotDueReconciliationError')<{
  readonly failure: 'contract' | 'database' | 'market-data' | 'operational' | 'store'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CycleRunContext<R = never> {
  readonly qualificationRunId: string
  readonly cadence?: CycleCadence
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly executionPolicy: CycleExecutionPolicy
  readonly buildDecision: (
    cycle: AutonomousCycle,
    reconciliationCompleted?: Effect.Effect<void>,
  ) => Effect.Effect<CycleDecisionDocument, CycleDecisionBuildError, R>
}

export interface CycleCandidate {
  readonly qualificationRunId: string
  readonly cadence?: CycleCadence
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly signalSession: SignalCycleSession
  readonly executionPolicy: CycleExecutionPolicy
}

export enum CycleNotDueReason {
  MonthEndCadence = 'MONTH_END_CADENCE',
  StaleExecutionBootstrap = 'STALE_CAPITAL_BOOTSTRAP',
}

export type CycleBindingResult = Exclude<CyclePublicationReadiness, { readonly outcome: 'WAITING' }>

export type CycleRunResult =
  | {
      readonly outcome: 'NO_PUBLICATION'
      readonly observedAt: string
    }
  | {
      readonly outcome: 'ALREADY_ACQUIRED'
      readonly signalSessionDate: string
      readonly observedAt: string
      readonly cycle: CycleBindingResult['cycle']
    }
  | {
      readonly outcome: 'ALREADY_TERMINAL'
      readonly signalSessionDate: string
      readonly observedAt: string
      readonly cycle: AutonomousCycle
    }
  | {
      readonly outcome: 'RESUMED'
      readonly signalSessionDate: string
      readonly observedAt: string
      readonly readiness: CycleBindingResult
    }
  | {
      readonly outcome: 'RECOVERED'
      readonly action:
        | 'ACTIVATED'
        | 'BLOCKED'
        | 'BOUND_DECISION'
        | 'BOUND_SNAPSHOT'
        | 'COMPLETED'
        | 'NO_TRADE'
        | 'WAITING'
      readonly observedAt: string
      readonly cycle: AutonomousCycle
    }
  | {
      readonly outcome: 'NOT_DUE'
      /** Optional only for compatibility with lifecycle observations persisted before reasons were recorded. */
      readonly reason?: CycleNotDueReason
      readonly signalSessionDate: string
      readonly executionSessionDate: string
      readonly observedAt: string
      readonly calendarResponseHash: string
      readonly calendarReadContentHash: string
    }
  | {
      readonly outcome: 'ACQUIRED' | 'REACQUIRED'
      readonly signalSessionDate: string
      readonly executionSessionDate: string
      readonly observedAt: string
      readonly calendarResponseHash: string
      readonly calendarReadContentHash: string
      readonly receipt: CycleAcquireReceipt
      readonly readiness: CycleBindingResult
    }

export class CycleRunnerError extends Data.TaggedError('CycleRunnerError')<{
  readonly operation:
    | 'acquire-cycle'
    | 'bind-publication'
    | 'build-decision'
    | 'build-cycle'
    | 'configure'
    | 'inspect-publication'
    | 'load-context'
    | 'market-calendar'
    | 'read-oldest-unfinished'
    | 'read-authority-slot'
    | 'reconcile-not-due'
    | 'recover-cycle'
    | 'run-cycle-pass'
    | 'select-session'
  readonly failure:
    | 'calendar-read'
    | 'calendar-unavailable'
    | 'context'
    | 'contract'
    | 'database'
    | 'invalid-config'
    | 'market-data'
    | 'operational'
    | 'store'
  readonly message: string
  readonly cause?: unknown
}> {}

export type CyclePassObservation =
  | {
      readonly outcome: 'SUCCEEDED'
      readonly observedAt: string
      readonly result: CycleRunResult
    }
  | {
      readonly outcome: 'FAILED'
      readonly observedAt: string
      readonly error: CycleRunnerError
    }

export interface ReconciliationCadenceState {
  readonly lastAttemptAtNanos?: bigint
  readonly lastFailure?: CycleRunnerError
}

export type IdleReconciliationCadenceDecision =
  | { readonly _tag: 'RECONCILE' }
  | { readonly _tag: 'WAIT'; readonly remainingNanos: bigint }

export interface AutonomousCycleLoopOptions<E = never, ContextR = never, DecisionR = never> {
  readonly context: Effect.Effect<CycleRunContext<DecisionR>, E, ContextR>
  readonly observePass: (observation: CyclePassObservation) => Effect.Effect<void>
  readonly cyclePassTimeoutMs: number
  readonly pollIntervalMs: number
  readonly reconciliationIntervalMs: number
  readonly reconcileNotDue: Effect.Effect<void, CycleNotDueReconciliationError, DecisionR>
}

export interface CycleRunnerErrorInput {
  readonly operation: CycleRunnerError['operation']
  readonly failure: CycleRunnerError['failure']
  readonly message: string
  readonly cause?: unknown
}

export const runnerError = (input: CycleRunnerErrorInput): CycleRunnerError => new CycleRunnerError(input)
