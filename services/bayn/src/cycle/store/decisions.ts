import { Result, Schema } from 'effect'

import { legacyExecutionAuthorityToken } from '../../execution/legacy-wire'
import { CycleDecisionDocumentSchema, type CycleDecisionDocument } from '../../shadow-decision-contract'
import { TargetPlanStatus } from '../../target-planner/index'
import {
  CycleState,
  CycleTerminalReason,
  type AutonomousCycle,
  type CycleCompletionState,
  type CycleDraft,
} from '../model'
import { cycleTerminalReasonForBlockedTargetPlan } from '../recovery-decisions'
import { cycleDraftMatches, cycleDraftOf, isCycleStateTransitionAllowed } from '../transitions'
import { cycleDecisionStoreEvidence } from './decision-contract'
import { hasExpiredUnusedEntryAdmission, unusedEntryExpiresAt } from '../entry-admission'
import type { CycleStoreDecisionFailure } from './decision-contract'
import type { CycleAcquireReceipt } from './model'

export type { CycleStoreDecisionFailure } from './decision-contract'

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
      readonly reason: CycleTerminalReason.MissedSubmission | CycleTerminalReason.UnusedEntryExpired
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
      readonly reason: CycleTerminalReason.MissedSubmission | CycleTerminalReason.UnusedEntryExpired
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

export const makeInitialCycle = (draft: CycleDraft, observedAt: string): AutonomousCycle => ({
  ...draft,
  state: CycleState.Pending,
  bindings: {},
  stateVersion: 1,
  createdAt: observedAt,
  updatedAt: observedAt,
})

export const decideAcquire = (
  stored: AutonomousCycle,
  draft: CycleDraft,
  created: boolean,
): Result.Result<CycleAcquireReceipt, CycleStoreDecisionFailure> => {
  if (!cycleDraftMatches(cycleDraftOf(stored), draft)) {
    return fail('conflict', 'stored cycle differs from deterministic acquisition input')
  }
  return Result.succeed({ cycle: stored, created })
}

export const decideActivation = (
  cycle: AutonomousCycle,
  observedAt: string,
): Result.Result<ActivationDecision, CycleStoreDecisionFailure> => {
  if (cycle.state === CycleState.Active) return Result.succeed({ _tag: 'Replay', cycle })
  if (!isCycleStateTransitionAllowed(cycle.state, CycleState.Active)) {
    return fail('conflict', 'only a pending cycle may become active')
  }
  if (observedAt >= cycle.window.submissionCutoffAt) {
    return Result.succeed({
      _tag: 'Block',
      cycle,
      reason: hasExpiredUnusedEntryAdmission(cycle, observedAt)
        ? CycleTerminalReason.UnusedEntryExpired
        : CycleTerminalReason.MissedSubmission,
    })
  }
  return observedAt < cycle.updatedAt
    ? fail('conflict', 'cycle update time cannot move backward')
    : Result.succeed({ _tag: 'Persist', cycle })
}

export const decideDecisionBinding = (
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
  if (hasExpiredUnusedEntryAdmission(cycle, observedAt)) {
    return Result.succeed({ _tag: 'Block', cycle, reason: CycleTerminalReason.UnusedEntryExpired })
  }
  if (observedAt >= cycle.window.submissionCutoffAt) {
    return Result.succeed({
      _tag: 'Block',
      cycle,
      reason: CycleTerminalReason.MissedSubmission,
    })
  }
  const executionMarketData = document.bindings.executionMarketData
  const decisionMarketData = document.bindings.decisionMarketData ?? executionMarketData
  const snapshotMatches =
    cycle.bindings.snapshotId === undefined &&
    executionMarketData !== undefined &&
    decisionMarketData !== undefined &&
    document.bindings.snapshotId === decisionMarketData.snapshotId &&
    document.bindings.snapshotContentHash === decisionMarketData.contentHash &&
    document.bindings.snapshotFinalizedAt === decisionMarketData.observedAt

  if (
    document.bindings.cycleId !== cycle.identity.cycleId ||
    document.bindings.strategyName !== cycle.identity.strategyName ||
    document.bindings.strategyProtocolHash !== cycle.identity.strategyProtocolHash ||
    (document.mode === legacyExecutionAuthorityToken &&
      document.bindings.qualificationRunId !== cycle.identity.qualificationRunId) ||
    !snapshotMatches ||
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
  storedDocuments: readonly CycleDecisionDocument[],
  executionCompletionEvidenceMatches?: boolean,
): Result.Result<void, CycleStoreDecisionFailure> => {
  const storedDocument = storedDocuments[0]
  const completionEvidenceMatches =
    executionCompletionEvidenceMatches ??
    (storedDocument === undefined
      ? false
      : cycleDecisionStoreEvidence(storedDocument)?.executionCompletionEvidenceMatches === true)
  const expectedStatus = decision.state === CycleState.Completed ? TargetPlanStatus.Planned : TargetPlanStatus.NoTrade
  return storedDocuments.length === 1 &&
    storedDocument !== undefined &&
    storedDocument.contentHash === decision.decisionHash &&
    storedDocument.targetPlan.status === expectedStatus &&
    !(storedDocument.mode === legacyExecutionAuthorityToken && storedDocument.riskBlock !== undefined) &&
    !(
      storedDocument.mode === legacyExecutionAuthorityToken &&
      decision.state === CycleState.Completed &&
      !completionEvidenceMatches
    )
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
  if (reason === CycleTerminalReason.MissedPublication)
    return fail('invariant', 'current cycles have no publication deadline')
  if (reason === CycleTerminalReason.MissedSubmission && observedAt < cycle.window.submissionCutoffAt) {
    return fail('invariant', 'missed-submission transition cannot precede the broker submission cutoff')
  }
  if (
    reason === CycleTerminalReason.UnusedEntryExpired &&
    (cycle.schemaVersion !== 'bayn.autonomous-cycle.v4' ||
      cycle.bindings.snapshotId !== undefined ||
      cycle.bindings.decisionHash !== undefined ||
      Date.parse(observedAt) < unusedEntryExpiresAt(cycle))
  )
    return fail('invariant', 'unused-entry expiry requires an unbound intraday cycle after its admission lease')
  if (observedAt < cycle.updatedAt) return fail('conflict', 'cycle update time cannot move backward')
  const decisionHash = cycle.bindings.decisionHash
  return cycle.state === CycleState.Active && decisionHash !== undefined
    ? Result.succeed({ _tag: 'VerifyDecision', cycle, reason, decisionHash, observedAt })
    : Result.succeed({ _tag: 'Persist', cycle, reason })
}

export const validateBlockedDecision = (
  decision: Extract<BlockDecision, { readonly _tag: 'VerifyDecision' }>,
  storedDocuments: readonly CycleDecisionDocument[],
  executionGenerationIsSuperseded?: boolean,
): Result.Result<void, CycleStoreDecisionFailure> => {
  const storedDocument = storedDocuments[0]
  const generationIsSuperseded =
    executionGenerationIsSuperseded ??
    (storedDocument === undefined
      ? false
      : cycleDecisionStoreEvidence(storedDocument)?.executionGenerationIsSuperseded === true)
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
  if (
    storedDocument.mode === legacyExecutionAuthorityToken &&
    storedDocument.targetPlan.status === TargetPlanStatus.Planned
  ) {
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
      'planned execution cycle may block only from exact durable risk failure or submission expiry evidence',
    )
  }
  return fail('invariant', 'decision-bound cycle may block only from its exact blocked or expired execution decision')
}
