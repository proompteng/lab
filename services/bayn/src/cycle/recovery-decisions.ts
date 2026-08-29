import { TargetPlanReason, TargetPlanStatus, type BlockedTargetPlanReason } from '../target-planner'
import { CycleState, CycleTerminalReason, type CycleCompletionState } from './model'

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
    case TargetPlanReason.InsufficientSellLiquidity:
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
