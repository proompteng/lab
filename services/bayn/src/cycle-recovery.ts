import {
  CycleState,
  CycleTerminalReason,
  cycleTerminalReasonForTargetPlanBlock,
  isTerminalCycleState,
  type AutonomousCycle,
  type CycleCompletionState,
} from './cycle'
import type { CyclePublicationReadiness } from './cycle-readiness'
import type { ObserveShadowDecisionDocument } from './shadow-decision-contract'
import { TargetPlanStatus } from './target-planner'

export type CycleRecoverySelection =
  | { readonly action: 'DISCOVER' }
  | {
      readonly action: 'BLOCK'
      readonly cycleId: string
      readonly observedAt: string
      readonly reason: CycleTerminalReason
    }
  | { readonly action: 'READ_PUBLICATION'; readonly cycle: AutonomousCycle }
  | {
      readonly action: 'RETURN_READINESS'
      readonly result: CyclePublicationReadiness
      readonly recoveryAction: 'BLOCKED' | 'BOUND_SNAPSHOT' | 'WAITING'
    }
  | {
      readonly action: 'ACTIVATE'
      readonly cycleId: string
      readonly observedAt: string
    }
  | { readonly action: 'BUILD_DECISION'; readonly cycle: AutonomousCycle }
  | { readonly action: 'READ_DECISION'; readonly cycle: AutonomousCycle }
  | {
      readonly action: 'FINISH'
      readonly cycleId: string
      readonly observedAt: string
      readonly state: CycleCompletionState
    }

export interface CycleRecoveryState {
  readonly qualificationRunId: string
  readonly accountId: string
  readonly strategyProtocolHash: string
  readonly observedAt: string
  readonly cycle: AutonomousCycle | undefined
  readonly readiness?: CyclePublicationReadiness
  readonly decisionDocument?: ObserveShadowDecisionDocument | null
}

const validateDecisionBinding = (cycle: AutonomousCycle, document: ObserveShadowDecisionDocument): void => {
  if (
    cycle.bindings.decisionHash !== document.contentHash ||
    cycle.bindings.snapshotId !== document.bindings.snapshotId ||
    cycle.identity.cycleId !== document.bindings.cycleId ||
    cycle.identity.strategyName !== document.bindings.strategyName ||
    cycle.identity.strategyProtocolHash !== document.bindings.strategyProtocolHash ||
    cycle.identity.accountId !== document.bindings.accountId ||
    cycle.window.submissionCutoffAt !== document.submissionCutoffAt ||
    document.createdAt > cycle.updatedAt
  ) {
    throw new TypeError('durable shadow decision does not match the active cycle binding')
  }
}

const selectBoundDecision = (
  cycle: AutonomousCycle,
  document: ObserveShadowDecisionDocument | null | undefined,
  observedAt: string,
): CycleRecoverySelection => {
  if (document === undefined) return { action: 'READ_DECISION', cycle }
  if (document === null) throw new TypeError('decision-bound cycle is missing its durable document')
  validateDecisionBinding(cycle, document)
  switch (document.targetPlan.status) {
    case TargetPlanStatus.Planned:
      return {
        action: 'FINISH',
        cycleId: cycle.identity.cycleId,
        observedAt,
        state: CycleState.Completed,
      }
    case TargetPlanStatus.NoTrade:
      return {
        action: 'FINISH',
        cycleId: cycle.identity.cycleId,
        observedAt,
        state: CycleState.NoTrade,
      }
    case TargetPlanStatus.Blocked: {
      const reason = document.targetPlan.reason
      if (reason === null) throw new TypeError('blocked target plan requires its durable reason')
      return {
        action: 'BLOCK',
        cycleId: cycle.identity.cycleId,
        observedAt,
        reason: cycleTerminalReasonForTargetPlanBlock(reason),
      }
    }
  }
}

export const selectCycleRecovery = (state: CycleRecoveryState): CycleRecoverySelection => {
  const { cycle, decisionDocument, readiness } = state
  if (cycle === undefined) {
    if (readiness !== undefined || decisionDocument !== undefined) {
      throw new TypeError('recovery evidence requires an unfinished cycle')
    }
    return { action: 'DISCOVER' }
  }
  if (cycle.identity.qualificationRunId !== state.qualificationRunId || cycle.identity.accountId !== state.accountId) {
    throw new TypeError('unfinished cycle does not match the configured recovery scope')
  }
  if (isTerminalCycleState(cycle.state)) {
    throw new TypeError('terminal cycles must not enter autonomous recovery')
  }
  if (cycle.state === CycleState.Active && cycle.bindings.decisionHash !== undefined) {
    if (readiness !== undefined) throw new TypeError('active cycle recovery does not accept publication readiness')
    return selectBoundDecision(cycle, decisionDocument, state.observedAt)
  }
  if (
    cycle.state === CycleState.Pending &&
    cycle.bindings.snapshotId === undefined &&
    state.observedAt >= cycle.window.publicationDeadlineAt
  ) {
    return {
      action: 'BLOCK',
      cycleId: cycle.identity.cycleId,
      observedAt: state.observedAt,
      reason: CycleTerminalReason.MissedPublication,
    }
  }
  if (
    (cycle.state === CycleState.Active || cycle.bindings.snapshotId !== undefined) &&
    state.observedAt >= cycle.window.submissionCutoffAt
  ) {
    return {
      action: 'BLOCK',
      cycleId: cycle.identity.cycleId,
      observedAt: state.observedAt,
      reason: CycleTerminalReason.MissedSubmission,
    }
  }
  if (cycle.identity.strategyProtocolHash !== state.strategyProtocolHash) {
    return {
      action: 'BLOCK',
      cycleId: cycle.identity.cycleId,
      observedAt: state.observedAt,
      reason: CycleTerminalReason.ProvenanceMismatch,
    }
  }
  if (cycle.state === CycleState.Active) {
    if (readiness !== undefined) throw new TypeError('active cycle recovery does not accept publication readiness')
    if (decisionDocument !== undefined) {
      throw new TypeError('unbound active cycle cannot have durable decision evidence')
    }
    return { action: 'BUILD_DECISION', cycle }
  }
  if (cycle.state !== CycleState.Pending) {
    throw new TypeError(`unsupported unfinished cycle state ${cycle.state}`)
  }
  if (decisionDocument !== undefined) {
    throw new TypeError('pending cycle recovery does not accept decision evidence')
  }
  if (readiness === undefined) return { action: 'READ_PUBLICATION', cycle }
  if (readiness.cycle.identity.cycleId !== cycle.identity.cycleId) {
    throw new TypeError('publication readiness must describe the selected unfinished cycle')
  }

  switch (readiness.outcome) {
    case 'WAITING':
      return { action: 'RETURN_READINESS', recoveryAction: 'WAITING', result: readiness }
    case 'BLOCKED':
      return { action: 'RETURN_READINESS', recoveryAction: 'BLOCKED', result: readiness }
    case 'BOUND':
      return { action: 'RETURN_READINESS', recoveryAction: 'BOUND_SNAPSHOT', result: readiness }
    case 'ALREADY_BOUND':
      return {
        action: 'ACTIVATE',
        cycleId: readiness.cycle.identity.cycleId,
        observedAt: readiness.observedAt,
      }
  }
}
