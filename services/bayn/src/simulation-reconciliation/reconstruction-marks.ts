import { Chunk, pipe, Result } from 'effect'

import { notionalMicros } from '../execution-model'
import type { DailyPositionMark } from '../types'
import type { EvidenceMismatchProblem, SimulationReconciliationIssue, Validation } from './model'
import type { PreparedReconciliation } from './preparation'
import { applyEvent, type ReconstructionState } from './reconstruction-events'
import { absolute, fail, failIssues, markUnsigned, positionUnsigned } from './validation'

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
            if (Result.isFailure(actual)) return issues.length > 0 ? failIssues(issues) : Result.fail(actual.failure)
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

const applyEventsAtMark = (
  prepared: PreparedReconciliation,
  state: ReconstructionState,
  mark: DailyPositionMark,
): Validation<ReconstructionState> =>
  pipe(
    selectDueEventRange(prepared, state, mark),
    Result.flatMap((range) =>
      prepared.monetaryEvents.slice(range.startIndex, range.endIndex).reduce<Validation<ReconstructionState>>(
        (reconstructed, event) =>
          pipe(
            reconstructed,
            Result.flatMap((snapshot) => applyEvent(prepared, snapshot, event)),
          ),
        Result.succeed(state),
      ),
    ),
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

export const reconcileAllMarks = (
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
