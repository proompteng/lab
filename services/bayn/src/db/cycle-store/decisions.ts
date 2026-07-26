import { Result, Schema } from 'effect'

import {
  CycleState,
  CycleTerminalReason,
  cycleDraftMatches,
  cycleDraftOf,
  isCycleStateTransitionAllowed,
  type AutonomousCycle,
  type CycleCompletionState,
  type CycleDraft,
} from '../../cycle'
import { cycleTerminalReasonForBlockedTargetPlan } from '../../cycle-recovery'
import { ObserveShadowDecisionDocumentSchema, type ObserveShadowDecisionDocument } from '../../shadow-decision-contract'
import { TargetPlanStatus } from '../../target-planner'
import type { InputManifest } from '../../types'

export interface CycleStoreDecisionFailure {
  readonly failure: 'conflict' | 'invariant' | 'not-found'
  readonly message: string
}

export type AcquireDecision =
  | {
      readonly _tag: 'Return'
      readonly cycle: AutonomousCycle
      readonly created: boolean
    }
  | {
      readonly _tag: 'Block'
      readonly cycle: AutonomousCycle
      readonly created: boolean
      readonly reason: CycleTerminalReason.MissedPublication
    }

export type SnapshotDecision =
  | {
      readonly _tag: 'Replay'
      readonly cycle: AutonomousCycle
    }
  | {
      readonly _tag: 'Persist'
      readonly cycle: AutonomousCycle
      readonly snapshotId: string
    }
  | {
      readonly _tag: 'Block'
      readonly cycle: AutonomousCycle
      readonly reason: CycleTerminalReason.MissedPublication
    }

export type ActivationDecision =
  | {
      readonly _tag: 'Replay'
      readonly cycle: AutonomousCycle
    }
  | {
      readonly _tag: 'Persist'
      readonly cycle: AutonomousCycle
    }
  | {
      readonly _tag: 'Block'
      readonly cycle: AutonomousCycle
      readonly reason: CycleTerminalReason.MissedSubmission
    }

export type DecisionBindingDecision =
  | {
      readonly _tag: 'Replay'
      readonly cycle: AutonomousCycle
    }
  | {
      readonly _tag: 'Persist'
      readonly cycle: AutonomousCycle
      readonly document: ObserveShadowDecisionDocument
    }
  | {
      readonly _tag: 'Block'
      readonly cycle: AutonomousCycle
      readonly reason: CycleTerminalReason.MissedSubmission
    }

export type CompletionDecision =
  | {
      readonly _tag: 'Replay'
      readonly cycle: AutonomousCycle
    }
  | {
      readonly _tag: 'VerifyDecision'
      readonly cycle: AutonomousCycle
      readonly decisionHash: string
      readonly state: CycleCompletionState
    }

export type BlockDecision =
  | {
      readonly _tag: 'Replay'
      readonly cycle: AutonomousCycle
    }
  | {
      readonly _tag: 'Persist'
      readonly cycle: AutonomousCycle
      readonly reason: CycleTerminalReason
    }
  | {
      readonly _tag: 'VerifyDecision'
      readonly cycle: AutonomousCycle
      readonly reason: CycleTerminalReason
      readonly decisionHash: string
    }

const fail = (
  failure: CycleStoreDecisionFailure['failure'],
  message: string,
): Result.Result<never, CycleStoreDecisionFailure> => Result.fail({ failure, message })

const shadowDecisionEquivalent = Schema.toEquivalence(ObserveShadowDecisionDocumentSchema)

export const makeInitialCycle = (draft: CycleDraft, observedAt: string): AutonomousCycle => {
  const missedPublication = observedAt >= draft.window.publicationDeadlineAt
  return {
    ...draft,
    state: missedPublication ? CycleState.Blocked : CycleState.Pending,
    bindings: {},
    ...(missedPublication
      ? {
          terminalReason: CycleTerminalReason.MissedPublication,
          terminalAt: observedAt,
        }
      : {}),
    stateVersion: 1,
    createdAt: observedAt,
    updatedAt: observedAt,
  }
}

export const decideAcquire = (
  stored: AutonomousCycle,
  draft: CycleDraft,
  observedAt: string,
  created: boolean,
): Result.Result<AcquireDecision, CycleStoreDecisionFailure> => {
  if (!cycleDraftMatches(cycleDraftOf(stored), draft)) {
    return fail('conflict', 'stored cycle differs from deterministic acquisition input')
  }
  return Result.succeed(
    stored.state === CycleState.Pending && observedAt >= stored.window.publicationDeadlineAt
      ? {
          _tag: 'Block',
          cycle: stored,
          created,
          reason: CycleTerminalReason.MissedPublication,
        }
      : { _tag: 'Return', cycle: stored, created },
  )
}

export const decideSnapshotBinding = (
  cycle: AutonomousCycle,
  snapshot: InputManifest['finalizedSnapshot'],
  observedAt: string,
): Result.Result<SnapshotDecision, CycleStoreDecisionFailure> => {
  if (observedAt < cycle.window.signalCloseAt) {
    return fail('invariant', 'snapshot binding cannot precede the Signal session close')
  }
  if (
    snapshot.asOfSession !== cycle.identity.signalSessionDate ||
    snapshot.lastSession !== cycle.identity.signalSessionDate ||
    snapshot.calendarVersion !== cycle.identity.signalCalendarVersion
  ) {
    return fail('invariant', 'finalized Signal publication does not match the cycle signal session and calendar')
  }
  if (cycle.bindings.snapshotId !== undefined) {
    return cycle.bindings.snapshotId === snapshot.snapshotId
      ? Result.succeed({ _tag: 'Replay', cycle })
      : fail('conflict', 'cycle snapshot binding cannot be replaced')
  }
  if (cycle.state !== CycleState.Pending) {
    return fail('conflict', 'snapshot may bind only while a cycle is pending')
  }
  if (observedAt >= cycle.window.publicationDeadlineAt) {
    return Result.succeed({
      _tag: 'Block',
      cycle,
      reason: CycleTerminalReason.MissedPublication,
    })
  }
  return observedAt < cycle.updatedAt
    ? fail('conflict', 'cycle update time cannot move backward')
    : Result.succeed({ _tag: 'Persist', cycle, snapshotId: snapshot.snapshotId })
}

export const decideActivation = (
  cycle: AutonomousCycle,
  observedAt: string,
): Result.Result<ActivationDecision, CycleStoreDecisionFailure> => {
  if (cycle.state === CycleState.Active) return Result.succeed({ _tag: 'Replay', cycle })
  if (!isCycleStateTransitionAllowed(cycle.state, CycleState.Active)) {
    return fail('conflict', 'only a pending cycle may become active')
  }
  if (cycle.bindings.snapshotId === undefined) {
    return fail('invariant', 'cycle activation requires a bound snapshot')
  }
  if (observedAt >= cycle.window.submissionCutoffAt) {
    return Result.succeed({
      _tag: 'Block',
      cycle,
      reason: CycleTerminalReason.MissedSubmission,
    })
  }
  return observedAt < cycle.updatedAt
    ? fail('conflict', 'cycle update time cannot move backward')
    : Result.succeed({ _tag: 'Persist', cycle })
}

export const decideDecisionBinding = (
  cycle: AutonomousCycle,
  document: ObserveShadowDecisionDocument,
  observedAt: string,
  storedDocuments: readonly ObserveShadowDecisionDocument[],
): Result.Result<DecisionBindingDecision, CycleStoreDecisionFailure> => {
  if (cycle.bindings.decisionHash !== undefined) {
    const storedDocument = storedDocuments[0]
    return cycle.bindings.decisionHash === document.contentHash &&
      storedDocuments.length === 1 &&
      storedDocument !== undefined &&
      shadowDecisionEquivalent(storedDocument, document)
      ? Result.succeed({ _tag: 'Replay', cycle })
      : fail('conflict', 'cycle decision binding cannot be replaced')
  }
  if (cycle.state !== CycleState.Active) {
    return fail('conflict', 'decision may bind only while a cycle is active')
  }
  if (observedAt >= cycle.window.submissionCutoffAt) {
    return Result.succeed({
      _tag: 'Block',
      cycle,
      reason: CycleTerminalReason.MissedSubmission,
    })
  }
  if (
    document.bindings.cycleId !== cycle.identity.cycleId ||
    document.bindings.strategyName !== cycle.identity.strategyName ||
    document.bindings.strategyProtocolHash !== cycle.identity.strategyProtocolHash ||
    document.bindings.snapshotId !== cycle.bindings.snapshotId ||
    document.bindings.accountId !== cycle.identity.accountId ||
    document.submissionCutoffAt !== cycle.window.submissionCutoffAt ||
    document.createdAt > observedAt ||
    document.createdAt < cycle.updatedAt
  ) {
    return fail('invariant', 'shadow decision does not match the active autonomous cycle')
  }
  return observedAt < cycle.updatedAt
    ? fail('conflict', 'cycle update time cannot move backward')
    : Result.succeed({ _tag: 'Persist', cycle, document })
}

export const decideCompletion = (
  cycle: AutonomousCycle,
  state: CycleCompletionState,
  observedAt: string,
): Result.Result<CompletionDecision, CycleStoreDecisionFailure> => {
  if (cycle.state === state) return Result.succeed({ _tag: 'Replay', cycle })
  if (!isCycleStateTransitionAllowed(cycle.state, state)) {
    return fail('conflict', 'only an active cycle may finish from its bound decision')
  }
  if (observedAt < cycle.updatedAt) return fail('conflict', 'cycle update time cannot move backward')
  const decisionHash = cycle.bindings.decisionHash
  return decisionHash === undefined
    ? fail('invariant', 'cycle completion requires a bound shadow decision')
    : Result.succeed({ _tag: 'VerifyDecision', cycle, decisionHash, state })
}

export const validateCompletionDocument = (
  decision: Extract<CompletionDecision, { readonly _tag: 'VerifyDecision' }>,
  storedDocuments: readonly ObserveShadowDecisionDocument[],
): Result.Result<void, CycleStoreDecisionFailure> => {
  const storedDocument = storedDocuments[0]
  const expectedStatus = decision.state === CycleState.Completed ? TargetPlanStatus.Planned : TargetPlanStatus.NoTrade
  return storedDocuments.length === 1 &&
    storedDocument !== undefined &&
    storedDocument.contentHash === decision.decisionHash &&
    storedDocument.targetPlan.status === expectedStatus
    ? Result.succeed(undefined)
    : fail('invariant', 'cycle terminal state must match its exact durable shadow decision')
}

export const decideBlock = (
  cycle: AutonomousCycle,
  reason: CycleTerminalReason,
  observedAt: string,
): Result.Result<BlockDecision, CycleStoreDecisionFailure> => {
  if (cycle.state === CycleState.Blocked && cycle.terminalReason === reason) {
    return Result.succeed({ _tag: 'Replay', cycle })
  }
  if (!isCycleStateTransitionAllowed(cycle.state, CycleState.Blocked)) {
    return fail('conflict', `terminal cycle ${cycle.identity.cycleId} cannot be blocked again`)
  }
  if (
    reason === CycleTerminalReason.MissedPublication &&
    (cycle.state !== CycleState.Pending ||
      cycle.bindings.snapshotId !== undefined ||
      observedAt < cycle.window.publicationDeadlineAt)
  ) {
    return fail(
      'invariant',
      'missed-publication transition requires an unbound pending cycle at or after its publication deadline',
    )
  }
  if (reason === CycleTerminalReason.MissedSubmission && observedAt < cycle.window.submissionCutoffAt) {
    return fail('invariant', 'missed-submission transition cannot precede the broker submission cutoff')
  }
  if (observedAt < cycle.updatedAt) return fail('conflict', 'cycle update time cannot move backward')
  const decisionHash = cycle.bindings.decisionHash
  return cycle.state === CycleState.Active && decisionHash !== undefined
    ? Result.succeed({ _tag: 'VerifyDecision', cycle, reason, decisionHash })
    : Result.succeed({ _tag: 'Persist', cycle, reason })
}

export const validateBlockedDecision = (
  decision: Extract<BlockDecision, { readonly _tag: 'VerifyDecision' }>,
  storedDocuments: readonly ObserveShadowDecisionDocument[],
): Result.Result<void, CycleStoreDecisionFailure> => {
  const storedDocument = storedDocuments[0]
  if (
    storedDocuments.length !== 1 ||
    storedDocument === undefined ||
    storedDocument.contentHash !== decision.decisionHash ||
    storedDocument.targetPlan.status !== TargetPlanStatus.Blocked
  ) {
    return fail('invariant', 'decision-bound cycle may block only from its exact blocked shadow decision')
  }
  return decision.reason === cycleTerminalReasonForBlockedTargetPlan(storedDocument.targetPlan.reason)
    ? Result.succeed(undefined)
    : fail('invariant', 'cycle blocked reason must match its exact durable shadow decision')
}
