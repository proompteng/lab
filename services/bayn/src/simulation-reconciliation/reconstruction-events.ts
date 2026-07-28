import { Chunk, Result } from 'effect'

import { accrueCashYield } from '../execution-model'
import type { CashYieldEvent, EquityPoint, SimulationTrace } from '../types'
import { validateCashChange } from './mark-validation'
import type { FailedComputation, SimulationReconciliationIssue, Validation } from './model'
import type { PreparedFee, PreparedFill, PreparedMonetaryEvent, PreparedReconciliation } from './preparation'
import { fail, failIssues, unsigned, validateCanonicalIdentity } from './validation'

export interface ReconstructionState {
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

export const applyEvent = (
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
