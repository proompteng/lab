import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { CycleState, type AutonomousCycle, type CycleDraft } from './model'
import { Pipeable } from '../pipeable'

export const isTerminalCycleState = (state: CycleState): boolean =>
  state === CycleState.Completed || state === CycleState.NoTrade || state === CycleState.Blocked

const isCycleStateTransitionAllowedDataFirst = (from: CycleState, to: CycleState): boolean => {
  if (from === CycleState.Pending) return to === CycleState.Active || to === CycleState.Blocked
  if (from === CycleState.Active) {
    return to === CycleState.Completed || to === CycleState.NoTrade || to === CycleState.Blocked
  }
  return false
}

export const isCycleStateTransitionAllowed = Pipeable.dual(2, isCycleStateTransitionAllowedDataFirst)

export const cycleDraftOf = (cycle: AutonomousCycle): CycleDraft => ({
  schemaVersion: cycle.schemaVersion,
  identity: cycle.identity,
  window: cycle.window,
})

const cycleDraftMatchesDataFirst = (left: CycleDraft, right: CycleDraft): boolean => {
  const leftHash = canonicalHashV1Result(left)
  if (Result.isFailure(leftHash)) return false
  const rightHash = canonicalHashV1Result(right)
  return Result.isSuccess(rightHash) && leftHash.success === rightHash.success
}

export const cycleDraftMatches = Pipeable.dual(2, cycleDraftMatchesDataFirst)
