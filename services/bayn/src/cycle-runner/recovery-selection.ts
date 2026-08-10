import { Result } from 'effect'

import { CycleState, CycleTerminalReason, isTerminalCycleState, type AutonomousCycle } from '../cycle'
import { selectBoundDecision } from './recovery-decision-binding'
import {
  decodeCycleRecoveryStateResult,
  decodeRecoveryStateFailure,
  selectRecoveryFailure,
  type AlreadyBoundReadiness,
  type CycleRecoveryFailure,
  type CycleRecoverySelection,
  type DecodedCycleRecoveryState,
} from './recovery-model'
import { correlatedReadinessOf, validateReadiness } from './recovery-readiness'

const validateRecoveryCycleContext = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): Result.Result<void, CycleRecoveryFailure> => {
  if (cycle.identity.qualificationRunId !== state.qualificationRunId || cycle.identity.accountId !== state.accountId) {
    return Result.fail(
      selectRecoveryFailure({
        reason: 'scope',
        message: 'unfinished cycle does not match the configured recovery scope',
        facts: {
          cycleId: cycle.identity.cycleId,
          expectedQualificationRunId: state.qualificationRunId,
          actualQualificationRunId: cycle.identity.qualificationRunId,
          expectedAccountId: state.accountId,
          actualAccountId: cycle.identity.accountId,
          cycleState: cycle.state,
          cycleStateVersion: cycle.stateVersion,
          submissionCutoffAt: cycle.window.submissionCutoffAt,
        },
      }),
    )
  }
  if (isTerminalCycleState(cycle.state)) {
    return Result.fail(
      selectRecoveryFailure({
        reason: 'terminal-cycle',
        message: 'terminal cycles must not enter autonomous recovery',
        facts: {
          cycleId: cycle.identity.cycleId,
          state: cycle.state,
        },
      }),
    )
  }
  if (state.observedAt < cycle.updatedAt) {
    return Result.fail(
      selectRecoveryFailure({
        reason: 'chronology',
        message: 'recovery observation cannot precede the selected cycle update',
        facts: {
          actualObservedAt: state.observedAt,
          expectedMinimumObservedAt: cycle.updatedAt,
          cycleId: cycle.identity.cycleId,
          cycleState: cycle.state,
          cycleStateVersion: cycle.stateVersion,
        },
      }),
    )
  }
  return Result.succeed(undefined)
}

const selectDecisionBoundRecovery = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  if (state.readiness !== undefined) {
    return Result.fail(
      selectRecoveryFailure({
        reason: 'state-evidence',
        message: 'active cycle recovery does not accept publication readiness',
        facts: {
          cycleId: cycle.identity.cycleId,
        },
      }),
    )
  }
  return selectBoundDecision(cycle, state.decisionDocument, state.observedAt)
}

const freshestRecoveryObservationAt = (
  state: DecodedCycleRecoveryState,
  readiness: AlreadyBoundReadiness | undefined,
): string =>
  readiness !== undefined && readiness.observedAt > state.observedAt ? readiness.observedAt : state.observedAt

const pendingSnapshotBindingAt = (
  cycle: AutonomousCycle,
  readiness: AlreadyBoundReadiness | undefined,
): string | undefined => {
  if (cycle.state !== CycleState.Pending) return undefined
  if (cycle.bindings.snapshotId !== undefined) return cycle.updatedAt
  return readiness?.cycle.updatedAt
}

const selectDeadlineOrProvenance = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): CycleRecoverySelection | undefined => {
  const correlatedReadiness = correlatedReadinessOf(state, cycle)
  const observedAt = freshestRecoveryObservationAt(state, correlatedReadiness)
  const pendingBindingEffectiveAt = pendingSnapshotBindingAt(cycle, correlatedReadiness)
  if (
    cycle.state === CycleState.Pending &&
    (pendingBindingEffectiveAt === undefined
      ? observedAt >= cycle.window.publicationDeadlineAt
      : pendingBindingEffectiveAt >= cycle.window.publicationDeadlineAt)
  ) {
    return {
      action: 'BLOCK',
      cycleId: cycle.identity.cycleId,
      observedAt,
      reason: CycleTerminalReason.MissedPublication,
    }
  }
  if (
    (cycle.state === CycleState.Active || pendingBindingEffectiveAt !== undefined) &&
    observedAt >= cycle.window.submissionCutoffAt
  ) {
    return {
      action: 'BLOCK',
      cycleId: cycle.identity.cycleId,
      observedAt,
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
  return undefined
}

const selectActiveRecovery = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  if (state.readiness !== undefined) {
    return Result.fail(
      selectRecoveryFailure({
        reason: 'state-evidence',
        message: 'active cycle recovery does not accept publication readiness',
        facts: {
          cycleId: cycle.identity.cycleId,
        },
      }),
    )
  }
  if (state.decisionDocument !== undefined) {
    return Result.fail(
      selectRecoveryFailure({
        reason: 'state-evidence',
        message: 'unbound active cycle cannot have durable decision evidence',
        facts: {
          cycleId: cycle.identity.cycleId,
        },
      }),
    )
  }
  return state.observedAt < cycle.window.submissionOpenAt
    ? Result.succeed({ action: 'WAIT', cycle, observedAt: state.observedAt })
    : Result.succeed({ action: 'BUILD_DECISION', cycle })
}

const selectPendingReadiness = (
  cycle: AutonomousCycle,
  recoveryObservedAt: string,
  readiness: NonNullable<DecodedCycleRecoveryState['readiness']>,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> =>
  Result.map(validateReadiness(cycle, recoveryObservedAt, readiness), () => {
    switch (readiness.outcome) {
      case 'WAITING':
        return { action: 'RETURN_READINESS', recoveryAction: 'WAITING', result: readiness }
      case 'BLOCKED':
        return { action: 'RETURN_READINESS', recoveryAction: 'BLOCKED', result: readiness }
      case 'BOUND':
        return {
          action: 'RETURN_READINESS',
          recoveryAction: 'BOUND_SNAPSHOT',
          result: { ...readiness, outcome: 'BOUND' },
        }
      case 'ALREADY_BOUND':
        return { action: 'ACTIVATE', cycleId: readiness.cycle.identity.cycleId, observedAt: readiness.observedAt }
    }
  })

const selectPendingRecovery = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  if (state.decisionDocument !== undefined) {
    return Result.fail(
      selectRecoveryFailure({
        reason: 'state-evidence',
        message: 'pending cycle recovery does not accept decision evidence',
        facts: {
          cycleId: cycle.identity.cycleId,
        },
      }),
    )
  }
  return state.readiness === undefined
    ? Result.succeed({ action: 'READ_PUBLICATION', cycle })
    : selectPendingReadiness(cycle, state.observedAt, state.readiness)
}

const selectDecodedCycleRecovery = (
  state: DecodedCycleRecoveryState,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  const { cycle } = state
  if (cycle === undefined) {
    if (state.readiness !== undefined || state.decisionDocument !== undefined) {
      return Result.fail(
        selectRecoveryFailure({
          reason: 'evidence-without-cycle',
          message: 'recovery evidence requires an unfinished cycle',
        }),
      )
    }
    return Result.succeed({ action: 'DISCOVER' })
  }
  const cycleContext = validateRecoveryCycleContext(state, cycle)
  if (Result.isFailure(cycleContext)) return Result.fail(cycleContext.failure)
  if (cycle.state === CycleState.Active && cycle.bindings.decisionHash !== undefined) {
    return selectDecisionBoundRecovery(state, cycle)
  }
  const deadlineOrProvenance = selectDeadlineOrProvenance(state, cycle)
  if (deadlineOrProvenance !== undefined) return Result.succeed(deadlineOrProvenance)
  switch (cycle.state) {
    case CycleState.Active:
      return selectActiveRecovery(state, cycle)
    case CycleState.Pending:
      return selectPendingRecovery(state, cycle)
    default:
      return Result.fail(
        selectRecoveryFailure({
          reason: 'state-evidence',
          message: `unsupported unfinished cycle state ${cycle.state}`,
          facts: {
            cycleId: cycle.identity.cycleId,
            state: cycle.state,
          },
        }),
      )
  }
}

export const selectCycleRecovery = (state: unknown): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> =>
  Result.flatMap(
    Result.mapError(decodeCycleRecoveryStateResult(state), (cause) =>
      decodeRecoveryStateFailure({
        reason: 'decode',
        message: 'autonomous cycle recovery state is invalid',
        facts: {},
        cause,
      }),
    ),
    selectDecodedCycleRecovery,
  )
