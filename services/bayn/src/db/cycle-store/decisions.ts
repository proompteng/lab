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
import { cycleTerminalReasonForBlockedTargetPlan } from '../../cycle-runner/recovery-decisions'
import { CycleDecisionDocumentSchema, type CycleDecisionDocument } from '../../shadow-decision-contract'
import { TargetPlanStatus } from '../../target-planner'
import type { InputManifest } from '../../types'
import { cycleDecisionStoreEvidence } from './decision-contract'
import type { CycleStoreDecisionFailure } from './decision-contract'
import { Pipeable } from '../../pipeable'

export type { CycleStoreDecisionFailure } from './decision-contract'

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
      readonly document: CycleDecisionDocument
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
      readonly observedAt: string
    }

const fail = (
  failure: CycleStoreDecisionFailure['failure'],
  message: string,
): Result.Result<never, CycleStoreDecisionFailure> => Result.fail({ failure, message })

const shadowDecisionEquivalent = Schema.toEquivalence(CycleDecisionDocumentSchema)

const makeInitialCycleDataFirst = (draft: CycleDraft, observedAt: string): AutonomousCycle => {
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

export const makeInitialCycle = Pipeable.dual(2, makeInitialCycleDataFirst)

const decideAcquireDataFirst = (
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

export const decideAcquire = Pipeable.dual(4, decideAcquireDataFirst)

const decideSnapshotBindingDataFirst = (
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

export const decideSnapshotBinding = Pipeable.dual(3, decideSnapshotBindingDataFirst)

const decideActivationDataFirst = (
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

export const decideActivation = Pipeable.dual(2, decideActivationDataFirst)

const decideDecisionBindingDataFirst = (
  cycle: AutonomousCycle,
  document: CycleDecisionDocument,
  observedAt: string,
  storedDocuments: readonly CycleDecisionDocument[],
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
    (document.mode === 'PAPER' && document.bindings.qualificationRunId !== cycle.identity.qualificationRunId) ||
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

export const decideDecisionBinding = Pipeable.dual(4, decideDecisionBindingDataFirst)

const decideCompletionDataFirst = (
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

export const decideCompletion = Pipeable.dual(3, decideCompletionDataFirst)

export const validateCompletionDocument = (
  decision: Extract<CompletionDecision, { readonly _tag: 'VerifyDecision' }>,
  storedDocuments: readonly CycleDecisionDocument[],
  paperCompletionEvidenceMatches?: boolean,
): Result.Result<void, CycleStoreDecisionFailure> => {
  const storedDocument = storedDocuments[0]
  const completionEvidenceMatches =
    paperCompletionEvidenceMatches ??
    (storedDocument === undefined
      ? false
      : cycleDecisionStoreEvidence(storedDocument)?.paperCompletionEvidenceMatches === true)
  const expectedStatus = decision.state === CycleState.Completed ? TargetPlanStatus.Planned : TargetPlanStatus.NoTrade
  return storedDocuments.length === 1 &&
    storedDocument !== undefined &&
    storedDocument.contentHash === decision.decisionHash &&
    storedDocument.targetPlan.status === expectedStatus &&
    !(storedDocument.mode === 'PAPER' && storedDocument.riskBlock !== undefined) &&
    !(storedDocument.mode === 'PAPER' && decision.state === CycleState.Completed && !completionEvidenceMatches)
    ? Result.succeed(undefined)
    : fail('invariant', 'cycle terminal state must match its exact durable shadow decision')
}

const decideBlockDataFirst = (
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
    ? Result.succeed({ _tag: 'VerifyDecision', cycle, reason, decisionHash, observedAt })
    : Result.succeed({ _tag: 'Persist', cycle, reason })
}

export const decideBlock = Pipeable.dual(3, decideBlockDataFirst)

export const validateBlockedDecision = (
  decision: Extract<BlockDecision, { readonly _tag: 'VerifyDecision' }>,
  storedDocuments: readonly CycleDecisionDocument[],
  paperGenerationIsSuperseded?: boolean,
): Result.Result<void, CycleStoreDecisionFailure> => {
  const storedDocument = storedDocuments[0]
  const generationIsSuperseded =
    paperGenerationIsSuperseded ??
    (storedDocument === undefined
      ? false
      : cycleDecisionStoreEvidence(storedDocument)?.paperGenerationIsSuperseded === true)
  if (
    storedDocuments.length !== 1 ||
    storedDocument === undefined ||
    storedDocument.contentHash !== decision.decisionHash
  ) {
    return fail('invariant', 'decision-bound cycle may block only from its exact durable decision')
  }
  if (storedDocument.targetPlan.status === TargetPlanStatus.Blocked) {
    return decision.reason === cycleTerminalReasonForBlockedTargetPlan(storedDocument.targetPlan.reason)
      ? Result.succeed(undefined)
      : fail('invariant', 'cycle blocked reason must match its exact durable shadow decision')
  }
  if (storedDocument.mode === 'PAPER' && storedDocument.targetPlan.status === TargetPlanStatus.Planned) {
    if (decision.reason === CycleTerminalReason.ProvenanceMismatch && generationIsSuperseded) {
      return Result.succeed(undefined)
    }
    if (
      decision.reason === CycleTerminalReason.MissedSubmission &&
      decision.observedAt >= storedDocument.submissionCutoffAt
    ) {
      return Result.succeed(undefined)
    }
    if (decision.reason === CycleTerminalReason.Risk) {
      return Result.succeed(undefined)
    }
    return fail(
      'invariant',
      'planned PAPER cycle may block only from exact durable risk failure or submission expiry evidence',
    )
  }
  return fail('invariant', 'decision-bound cycle may block only from its exact blocked or expired PAPER decision')
}
