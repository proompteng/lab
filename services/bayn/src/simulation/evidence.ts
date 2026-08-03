import { Chunk, pipe, Result } from 'effect'

import {
  accrueCashYield,
  elapsedCalendarDays,
  makeOrderOutcome,
  type FeeBreakdown,
  type FillTerms,
} from '../execution-model'
import {
  ContractVersion,
  type CashChange,
  type CashYieldEvent,
  type DecisionEvent,
  type FeeEvent,
  type FillEvent,
  type IsoDate,
  type SimulationProtocol,
} from '../types'
import type { AlignedSession, PreparedOrder, SimulationFailure, SimulationInput, SimulationTarget } from './model'
import { canonicalHashResult } from './inputs'
import type { PreparedFill, SimulationState } from './state'

const fail = <A = never>(failure: SimulationFailure): Result.Result<A, SimulationFailure> => Result.fail(failure)

export const parseMicros = (
  value: string,
  field: Extract<SimulationFailure, { readonly _tag: 'InvalidMicrosString' }>['field'],
): Result.Result<bigint, SimulationFailure> =>
  /^[0-9]+$/.test(value) ? Result.succeed(BigInt(value)) : fail({ _tag: 'InvalidMicrosString', field, value })

export const makeDecision = (
  runId: string,
  target: SimulationTarget,
  signalDate: IsoDate,
  executionDate: IsoDate,
): Result.Result<DecisionEvent, SimulationFailure> => {
  const payload = {
    signalDate,
    executionDate,
    targetWeights: target.weights,
    ...(target.terminalClose === true ? { terminalClose: true as const } : {}),
  }
  return pipe(
    canonicalHashResult('decision', { runId, kind: 'decision', ...payload }),
    Result.map((id) => ({ kind: 'decision' as const, id, ...payload })),
  )
}

export const makeOrder = (
  runId: string,
  decision: DecisionEvent,
  sessionDate: IsoDate,
  symbol: string,
  side: 'buy' | 'sell',
  requestedQuantityMicros: bigint,
  referencePrice: bigint,
  protocol: SimulationProtocol,
  forceFullFill = false,
): Result.Result<PreparedOrder, SimulationFailure> =>
  pipe(
    makeOrderOutcome({
      identity: {
        schemaVersion: ContractVersion.PartialFillSeed,
        signalDate: decision.signalDate,
        executionDate: decision.executionDate,
        symbol,
        side,
        ...(forceFullFill ? { forceFullFill: true } : {}),
      },
      side,
      requestedQuantityMicros,
      referencePriceMicros: referencePrice,
      model: protocol.executionModel,
      forceFullFill,
    }),
    Result.flatMap((outcome) => {
      const payload = {
        decisionId: decision.id,
        sessionDate,
        symbol,
        side,
        requestedQuantityMicros: outcome.requestedQuantityMicros.toString(),
        filledQuantityMicros: outcome.filledQuantityMicros.toString(),
        status: outcome.status,
        rejectionReason: outcome.rejectionReason,
        unfilledRemainder: outcome.unfilledRemainder,
      }
      return pipe(
        canonicalHashResult('order', { runId, kind: 'order', ...payload }),
        Result.map((id) => ({
          event: { id, ...payload },
          filledQuantityMicros: outcome.filledQuantityMicros,
        })),
      )
    }),
  )

export const limitOrderFillToBuyingPower = (
  runId: string,
  order: PreparedOrder,
  filledQuantityMicros: bigint,
): Result.Result<PreparedOrder, SimulationFailure> => {
  if (order.filledQuantityMicros === 0n || filledQuantityMicros === order.filledQuantityMicros) {
    return Result.succeed(order)
  }
  if (filledQuantityMicros < 0n || filledQuantityMicros > order.filledQuantityMicros) {
    return fail({
      _tag: 'InvalidFillAdjustment',
      modeledFilledQuantityMicros: order.filledQuantityMicros,
      adjustedFilledQuantityMicros: filledQuantityMicros,
    })
  }
  const payload = {
    decisionId: order.event.decisionId,
    sessionDate: order.event.sessionDate,
    symbol: order.event.symbol,
    side: order.event.side,
    requestedQuantityMicros: order.event.requestedQuantityMicros,
    filledQuantityMicros: filledQuantityMicros.toString(),
    status: filledQuantityMicros === 0n ? ('rejected' as const) : ('partially-filled' as const),
    rejectionReason: filledQuantityMicros === 0n ? ('insufficient-buying-power' as const) : null,
    unfilledRemainder: 'canceled' as const,
  }
  return pipe(
    canonicalHashResult('order', { runId, kind: 'order', ...payload }),
    Result.map((id) => ({ event: { id, ...payload }, filledQuantityMicros })),
  )
}

export const makeFill = (
  runId: string,
  decision: DecisionEvent,
  order: PreparedOrder,
  terms: FillTerms,
  costBasisMicros: bigint,
): Result.Result<PreparedFill, SimulationFailure> => {
  const payload = {
    orderId: order.event.id,
    decisionId: decision.id,
    sessionDate: order.event.sessionDate,
    symbol: order.event.symbol,
    side: order.event.side,
    quantityMicros: order.filledQuantityMicros.toString(),
    referencePriceMicros: terms.referencePriceMicros.toString(),
    priceMicros: terms.fillPriceMicros.toString(),
    notionalMicros: terms.notionalMicros.toString(),
    spreadCostMicros: terms.spreadCostMicros.toString(),
    slippageCostMicros: terms.slippageCostMicros.toString(),
    costBasisMicros: costBasisMicros.toString(),
  }
  return pipe(
    canonicalHashResult('fill', { runId, kind: 'fill', ...payload }),
    Result.map((id) => ({
      event: { kind: 'fill' as const, id, ...payload },
      quantityMicros: order.filledQuantityMicros,
      notionalMicros: terms.notionalMicros,
    })),
  )
}

export const makeCashChange = (
  runId: string,
  source:
    | Pick<FillEvent | FeeEvent, 'kind' | 'id' | 'sessionDate'>
    | { readonly kind: 'cash-yield'; readonly id: string; readonly sessionDate: IsoDate },
  amountMicros: bigint,
  cashAfterMicros: bigint,
): Result.Result<CashChange, SimulationFailure> => {
  const payload = {
    sourceKind: source.kind,
    sourceId: source.id,
    sessionDate: source.sessionDate,
    amountMicros: amountMicros.toString(),
    cashAfterMicros: cashAfterMicros.toString(),
  }
  return pipe(
    canonicalHashResult('cash-change', { runId, kind: 'cash-change', ...payload }),
    Result.map((id) => ({ id, ...payload })),
  )
}

export const makeFeeEvent = (
  runId: string,
  sessionDate: IsoDate,
  fees: FeeBreakdown,
): Result.Result<FeeEvent, SimulationFailure> => {
  const payload = {
    sessionDate,
    commissionMicros: fees.commissionMicros.toString(),
    secMicros: fees.secMicros.toString(),
    tafMicros: fees.tafMicros.toString(),
    catMicros: fees.catMicros.toString(),
    totalMicros: fees.totalMicros.toString(),
  }
  return pipe(
    canonicalHashResult('fee', { runId, kind: 'fee', ...payload }),
    Result.map((id) => ({ kind: 'fee' as const, id, ...payload })),
  )
}

const makeCashYieldEvent = (
  runId: string,
  sessionDate: IsoDate,
  elapsedDays: number,
  annualYieldBps: number,
  amountMicros: bigint,
): Result.Result<CashYieldEvent, SimulationFailure> => {
  const payload = { sessionDate, elapsedDays, annualYieldBps, amountMicros: amountMicros.toString() }
  return pipe(
    canonicalHashResult('yield', { runId, kind: 'cash-yield', ...payload }),
    Result.map((id) => ({ kind: 'cash-yield' as const, id, ...payload })),
  )
}

export const appendFillEvidence = (
  state: SimulationState,
  fill: PreparedFill,
  amountMicros: bigint,
  runId: string,
  recordEvents: boolean,
): Result.Result<SimulationState, SimulationFailure> =>
  recordEvents
    ? pipe(
        makeCashChange(runId, fill.event, amountMicros, state.cashMicros),
        Result.map((cashChange) => ({
          ...state,
          events: Chunk.append(state.events, fill.event),
          cashChanges: Chunk.append(state.cashChanges, cashChange),
        })),
      )
    : Result.succeed(state)

export const appendOrder = (state: SimulationState, order: PreparedOrder, recordEvents: boolean): SimulationState =>
  recordEvents ? { ...state, orders: Chunk.append(state.orders, order.event) } : state

export const recordDecision = (
  state: SimulationState,
  target: SimulationTarget,
  decision: DecisionEvent,
  recordEvents: boolean,
): Result.Result<SimulationState, SimulationFailure> => {
  if (!recordEvents) return Result.succeed(state)
  if (target.decision === undefined && target.requireDecisionEvidence !== false) {
    return fail({
      _tag: 'CandidateDecisionMissing',
      signalIndex: target.signalIndex,
      executionIndex: target.executionIndex,
    })
  }
  if (target.decision === undefined) return Result.succeed({ ...state, events: Chunk.append(state.events, decision) })
  return pipe(
    Result.all({
      decisionWeightsHash: canonicalHashResult('decision-target', target.decision.targetWeights),
      targetWeightsHash: canonicalHashResult('decision-target', decision.targetWeights),
    }),
    Result.flatMap(({ decisionWeightsHash, targetWeightsHash }) =>
      target.decision?.signalDate === decision.signalDate && decisionWeightsHash === targetWeightsHash
        ? Result.succeed({
            ...state,
            events: Chunk.append(state.events, decision),
            signalDecisions: Chunk.append(state.signalDecisions, {
              ...target.decision,
              decisionId: decision.id,
              executionDate: decision.executionDate,
            }),
          })
        : fail({
            _tag: 'DecisionTargetMismatch',
            signalDate: decision.signalDate,
            executionDate: decision.executionDate,
            decisionWeightsHash,
            targetWeightsHash,
          }),
    ),
  )
}

export const accrueSessionCash = (
  state: SimulationState,
  session: AlignedSession,
  input: SimulationInput,
): Result.Result<SimulationState, SimulationFailure> => {
  if (state.previousSessionDate === null) {
    return Result.succeed({ ...state, previousSessionDate: session.date })
  }
  return pipe(
    elapsedCalendarDays(state.previousSessionDate, session.date),
    Result.flatMap((elapsedDays) =>
      pipe(
        accrueCashYield(state.cashMicros, elapsedDays, input.protocol.executionModel),
        Result.flatMap((cashYield) => {
          if (cashYield === 0n) {
            return Result.succeed({ ...state, previousSessionDate: session.date })
          }
          const updated = {
            ...state,
            cashMicros: state.cashMicros + cashYield,
            totalCashYieldMicros: state.totalCashYieldMicros + cashYield,
            previousSessionDate: session.date,
          }
          if (!input.recordEvents) return Result.succeed(updated)
          return pipe(
            makeCashYieldEvent(
              input.runId,
              session.date,
              elapsedDays,
              input.protocol.executionModel.cash.annualYieldBps,
              cashYield,
            ),
            Result.flatMap((event) =>
              pipe(
                makeCashChange(input.runId, event, cashYield, updated.cashMicros),
                Result.map((cashChange) => ({
                  ...updated,
                  events: Chunk.append(updated.events, event),
                  cashChanges: Chunk.append(updated.cashChanges, cashChange),
                })),
              ),
            ),
          )
        }),
      ),
    ),
  )
}
