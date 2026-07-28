import { Chunk, pipe, Result } from 'effect'

import type { MarkedEquityProof, Validation } from './model'
import type { PreparedReconciliation } from './preparation'
import { reconcileAllMarks } from './reconstruction-marks'
import type { ReconstructionState } from './reconstruction-events'
import { absolute, fail, failIssues, unsigned } from './validation'

const initialReconstructionState = (prepared: PreparedReconciliation): Validation<ReconstructionState> =>
  pipe(
    unsigned({
      kind: 'input',
      field: 'initialCapitalMicros',
      value: prepared.input.initialCapitalMicros,
    }),
    Result.map((cashMicros) => ({
      cashMicros,
      quantities: new Map(),
      eventIndex: 0,
      reconstructedTotalFeesMicros: 0n,
      cumulativeTurnoverMicros: 0n,
      cumulativeSpreadMicros: 0n,
      cumulativeSlippageMicros: 0n,
      cumulativeCashYieldMicros: 0n,
      maximumDifferenceMicros: 0n,
      finalPositionValueMicros: 0n,
      reversedEquitySeries: Chunk.empty(),
    })),
  )

const ensureAllEventsReconciled = (
  prepared: PreparedReconciliation,
  state: ReconstructionState,
): Validation<ReconstructionState> => {
  const firstEvent = prepared.monetaryEvents[state.eventIndex]
  return firstEvent === undefined
    ? Result.succeed(state)
    : fail({
        _tag: 'IncompleteEvidence',
        problem: {
          _tag: 'MonetaryEventsAfterFinalMark',
          firstEventId: firstEvent.event.id,
          firstEventSessionDate: firstEvent.event.sessionDate,
        },
      })
}

const buildMarkedEquityProof = (
  prepared: PreparedReconciliation,
  state: ReconstructionState,
): Validation<MarkedEquityProof> => {
  const evaluatorEnding = unsigned({
    kind: 'input',
    field: 'evaluatorEndingEquityMicros',
    value: prepared.input.evaluatorEndingEquityMicros,
  })
  if (Result.isFailure(evaluatorEnding)) return failIssues(evaluatorEnding.failure)
  const evaluatorTotalFees = unsigned({
    kind: 'input',
    field: 'evaluatorTotalFeesMicros',
    value: prepared.input.evaluatorTotalFeesMicros,
  })
  if (Result.isFailure(evaluatorTotalFees)) return failIssues(evaluatorTotalFees.failure)
  const feeDifferenceMicros = absolute(state.reconstructedTotalFeesMicros - evaluatorTotalFees.success)
  if (feeDifferenceMicros > prepared.toleranceMicros) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'FinalOutsideTolerance',
        measure: 'final-fees',
        differenceMicros: feeDifferenceMicros.toString(),
        toleranceMicros: prepared.toleranceMicros.toString(),
      },
    })
  }
  const reconstructedEndingEquityMicros = state.cashMicros + state.finalPositionValueMicros
  const finalDifferenceMicros = absolute(reconstructedEndingEquityMicros - evaluatorEnding.success)
  if (finalDifferenceMicros > prepared.toleranceMicros) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'FinalOutsideTolerance',
        measure: 'final-equity',
        differenceMicros: finalDifferenceMicros.toString(),
        toleranceMicros: prepared.toleranceMicros.toString(),
      },
    })
  }
  const maximumDifferenceMicros =
    state.maximumDifferenceMicros > finalDifferenceMicros ? state.maximumDifferenceMicros : finalDifferenceMicros
  return Result.succeed({
    reconciliation: {
      schemaVersion: 'bayn.marked-equity-reconciliation.v2',
      runId: prepared.input.runId,
      toleranceMicros: prepared.toleranceMicros.toString(),
      maximumDailyDifferenceMicros: maximumDifferenceMicros.toString(),
      reconstructedCashMicros: state.cashMicros.toString(),
      reconstructedPositionValueMicros: state.finalPositionValueMicros.toString(),
      evaluatorTotalFeesMicros: evaluatorTotalFees.success.toString(),
      reconstructedTotalFeesMicros: state.reconstructedTotalFeesMicros.toString(),
      feeDifferenceMicros: feeDifferenceMicros.toString(),
      evaluatorEndingEquityMicros: evaluatorEnding.success.toString(),
      reconstructedEndingEquityMicros: reconstructedEndingEquityMicros.toString(),
      differenceMicros: finalDifferenceMicros.toString(),
      exact: maximumDifferenceMicros === 0n && feeDifferenceMicros === 0n,
      withinTolerance: true,
    },
    equitySeries: Chunk.toReadonlyArray(Chunk.reverse(state.reversedEquitySeries)),
  })
}

export const reconstructMarkedEquity = (prepared: PreparedReconciliation): Validation<MarkedEquityProof> =>
  pipe(
    initialReconstructionState(prepared),
    Result.flatMap((initial) => reconcileAllMarks(prepared, initial)),
    Result.flatMap((state) => ensureAllEventsReconciled(prepared, state)),
    Result.flatMap((state) => buildMarkedEquityProof(prepared, state)),
  )
