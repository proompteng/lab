import { Result } from 'effect'

import type { QualificationLock, QualificationResult } from './model'
import { Pipeable } from '../pipeable'

export type QualificationTerminalState =
  | { readonly state: 'PREREGISTERED'; readonly lock: QualificationLock }
  | { readonly state: 'TERMINAL'; readonly lock: QualificationLock; readonly result: QualificationResult }

export type QualificationTerminalDecision =
  | { readonly action: 'WRITE_TERMINAL'; readonly lock: QualificationLock; readonly result: QualificationResult }
  | { readonly action: 'REPLAY_TERMINAL'; readonly lock: QualificationLock; readonly result: QualificationResult }

export type QualificationTerminalConflict =
  | {
      readonly _tag: 'QualificationTerminalLockConflict'
      readonly preregisteredLockId: string
      readonly resultLockId: string
    }
  | {
      readonly _tag: 'QualificationTerminalRunConflict'
      readonly preregisteredRunId: string
      readonly resultRunId: string
    }
  | {
      readonly _tag: 'QualificationTerminalResultConflict'
      readonly committedResultHash: string
      readonly attemptedResultHash: string
    }

const decideQualificationTerminalDataFirst = (
  current: QualificationTerminalState,
  attempted: QualificationResult,
): Result.Result<QualificationTerminalDecision, QualificationTerminalConflict> => {
  if (attempted.lockId !== current.lock.lockId) {
    return Result.fail({
      _tag: 'QualificationTerminalLockConflict',
      preregisteredLockId: current.lock.lockId,
      resultLockId: attempted.lockId,
    })
  }
  if (attempted.runId !== current.lock.candidateRunId) {
    return Result.fail({
      _tag: 'QualificationTerminalRunConflict',
      preregisteredRunId: current.lock.candidateRunId,
      resultRunId: attempted.runId,
    })
  }
  if (current.state === 'PREREGISTERED') {
    return Result.succeed({ action: 'WRITE_TERMINAL', lock: current.lock, result: attempted })
  }
  return current.result.resultHash === attempted.resultHash
    ? Result.succeed({ action: 'REPLAY_TERMINAL', lock: current.lock, result: current.result })
    : Result.fail({
        _tag: 'QualificationTerminalResultConflict',
        committedResultHash: current.result.resultHash,
        attemptedResultHash: attempted.resultHash,
      })
}

export const decideQualificationTerminal = Pipeable.dual(2, decideQualificationTerminalDataFirst)
