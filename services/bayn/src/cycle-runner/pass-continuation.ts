import type { AutonomousCycle } from '../cycle'
import type { CycleRunResult } from './model'

export type CyclePassProgress = 'ACTIVATED' | 'DECISION_BOUND' | 'DISCOVERED_EXISTING' | 'SNAPSHOT_BOUND'

export type CyclePassContinuation =
  | { readonly _tag: 'RETURN' }
  | {
      readonly _tag: 'CONTINUE'
      readonly cycle: AutonomousCycle
      readonly progress: CyclePassProgress
    }

const continueFromReadiness = (
  result: Extract<CycleRunResult, { readonly outcome: 'ACQUIRED' | 'REACQUIRED' | 'RESUMED' }>,
): CyclePassContinuation =>
  result.readiness.outcome === 'BOUND' || result.readiness.outcome === 'ALREADY_BOUND'
    ? { _tag: 'CONTINUE', cycle: result.readiness.cycle, progress: 'SNAPSHOT_BOUND' }
    : { _tag: 'RETURN' }

export const selectCyclePassContinuation = (result: CycleRunResult): CyclePassContinuation => {
  switch (result.outcome) {
    case 'ACQUIRED':
    case 'REACQUIRED':
    case 'RESUMED':
      return continueFromReadiness(result)
    case 'ALREADY_ACQUIRED':
      return { _tag: 'CONTINUE', cycle: result.cycle, progress: 'DISCOVERED_EXISTING' }
    case 'RECOVERED':
      switch (result.action) {
        case 'BOUND_SNAPSHOT':
          return { _tag: 'CONTINUE', cycle: result.cycle, progress: 'SNAPSHOT_BOUND' }
        case 'ACTIVATED':
          return { _tag: 'CONTINUE', cycle: result.cycle, progress: 'ACTIVATED' }
        case 'BOUND_DECISION':
          return { _tag: 'CONTINUE', cycle: result.cycle, progress: 'DECISION_BOUND' }
        case 'BLOCKED':
        case 'COMPLETED':
        case 'NO_TRADE':
        case 'WAITING':
          return { _tag: 'RETURN' }
      }
    case 'ALREADY_TERMINAL':
    case 'NO_PUBLICATION':
    case 'NOT_DUE':
      return { _tag: 'RETURN' }
  }
}
