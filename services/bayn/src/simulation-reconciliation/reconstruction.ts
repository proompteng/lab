import { Chunk, pipe, Result } from 'effect'

import { accrueCashYield, notionalMicros } from '../execution-model'
import type { CashYieldEvent, DailyPositionMark, EquityPoint, SimulationTrace } from '../types'
import type {
  EvidenceMismatchProblem,
  FailedComputation,
  MarkedEquityProof,
  SimulationReconciliationIssue,
  Validation,
} from './model'
import {
  absolute,
  fail,
  failIssues,
  markUnsigned,
  positionUnsigned,
  unsigned,
  validateCanonicalIdentity,
  validateCashChange,
  type PreparedFee,
  type PreparedFill,
  type PreparedMonetaryEvent,
  type PreparedReconciliation,
} from './validation'

interface ReconstructionState {
  readonly cashMicros: bigint
  readonly quantities: ReadonlyMap<string, bigint>
  readonly eventIndex: number
  readonly reconstructedTotalFeesMicros: bigint
  readonly cumulativeTurnoverMicros: bigint
  readonly cumulativeSpreadMicros: bigint
  readonly cumulativeSlippageMicros: bigint
  readonly cumulativeCashYieldMicros: bigint
  readonly maximumDifferenceMicros: bigint
  readonly finalPositionValueMicros: bigint
  readonly reversedEquitySeries: Chunk.Chunk<EquityPoint>
}

interface EventTransition {
  readonly amountMicros: bigint
  readonly quantityChange?: { readonly symbol: string; readonly quantityMicros: bigint }
  readonly feeMicros: bigint
  readonly turnoverMicros: bigint
  readonly spreadMicros: bigint
  readonly slippageMicros: bigint
  readonly cashYieldMicros: bigint
}

const fillTransition = (state: ReconstructionState, fill: PreparedFill): Validation<EventTransition> => {
  const event = fill.event
  const current = state.quantities.get(event.symbol) ?? 0n
  const next = event.side === 'buy' ? current + fill.quantityMicros : current - fill.quantityMicros
  if (next < 0n) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'NegativeLongPosition',
        fillId: event.id,
        symbol: event.symbol,
        actualQuantityMicros: next.toString(),
      },
    })
  }
  return Result.succeed({
    amountMicros: event.side === 'buy' ? -fill.notionalMicros : fill.notionalMicros,
    quantityChange: { symbol: event.symbol, quantityMicros: next },
    feeMicros: 0n,
    turnoverMicros: fill.notionalMicros,
    spreadMicros: fill.spreadCostMicros,
    slippageMicros: fill.slippageCostMicros,
    cashYieldMicros: 0n,
  })
}

const feeTransition = (fee: PreparedFee): EventTransition => ({
  amountMicros: -fee.totalMicros,
  feeMicros: fee.totalMicros,
  turnoverMicros: 0n,
  spreadMicros: 0n,
  slippageMicros: 0n,
  cashYieldMicros: 0n,
})

const cashYieldTransition = (
  runId: string,
  cashMicros: bigint,
  event: CashYieldEvent,
  simulation: SimulationTrace,
): Validation<EventTransition> => {
  if (event.annualYieldBps !== simulation.executionModel.cash.annualYieldBps) {
    return fail({
      _tag: 'EvidenceMismatch',
      problem: {
        _tag: 'CashYield',
        cashYieldId: event.id,
        field: 'annualYieldBps',
        actual: String(event.annualYieldBps),
        expected: String(simulation.executionModel.cash.annualYieldBps),
      },
    })
  }
  const computation: FailedComputation = {
    _tag: 'CashYield',
    cashYieldId: event.id,
    cashMicros: cashMicros.toString(),
    elapsedDays: event.elapsedDays,
    annualYieldBps: simulation.executionModel.cash.annualYieldBps,
  }
  const expected = Result.mapError(
    accrueCashYield(cashMicros, event.elapsedDays, simulation.executionModel),
    (cause): readonly SimulationReconciliationIssue[] => [{ _tag: 'ComputationFailed', computation, cause }],
  )
  if (Result.isFailure(expected)) return failIssues(expected.failure)
  const amount = unsigned({
    kind: 'cash-yield',
    cashYieldId: event.id,
    field: 'amountMicros',
    value: event.amountMicros,
  })
  if (Result.isFailure(amount)) return failIssues(amount.failure)
  if (amount.success !== expected.success) {
    return fail({
      _tag: 'EvidenceMismatch',
      problem: {
        _tag: 'CashYield',
        cashYieldId: event.id,
        field: 'amountMicros',
        actual: amount.success.toString(),
        expected: expected.success.toString(),
      },
    })
  }
  const { id: _, kind: __, ...payload } = event
  const identity = validateCanonicalIdentity(
    { kind: 'cash-yield', id: event.id, sessionDate: event.sessionDate },
    { runId, kind: 'cash-yield', ...payload },
  )
  if (Result.isFailure(identity)) return failIssues(identity.failure)
  return Result.succeed({
    amountMicros: expected.success,
    feeMicros: 0n,
    turnoverMicros: 0n,
    spreadMicros: 0n,
    slippageMicros: 0n,
    cashYieldMicros: expected.success,
  })
}

const eventTransition = (
  prepared: PreparedReconciliation,
  state: ReconstructionState,
  preparedEvent: PreparedMonetaryEvent,
): Validation<EventTransition> => {
  switch (preparedEvent.kind) {
    case 'fill':
      return fillTransition(state, preparedEvent)
    case 'fee':
      return Result.succeed(feeTransition(preparedEvent))
    case 'cash-yield':
      return cashYieldTransition(prepared.input.runId, state.cashMicros, preparedEvent.event, prepared.input.simulation)
  }
}

const updateQuantities = (
  quantities: ReadonlyMap<string, bigint>,
  change: EventTransition['quantityChange'],
): ReadonlyMap<string, bigint> => {
  if (change === undefined) return quantities
  const retained = [...quantities].filter(([symbol]) => symbol !== change.symbol)
  return new Map(
    change.quantityMicros === 0n ? retained : [...retained, [change.symbol, change.quantityMicros] as const],
  )
}

const applyEvent = (
  prepared: PreparedReconciliation,
  state: ReconstructionState,
  preparedEvent: PreparedMonetaryEvent,
): Validation<ReconstructionState> => {
  const event = preparedEvent.event
  const transition = eventTransition(prepared, state, preparedEvent)
  if (Result.isFailure(transition)) return failIssues(transition.failure)
  const cashMicros = state.cashMicros + transition.success.amountMicros
  if (cashMicros < -prepared.toleranceMicros) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'NegativeCash',
        eventId: event.id,
        actualMicros: cashMicros.toString(),
        minimumMicros: (-prepared.toleranceMicros).toString(),
      },
    })
  }
  const validChange = validateCashChange(
    prepared.input.runId,
    preparedEvent.cashChange,
    event,
    transition.success.amountMicros,
    cashMicros,
  )
  if (Result.isFailure(validChange)) return failIssues(validChange.failure)
  return Result.succeed({
    ...state,
    cashMicros,
    quantities: updateQuantities(state.quantities, transition.success.quantityChange),
    eventIndex: state.eventIndex + 1,
    reconstructedTotalFeesMicros: state.reconstructedTotalFeesMicros + transition.success.feeMicros,
    cumulativeTurnoverMicros: state.cumulativeTurnoverMicros + transition.success.turnoverMicros,
    cumulativeSpreadMicros: state.cumulativeSpreadMicros + transition.success.spreadMicros,
    cumulativeSlippageMicros: state.cumulativeSlippageMicros + transition.success.slippageMicros,
    cumulativeCashYieldMicros: state.cumulativeCashYieldMicros + transition.success.cashYieldMicros,
  })
}

interface MarkBaselines {
  readonly turnoverMicros: bigint
  readonly feeMicros: bigint
  readonly spreadMicros: bigint
  readonly slippageMicros: bigint
  readonly cashYieldMicros: bigint
}

const validateDailyMarkCounters = (
  mark: DailyPositionMark,
  state: ReconstructionState,
  baselines: MarkBaselines,
): Validation<void> => {
  const checks: readonly [Extract<EvidenceMismatchProblem, { readonly _tag: 'DailyMark' }>['field'], bigint][] = [
    ['turnoverMicros', state.cumulativeTurnoverMicros - baselines.turnoverMicros],
    ['cumulativeTurnoverMicros', state.cumulativeTurnoverMicros],
    ['feeMicros', state.reconstructedTotalFeesMicros - baselines.feeMicros],
    ['cumulativeFeesMicros', state.reconstructedTotalFeesMicros],
    ['spreadCostMicros', state.cumulativeSpreadMicros - baselines.spreadMicros],
    ['cumulativeSpreadCostMicros', state.cumulativeSpreadMicros],
    ['slippageCostMicros', state.cumulativeSlippageMicros - baselines.slippageMicros],
    ['cumulativeSlippageCostMicros', state.cumulativeSlippageMicros],
    ['cashYieldMicros', state.cumulativeCashYieldMicros - baselines.cashYieldMicros],
    ['cumulativeCashYieldMicros', state.cumulativeCashYieldMicros],
  ]
  return pipe(
    checks.reduce<Validation<readonly SimulationReconciliationIssue[]>>(
      (collected, [field, expected]) =>
        pipe(
          collected,
          Result.flatMap((issues) => {
            const actual = markUnsigned(mark, field)
            if (Result.isFailure(actual)) {
              return issues.length > 0 ? failIssues(issues) : Result.fail(actual.failure)
            }
            return Result.succeed(
              actual.success === expected
                ? issues
                : [
                    ...issues,
                    {
                      _tag: 'EvidenceMismatch' as const,
                      problem: {
                        _tag: 'DailyMark' as const,
                        sessionDate: mark.sessionDate,
                        field,
                        actualMicros: actual.success.toString(),
                        expectedMicros: expected.toString(),
                      },
                    },
                  ],
            )
          }),
        ),
      Result.succeed([]),
    ),
    Result.flatMap((issues) => (issues.length > 0 ? failIssues(issues) : Result.succeed(undefined))),
  )
}

const valueMarkedPositions = (state: ReconstructionState, mark: DailyPositionMark): Validation<bigint> => {
  const valued = mark.positions.reduce<
    Validation<{ readonly totalMicros: bigint; readonly symbols: ReadonlySet<string> }>
  >(
    (current, position) =>
      pipe(
        current,
        Result.flatMap((accumulator) => {
          const price = positionUnsigned(mark, position, 'priceMicros')
          if (Result.isFailure(price)) return failIssues(price.failure)
          const quantity = state.quantities.get(position.symbol) ?? 0n
          const markedQuantity = positionUnsigned(mark, position, 'quantityMicros')
          if (Result.isFailure(markedQuantity)) return failIssues(markedQuantity.failure)
          const quantityIssues: readonly SimulationReconciliationIssue[] =
            markedQuantity.success === quantity
              ? []
              : [
                  {
                    _tag: 'EvidenceMismatch',
                    problem: {
                      _tag: 'PositionMark',
                      sessionDate: mark.sessionDate,
                      symbol: position.symbol,
                      field: 'quantityMicros',
                      actualMicros: markedQuantity.success.toString(),
                      expectedMicros: quantity.toString(),
                    },
                  },
                ]
          const costBasis = positionUnsigned(mark, position, 'costBasisMicros')
          if (Result.isFailure(costBasis)) {
            return quantityIssues.length > 0 ? failIssues(quantityIssues) : Result.fail(costBasis.failure)
          }
          const reconstructedValue = notionalMicros(quantity, price.success)
          if (Result.isFailure(reconstructedValue)) {
            return fail({
              _tag: 'ComputationFailed',
              computation: {
                _tag: 'PositionNotional',
                sessionDate: mark.sessionDate,
                symbol: position.symbol,
                quantityMicros: quantity.toString(),
                priceMicros: price.success.toString(),
              },
              cause: reconstructedValue.failure,
            })
          }
          const marketValue = positionUnsigned(mark, position, 'marketValueMicros')
          if (Result.isFailure(marketValue)) {
            return quantityIssues.length > 0 ? failIssues(quantityIssues) : Result.fail(marketValue.failure)
          }
          const issues: readonly SimulationReconciliationIssue[] =
            marketValue.success === reconstructedValue.success
              ? quantityIssues
              : [
                  ...quantityIssues,
                  {
                    _tag: 'EvidenceMismatch',
                    problem: {
                      _tag: 'PositionMark',
                      sessionDate: mark.sessionDate,
                      symbol: position.symbol,
                      field: 'marketValueMicros',
                      actualMicros: marketValue.success.toString(),
                      expectedMicros: reconstructedValue.success.toString(),
                    },
                  },
                ]
          return issues.length > 0
            ? failIssues(issues)
            : Result.succeed({
                totalMicros: accumulator.totalMicros + reconstructedValue.success,
                symbols: new Set([...accumulator.symbols, position.symbol]),
              })
        }),
      ),
    Result.succeed({ totalMicros: 0n, symbols: new Set() }),
  )
  if (Result.isFailure(valued)) return failIssues(valued.failure)
  const missing = [...state.quantities].find(([symbol]) => !valued.success.symbols.has(symbol))
  return missing === undefined
    ? Result.succeed(valued.success.totalMicros)
    : fail({
        _tag: 'IncompleteEvidence',
        problem: {
          _tag: 'MissingOpenPositionMark',
          sessionDate: mark.sessionDate,
          symbol: missing[0],
          quantityMicros: missing[1].toString(),
        },
      })
}

interface DueEventRange {
  readonly startIndex: number
  readonly endIndex: number
}

const selectDueEventRange = (
  prepared: PreparedReconciliation,
  state: ReconstructionState,
  mark: DailyPositionMark,
): Validation<DueEventRange> => {
  const first = prepared.monetaryEvents[state.eventIndex]
  if (first === undefined || first.event.sessionDate > mark.sessionDate) {
    return Result.succeed({ startIndex: state.eventIndex, endIndex: state.eventIndex })
  }
  if (first.event.sessionDate < mark.sessionDate) {
    return fail({
      _tag: 'IncompleteEvidence',
      problem: {
        _tag: 'MissingSessionMark',
        eventId: first.event.id,
        eventSessionDate: first.event.sessionDate,
        nextMarkSessionDate: mark.sessionDate,
      },
    })
  }
  let endIndex = state.eventIndex + 1
  while (prepared.monetaryEvents[endIndex]?.event.sessionDate === mark.sessionDate) endIndex += 1
  return Result.succeed({ startIndex: state.eventIndex, endIndex })
}

const applyEventRange = (
  prepared: PreparedReconciliation,
  state: ReconstructionState,
  range: DueEventRange,
): Validation<ReconstructionState> =>
  prepared.monetaryEvents.slice(range.startIndex, range.endIndex).reduce<Validation<ReconstructionState>>(
    (reconstructed, event) =>
      pipe(
        reconstructed,
        Result.flatMap((snapshot) => applyEvent(prepared, snapshot, event)),
      ),
    Result.succeed(state),
  )

const applyEventsAtMark = (
  prepared: PreparedReconciliation,
  state: ReconstructionState,
  mark: DailyPositionMark,
): Validation<ReconstructionState> =>
  pipe(
    selectDueEventRange(prepared, state, mark),
    Result.flatMap((range) => applyEventRange(prepared, state, range)),
  )

const reconcileDailyMark = (
  prepared: PreparedReconciliation,
  state: ReconstructionState,
  mark: DailyPositionMark,
): Validation<ReconstructionState> => {
  const baselines: MarkBaselines = {
    turnoverMicros: state.cumulativeTurnoverMicros,
    feeMicros: state.reconstructedTotalFeesMicros,
    spreadMicros: state.cumulativeSpreadMicros,
    slippageMicros: state.cumulativeSlippageMicros,
    cashYieldMicros: state.cumulativeCashYieldMicros,
  }
  const applied = applyEventsAtMark(prepared, state, mark)
  if (Result.isFailure(applied)) return failIssues(applied.failure)
  const next = applied.success
  const counters = validateDailyMarkCounters(mark, next, baselines)
  if (Result.isFailure(counters)) return failIssues(counters.failure)
  const markCash = markUnsigned(mark, 'cashMicros')
  if (Result.isFailure(markCash)) return failIssues(markCash.failure)
  const cashDifference = absolute(markCash.success - next.cashMicros)
  if (cashDifference > prepared.toleranceMicros) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'DailyOutsideTolerance',
        measure: 'daily-cash',
        sessionDate: mark.sessionDate,
        differenceMicros: cashDifference.toString(),
        toleranceMicros: prepared.toleranceMicros.toString(),
      },
    })
  }
  const positionValue = valueMarkedPositions(next, mark)
  if (Result.isFailure(positionValue)) return failIssues(positionValue.failure)
  const reconstructedEquityMicros = next.cashMicros + positionValue.success
  const evaluatorEquity = markUnsigned(mark, 'equityMicros')
  if (Result.isFailure(evaluatorEquity)) return failIssues(evaluatorEquity.failure)
  const equityDifference = absolute(reconstructedEquityMicros - evaluatorEquity.success)
  if (equityDifference > prepared.toleranceMicros) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'DailyOutsideTolerance',
        measure: 'daily-equity',
        sessionDate: mark.sessionDate,
        differenceMicros: equityDifference.toString(),
        toleranceMicros: prepared.toleranceMicros.toString(),
      },
    })
  }
  return Result.succeed({
    ...next,
    maximumDifferenceMicros:
      next.maximumDifferenceMicros > equityDifference ? next.maximumDifferenceMicros : equityDifference,
    finalPositionValueMicros: positionValue.success,
    reversedEquitySeries: Chunk.prepend(next.reversedEquitySeries, {
      sessionDate: mark.sessionDate,
      evaluatorEquityMicros: evaluatorEquity.success.toString(),
      reconstructedEquityMicros: reconstructedEquityMicros.toString(),
      differenceMicros: equityDifference.toString(),
    }),
  })
}

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

const reconcileAllMarks = (
  prepared: PreparedReconciliation,
  initial: ReconstructionState,
): Validation<ReconstructionState> =>
  prepared.input.simulation.dailyMarks.reduce<Validation<ReconstructionState>>(
    (current, mark) =>
      pipe(
        current,
        Result.flatMap((state) => reconcileDailyMark(prepared, state, mark)),
      ),
    Result.succeed(initial),
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
