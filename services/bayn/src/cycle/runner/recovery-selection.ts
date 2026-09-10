import { Result } from 'effect'

import { CycleState, CycleTerminalReason, isIntradayAutonomousCycle, type AutonomousCycle } from '../model'
import { isTerminalCycleState } from '../transitions'
import { selectBoundDecision } from './recovery-decision-binding'
import {
  decodeCycleRecoveryStateResult,
  decodeRecoveryStateFailure,
  selectRecoveryFailure,
  type CycleRecoveryFailure,
  type CycleRecoverySelection,
  type DecodedCycleRecoveryState,
} from './recovery-model'

const validateRecoveryCycleContext = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): Result.Result<void, CycleRecoveryFailure> => {
  if (cycle.identity.qualificationRunId !== state.cycleBindingId || cycle.identity.accountId !== state.accountId) {
    return Result.fail(
      selectRecoveryFailure({
        reason: 'scope',
        message: 'unfinished cycle does not match the configured recovery scope',
        facts: {
          cycleId: cycle.identity.cycleId,
          expectedCycleBindingId: state.cycleBindingId,
          actualCycleBindingId: cycle.identity.qualificationRunId,
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
  if (!isIntradayAutonomousCycle(cycle)) {
    return Result.fail(
      selectRecoveryFailure({
        reason: 'state-evidence',
        message: 'retired strategy cycles are not executable after the intraday cutover',
        facts: { cycleId: cycle.identity.cycleId, schemaVersion: cycle.schemaVersion },
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
  return selectBoundDecision(cycle, state.decisionDocument, state.observedAt)
}

const selectDeadlineOrProvenance = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): CycleRecoverySelection | undefined => {
  const observedAt = state.observedAt
  if (
    (cycle.state === CycleState.Active || cycle.state === CycleState.Pending) &&
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
  return Result.succeed({ action: 'ACTIVATE', cycleId: cycle.identity.cycleId, observedAt: state.observedAt })
}

const selectDecodedCycleRecovery = (
  state: DecodedCycleRecoveryState,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  const { cycle } = state
  if (cycle === undefined) {
    if (state.decisionDocument !== undefined) {
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
