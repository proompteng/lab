import { Data, Effect } from 'effect'

import type { AutonomousCycle, CycleExecutionPolicy } from '../cycle'
import type { CyclePublicationReadiness } from '../cycle-readiness'
import type { CycleAcquireReceipt } from '../db/cycle-store'
import type { SignalSessionRow } from '../market-data'
import type { ObserveShadowDecisionDocument } from '../shadow-decision-contract'

type SignalCycleSession = Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'close_time' | 'timezone'>

export class CycleDecisionBuildError extends Data.TaggedError('CycleDecisionBuildError')<{
  readonly failure: 'contract' | 'database' | 'market-data' | 'operational' | 'store'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CycleRunContext {
  readonly qualificationRunId: string
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly executionPolicy: CycleExecutionPolicy
  readonly buildDecision: (
    cycle: AutonomousCycle,
  ) => Effect.Effect<ObserveShadowDecisionDocument, CycleDecisionBuildError>
}

export interface CycleCandidate {
  readonly qualificationRunId: string
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly signalSession: SignalCycleSession
  readonly executionPolicy: CycleExecutionPolicy
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
    | 'recover-cycle'
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

export interface AutonomousCycleLoopOptions<E = never, R = never> {
  readonly context: Effect.Effect<CycleRunContext, E, R>
  readonly observePass: (observation: CyclePassObservation) => Effect.Effect<void>
  readonly pollIntervalMs: number
}

export const runnerError = (
  operation: CycleRunnerError['operation'],
  failure: CycleRunnerError['failure'],
  message: string,
  cause?: unknown,
): CycleRunnerError => new CycleRunnerError({ operation, failure, message, cause })
