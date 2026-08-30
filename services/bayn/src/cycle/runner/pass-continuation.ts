import type { AutonomousCycle } from '../model'
import type { CycleRunResult } from './model'

export type CyclePassProgress = 'ACTIVATED' | 'DECISION_BOUND' | 'DISCOVERED_EXISTING'

export type CyclePassContinuation =
  | { readonly _tag: 'RETURN' }
  | {
      readonly _tag: 'CONTINUE'
      readonly cycle: AutonomousCycle
      readonly progress: CyclePassProgress
    }

export const selectCyclePassContinuation = (result: CycleRunResult): CyclePassContinuation => {
  switch (result.outcome) {
    case 'ACQUIRED':
    case 'REACQUIRED':
      return { _tag: 'CONTINUE', cycle: result.receipt.cycle, progress: 'DISCOVERED_EXISTING' }
    case 'ALREADY_ACQUIRED':
      return { _tag: 'CONTINUE', cycle: result.cycle, progress: 'DISCOVERED_EXISTING' }
    case 'RECOVERED':
      switch (result.action) {
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
    case 'WINDOW_CLOSED':
      return { _tag: 'RETURN' }
  }
}
