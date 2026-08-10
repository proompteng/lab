import { Result } from 'effect'

import { CycleState, CycleTerminalReason, cycleDraftMatches, cycleDraftOf, type AutonomousCycle } from '../cycle'
import type { CyclePublicationReadiness } from './recovery-readiness-model'
import {
  isAlreadyBoundReadiness,
  selectRecoveryFailure,
  type AlreadyBoundReadiness,
  type BlockedReadiness,
  type BoundOrAlreadyReadiness,
  type CycleRecoveryFailure,
  type DecodedCycleRecoveryState,
  type WaitingReadiness,
} from './recovery-model'
import { Pipeable } from '../pipeable'

const readinessBindingFacts = (
  cycle: AutonomousCycle,
  recoveryObservedAt: string,
  readiness: CyclePublicationReadiness,
): Readonly<Record<string, unknown>> => {
  const selectedSnapshotId = cycle.bindings.snapshotId
  const readinessSnapshotId = readiness.cycle.bindings.snapshotId
  const declaredSnapshotId =
    readiness.outcome === 'BOUND' || readiness.outcome === 'ALREADY_BOUND' ? readiness.snapshotId : undefined
  const expectedStateVersion =
    readiness.outcome === 'WAITING' || (readiness.outcome === 'ALREADY_BOUND' && selectedSnapshotId !== undefined)
      ? cycle.stateVersion
      : cycle.stateVersion + 1
  return {
    outcome: readiness.outcome,
    expectedAccountId: cycle.identity.accountId,
    actualAccountId: readiness.cycle.identity.accountId,
    expectedCycleId: cycle.identity.cycleId,
    actualCycleId: readiness.cycle.identity.cycleId,
    expectedQualificationRunId: cycle.identity.qualificationRunId,
    actualQualificationRunId: readiness.cycle.identity.qualificationRunId,
    expectedStrategyProtocolHash: cycle.identity.strategyProtocolHash,
    actualStrategyProtocolHash: readiness.cycle.identity.strategyProtocolHash,
    expectedSignalSessionDate: cycle.identity.signalSessionDate,
    actualSignalSessionDate: readiness.cycle.identity.signalSessionDate,
    expectedSignalCalendarVersion: cycle.identity.signalCalendarVersion,
    actualSignalCalendarVersion: readiness.cycle.identity.signalCalendarVersion,
    expectedSubmissionCutoffAt: cycle.window.submissionCutoffAt,
    actualSubmissionCutoffAt: readiness.cycle.window.submissionCutoffAt,
    expectedSelectedSnapshotId: selectedSnapshotId,
    actualSelectedSnapshotId: readinessSnapshotId,
    declaredSnapshotId,
    expectedState: readiness.outcome === 'BLOCKED' ? CycleState.Blocked : CycleState.Pending,
    actualState: readiness.cycle.state,
    selectedStateVersion: cycle.stateVersion,
    expectedStateVersion,
    actualStateVersion: readiness.cycle.stateVersion,
    selectedUpdatedAt: cycle.updatedAt,
    expectedMinimumReadinessObservedAt: recoveryObservedAt,
    actualReadinessObservedAt: readiness.observedAt,
    readinessObservedAt: readiness.observedAt,
    readinessCycleUpdatedAt: readiness.cycle.updatedAt,
  }
}

const readinessCommonMatches = (cycle: AutonomousCycle, readiness: CyclePublicationReadiness): boolean =>
  cycleDraftMatches(cycleDraftOf(cycle), cycleDraftOf(readiness.cycle)) &&
  readiness.cycle.identity.cycleId === cycle.identity.cycleId &&
  readiness.cycle.identity.accountId === cycle.identity.accountId &&
  readiness.cycle.identity.qualificationRunId === cycle.identity.qualificationRunId &&
  readiness.cycle.identity.strategyProtocolHash === cycle.identity.strategyProtocolHash &&
  readiness.cycle.window.submissionCutoffAt === cycle.window.submissionCutoffAt &&
  readiness.cycle.createdAt === cycle.createdAt &&
  readiness.observedAt >= cycle.updatedAt

const waitingReadinessMatches = (cycle: AutonomousCycle, readiness: WaitingReadiness): boolean =>
  cycle.bindings.snapshotId === undefined &&
  readiness.cycle.state === CycleState.Pending &&
  readiness.cycle.bindings.snapshotId === undefined &&
  readiness.cycle.bindings.decisionHash === undefined &&
  readiness.cycle.stateVersion === cycle.stateVersion &&
  readiness.cycle.updatedAt === cycle.updatedAt &&
  ((readiness.reason === 'SIGNAL_SESSION_OPEN' && readiness.observedAt < cycle.window.signalCloseAt) ||
    (readiness.reason === 'PUBLICATION_MISSING' &&
      readiness.observedAt >= cycle.window.signalCloseAt &&
      readiness.observedAt < cycle.window.publicationDeadlineAt))

const boundReadinessMatches = (cycle: AutonomousCycle, readiness: BoundOrAlreadyReadiness): boolean =>
  readiness.outcome === 'BOUND' &&
  cycle.bindings.snapshotId === undefined &&
  readiness.cycle.state === CycleState.Pending &&
  readiness.cycle.bindings.snapshotId === readiness.snapshotId &&
  readiness.cycle.bindings.decisionHash === undefined &&
  readiness.cycle.stateVersion === cycle.stateVersion + 1 &&
  readiness.cycle.updatedAt === readiness.observedAt &&
  readiness.observedAt >= cycle.window.signalCloseAt &&
  readiness.observedAt < cycle.window.publicationDeadlineAt

const alreadyBoundReadinessMatches = (cycle: AutonomousCycle, readiness: BoundOrAlreadyReadiness): boolean => {
  if (readiness.outcome !== 'ALREADY_BOUND') return false
  const unchangedBoundCycle =
    cycle.bindings.snapshotId === readiness.snapshotId &&
    readiness.cycle.stateVersion === cycle.stateVersion &&
    readiness.cycle.updatedAt === cycle.updatedAt
  const concurrentBinding =
    cycle.bindings.snapshotId === undefined &&
    readiness.cycle.stateVersion === cycle.stateVersion + 1 &&
    readiness.cycle.updatedAt > cycle.updatedAt &&
    readiness.cycle.updatedAt <= readiness.observedAt
  return (
    readiness.cycle.state === CycleState.Pending &&
    readiness.cycle.bindings.snapshotId === readiness.snapshotId &&
    readiness.cycle.bindings.decisionHash === undefined &&
    (unchangedBoundCycle || concurrentBinding)
  )
}

const blockedReadinessMatches = (cycle: AutonomousCycle, readiness: BlockedReadiness): boolean =>
  cycle.bindings.snapshotId === undefined &&
  readiness.cycle.state === CycleState.Blocked &&
  readiness.cycle.bindings.snapshotId === undefined &&
  readiness.cycle.bindings.decisionHash === undefined &&
  readiness.cycle.terminalReason === CycleTerminalReason.MissedPublication &&
  readiness.cycle.terminalAt === readiness.observedAt &&
  readiness.cycle.updatedAt === readiness.observedAt &&
  readiness.cycle.stateVersion === cycle.stateVersion + 1 &&
  readiness.observedAt >= cycle.window.publicationDeadlineAt

const readinessOutcomeMatches = (cycle: AutonomousCycle, readiness: CyclePublicationReadiness): boolean => {
  switch (readiness.outcome) {
    case 'WAITING':
      return waitingReadinessMatches(cycle, readiness)
    case 'BOUND':
      return boundReadinessMatches(cycle, readiness)
    case 'ALREADY_BOUND':
      return alreadyBoundReadinessMatches(cycle, readiness)
    case 'BLOCKED':
      return blockedReadinessMatches(cycle, readiness)
  }
}

const readinessIsCorrelatedDataFirst = (
  cycle: AutonomousCycle,
  recoveryObservedAt: string,
  readiness: CyclePublicationReadiness,
): boolean =>
  readiness.observedAt >= recoveryObservedAt &&
  readinessCommonMatches(cycle, readiness) &&
  readinessOutcomeMatches(cycle, readiness)

export const readinessIsCorrelated = Pipeable.dual(3, readinessIsCorrelatedDataFirst)

const validateReadinessDataFirst = (
  cycle: AutonomousCycle,
  recoveryObservedAt: string,
  readiness: CyclePublicationReadiness,
): Result.Result<void, CycleRecoveryFailure> =>
  readinessIsCorrelated(cycle, recoveryObservedAt, readiness)
    ? Result.succeed(undefined)
    : Result.fail(
        selectRecoveryFailure(
          'readiness-binding',
          'publication readiness must be the permitted transition of the exact selected cycle draft and snapshot',
          readinessBindingFacts(cycle, recoveryObservedAt, readiness),
        ),
      )

export const validateReadiness = Pipeable.dual(3, validateReadinessDataFirst)

const correlatedReadinessOfDataFirst = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): AlreadyBoundReadiness | undefined => {
  const { readiness } = state
  return readiness !== undefined &&
    isAlreadyBoundReadiness(readiness) &&
    readinessIsCorrelated(cycle, state.observedAt, readiness)
    ? readiness
    : undefined
}

export const correlatedReadinessOf = Pipeable.dual(2, correlatedReadinessOfDataFirst)
