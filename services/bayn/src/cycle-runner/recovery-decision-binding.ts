import { Result } from 'effect'

import type { AutonomousCycle } from '../cycle'
import type { CycleDecisionDocument } from '../shadow-decision-contract'
import { TargetPlanStatus } from '../target-planner'
import {
  selectRecoveryFailure,
  validateDecisionFailure,
  type CycleRecoveryFailure,
  type CycleRecoverySelection,
} from './recovery-model'
import { cycleCompletionStateForTargetPlan, cycleTerminalReasonForBlockedTargetPlan } from './recovery-decisions'
import { Pipeable } from '../pipeable'

export { cycleCompletionStateForTargetPlan, cycleTerminalReasonForBlockedTargetPlan } from './recovery-decisions'

const validateDecisionBinding = (
  cycle: AutonomousCycle,
  document: CycleDecisionDocument,
): Result.Result<void, CycleRecoveryFailure> => {
  const facts = {
    expectedAccountId: cycle.identity.accountId,
    actualAccountId: document.bindings.accountId,
    expectedCycleId: cycle.identity.cycleId,
    actualCycleId: document.bindings.cycleId,
    expectedQualificationRunId: cycle.identity.qualificationRunId,
    actualQualificationRunId: document.mode === 'PAPER' ? document.bindings.qualificationRunId : undefined,
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
    (document.mode === 'PAPER' && document.bindings.qualificationRunId !== cycle.identity.qualificationRunId) ||
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

const selectBoundDecisionDataFirst = (
  cycle: AutonomousCycle,
  document: CycleDecisionDocument | null | undefined,
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
          return document.mode === 'PAPER'
            ? Result.succeed({ action: 'WAIT', cycle, observedAt })
            : Result.succeed({
                action: 'FINISH',
                cycleId: cycle.identity.cycleId,
                observedAt,
                state: cycleCompletionStateForTargetPlan(document.targetPlan.status),
              })
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

export const selectBoundDecision = Pipeable.dual(3, selectBoundDecisionDataFirst)
