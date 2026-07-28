import { Result } from 'effect'

import { CycleState, CycleTerminalReason, type AutonomousCycle, type CycleCompletionState } from '../cycle'
import type { ObserveShadowDecisionDocument } from '../shadow-decision-contract'
import { TargetPlanReason, TargetPlanStatus, type BlockedTargetPlanReason } from '../target-planner'
import {
  selectRecoveryFailure,
  validateDecisionFailure,
  type CycleRecoveryFailure,
  type CycleRecoverySelection,
} from './recovery-model'

const validateDecisionBinding = (
  cycle: AutonomousCycle,
  document: ObserveShadowDecisionDocument,
): Result.Result<void, CycleRecoveryFailure> => {
  const facts = {
    expectedAccountId: cycle.identity.accountId,
    actualAccountId: document.bindings.accountId,
    expectedCycleId: cycle.identity.cycleId,
    actualCycleId: document.bindings.cycleId,
    expectedCycleStateVersion: cycle.stateVersion,
    actualDocumentCreatedAt: document.createdAt,
    expectedDecisionHash: cycle.bindings.decisionHash,
    actualDecisionHash: document.contentHash,
    expectedSnapshotId: cycle.bindings.snapshotId,
    actualSnapshotId: document.bindings.snapshotId,
    expectedStrategyName: cycle.identity.strategyName,
    actualStrategyName: document.bindings.strategyName,
    expectedStrategyProtocolHash: cycle.identity.strategyProtocolHash,
    actualStrategyProtocolHash: document.bindings.strategyProtocolHash,
    expectedSubmissionCutoffAt: cycle.window.submissionCutoffAt,
    actualSubmissionCutoffAt: document.submissionCutoffAt,
    minimumCycleCreatedAt: cycle.createdAt,
    minimumSubmissionOpenAt: cycle.window.submissionOpenAt,
    maximumCycleUpdatedAt: cycle.updatedAt,
  }
  return cycle.bindings.decisionHash !== document.contentHash ||
    cycle.bindings.snapshotId !== document.bindings.snapshotId ||
    cycle.identity.cycleId !== document.bindings.cycleId ||
    cycle.identity.strategyName !== document.bindings.strategyName ||
    cycle.identity.strategyProtocolHash !== document.bindings.strategyProtocolHash ||
    cycle.identity.accountId !== document.bindings.accountId ||
    cycle.window.submissionCutoffAt !== document.submissionCutoffAt ||
    document.createdAt < cycle.createdAt ||
    document.createdAt < cycle.window.submissionOpenAt ||
    document.createdAt > cycle.updatedAt
    ? Result.fail(
        validateDecisionFailure(
          'decision-binding',
          'durable shadow decision does not match the active cycle binding',
          facts,
        ),
      )
    : Result.succeed(undefined)
}

export const cycleTerminalReasonForBlockedTargetPlan = (reason: BlockedTargetPlanReason): CycleTerminalReason => {
  switch (reason) {
    case TargetPlanReason.SubmissionCutoffReached:
      return CycleTerminalReason.MissedSubmission
    case TargetPlanReason.IdentityMismatch:
      return CycleTerminalReason.ProvenanceMismatch
    case TargetPlanReason.InputMismatch:
      return CycleTerminalReason.DataInvalid
    case TargetPlanReason.InputStale:
      return CycleTerminalReason.DataStale
    case TargetPlanReason.ReconciliationNotExact:
      return CycleTerminalReason.Reconciliation
    case TargetPlanReason.AccountNotActive:
      return CycleTerminalReason.BrokerDisabled
    case TargetPlanReason.UnknownOrder:
    case TargetPlanReason.UnresolvedOrder:
      return CycleTerminalReason.UnresolvedMutation
    case TargetPlanReason.BelowMinimumBuyNotional:
    case TargetPlanReason.InsufficientBuyingPower:
    case TargetPlanReason.NonPositiveEquity:
    case TargetPlanReason.ShortPositionNotAllowed:
      return CycleTerminalReason.Risk
  }
}

export const cycleCompletionStateForTargetPlan = (
  status: TargetPlanStatus.Planned | TargetPlanStatus.NoTrade,
): CycleCompletionState => {
  switch (status) {
    case TargetPlanStatus.Planned:
      return CycleState.Completed
    case TargetPlanStatus.NoTrade:
      return CycleState.NoTrade
  }
}

export const selectBoundDecision = (
  cycle: AutonomousCycle,
  document: ObserveShadowDecisionDocument | null | undefined,
  observedAt: string,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  if (document === undefined) return Result.succeed({ action: 'READ_DECISION', cycle })
  if (document === null) {
    return Result.fail(
      selectRecoveryFailure('decision-missing', 'decision-bound cycle is missing its durable document', {
        cycleId: cycle.identity.cycleId,
      }),
    )
  }
  return Result.flatMap(
    validateDecisionBinding(cycle, document),
    (): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
      switch (document.targetPlan.status) {
        case TargetPlanStatus.Planned:
        case TargetPlanStatus.NoTrade:
          return Result.succeed({
            action: 'FINISH',
            cycleId: cycle.identity.cycleId,
            observedAt,
            state: cycleCompletionStateForTargetPlan(document.targetPlan.status),
          })
        case TargetPlanStatus.Blocked:
          return Result.succeed({
            action: 'BLOCK',
            cycleId: cycle.identity.cycleId,
            observedAt,
            reason: cycleTerminalReasonForBlockedTargetPlan(document.targetPlan.reason),
          })
      }
    },
  )
}
