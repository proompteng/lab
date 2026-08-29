import { Data, Effect } from 'effect'

import type { CycleDecisionDocument } from '../../shadow-decision-contract'
import type { AutonomousCycle, CycleExecutionPolicy } from '../model'
import type { CycleAcquireReceipt, CycleDecisionBindingEvidence } from '../store'

export class CycleDecisionBuildError extends Data.TaggedError('CycleDecisionBuildError')<{
  readonly failure: 'contract' | 'database' | 'market-data' | 'not-ready' | 'operational' | 'store'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CycleRunContext<R = never> {
  readonly cycleBindingId: string
  readonly strategyName: 'intraday-momentum'
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly executionPolicy: Extract<
    CycleExecutionPolicy,
    { readonly schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3' }
  >
  readonly buildDecision: (
    cycle: AutonomousCycle,
    reconciliationCompleted?: Effect.Effect<void>,
  ) => Effect.Effect<CycleDecisionDocument, CycleDecisionBuildError, R>
  readonly buildDecisionEvidence?: (
    document: CycleDecisionDocument,
  ) => Effect.Effect<CycleDecisionBindingEvidence, CycleDecisionBuildError, R>
}

export type CycleRunResult =
  | {
      readonly outcome: 'WINDOW_CLOSED'
      readonly observedAt: string
    }
  | {
      readonly outcome: 'ALREADY_ACQUIRED' | 'ALREADY_TERMINAL'
      readonly observedAt: string
      readonly cycle: AutonomousCycle
    }
  | {
      readonly outcome: 'RECOVERED'
      readonly action: 'ACTIVATED' | 'BLOCKED' | 'BOUND_DECISION' | 'COMPLETED' | 'NO_TRADE' | 'WAITING'
      readonly observedAt: string
      readonly cycle: AutonomousCycle
    }
  | {
      readonly outcome: 'ACQUIRED' | 'REACQUIRED'
      readonly executionSessionDate: string
      readonly observedAt: string
      readonly calendarResponseHash: string
      readonly calendarReadContentHash: string
      readonly receipt: CycleAcquireReceipt
    }

export class CycleRunnerError extends Data.TaggedError('CycleRunnerError')<{
  readonly operation:
    | 'acquire-cycle'
    | 'build-decision'
    | 'build-cycle'
    | 'configure'
    | 'market-calendar'
    | 'reconcile'
    | 'read-oldest-unfinished'
    | 'read-authority-slot'
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

export interface CycleRunnerErrorInput {
  readonly operation: CycleRunnerError['operation']
  readonly failure: CycleRunnerError['failure']
  readonly message: string
  readonly cause?: unknown
}

export const runnerError = (input: CycleRunnerErrorInput): CycleRunnerError => new CycleRunnerError(input)
