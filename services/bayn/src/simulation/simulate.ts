import { Chunk, pipe, Result } from 'effect'

import { ContractVersion, type SimulationProtocol } from '../types'
import type { FeeEvent, FillEvent, IsoDate } from '../types'
import { calculateSessionFees } from '../execution-model'
import { accrueSessionCash, makeCashChange, makeFeeEvent, parseMicros } from './evidence'
import { calculateExactPerformanceMetrics } from './metrics'
import type { AlignedSession, SimulationDecision, SimulationFailure, SimulationInput, SimulationTarget } from './model'
import { rebalanceSession } from './rebalance'
import { initialState, type SessionOpeningSnapshot, type SimulationState } from './state'
import { closeSession } from './valuation'

const fail = <A = never>(failure: SimulationFailure): Result.Result<A, SimulationFailure> => Result.fail(failure)

const openingSnapshot = (state: SimulationState): SessionOpeningSnapshot => ({
  planningCashMicros: state.cashMicros,
  turnoverMicros: state.turnoverMicros,
  totalFeesMicros: state.totalFeesMicros,
  totalSpreadCostMicros: state.totalSpreadCostMicros,
  totalSlippageCostMicros: state.totalSlippageCostMicros,
  totalCashYieldMicros: state.totalCashYieldMicros,
})

const hasOpenPosition = (state: SimulationState): boolean =>
  Object.values(state.positions).some((position) => position.quantityMicros !== 0n)

const consolidateSessionFees = (
  state: SimulationState,
  sessionDate: IsoDate,
  opening: SessionOpeningSnapshot,
  input: SimulationInput,
): Result.Result<SimulationState, SimulationFailure> => {
  const feeInputs = state.sessionFeeInputs
  if (feeInputs.length === 0) return Result.succeed({ ...state, sessionFeeInputs: [] })
  const expectedResult = calculateSessionFees(feeInputs, input.protocol.executionModel, input.costMultiplierMicros)
  if (Result.isFailure(expectedResult)) return Result.fail(expectedResult.failure)
  const expected = expectedResult.success
  const chargedWithoutTrace = state.totalFeesMicros - opening.totalFeesMicros
  if (!input.recordEvents) {
    return Result.succeed({
      ...state,
      cashMicros: state.cashMicros + chargedWithoutTrace - expected.totalMicros,
      totalFeesMicros: state.totalFeesMicros - chargedWithoutTrace + expected.totalMicros,
      sessionFeeInputs: [],
    })
  }
  const events = Chunk.toReadonlyArray(state.events)
  const fees = events.filter((event): event is FeeEvent => event.kind === 'fee' && event.sessionDate === sessionDate)
  if (fees.length === 0) return Result.succeed({ ...state, sessionFeeInputs: [] })
  const feeIds = new Set(fees.map((fee) => fee.id))
  const charged = fees.reduce(
    (sum, fee) => ({
      commissionMicros: sum.commissionMicros + BigInt(fee.commissionMicros),
      secMicros: sum.secMicros + BigInt(fee.secMicros),
      tafMicros: sum.tafMicros + BigInt(fee.tafMicros),
      catMicros: sum.catMicros + BigInt(fee.catMicros),
      totalMicros: sum.totalMicros + BigInt(fee.totalMicros),
    }),
    {
      commissionMicros: 0n,
      secMicros: 0n,
      tafMicros: 0n,
      catMicros: 0n,
      totalMicros: 0n,
    },
  )
  const eventIndexById = new Map(events.map((event, index) => [event.id, index]))
  const adjustedCashChanges = Result.all(
    Chunk.toReadonlyArray(state.cashChanges)
      .filter((change) => change.sourceKind !== 'fee' || !feeIds.has(change.sourceId))
      .map((change) => {
        if (change.sourceKind !== 'fill') return Result.succeed(change)
        const source = events.find((event): event is FillEvent => event.kind === 'fill' && event.id === change.sourceId)
        const sourceIndex = eventIndexById.get(change.sourceId)
        if (source === undefined || sourceIndex === undefined) return Result.succeed(change)
        const removedBefore = fees
          .filter((fee) => (eventIndexById.get(fee.id) ?? Number.MAX_SAFE_INTEGER) < sourceIndex)
          .reduce((total, fee) => total + BigInt(fee.totalMicros), 0n)
        return removedBefore === 0n
          ? Result.succeed(change)
          : makeCashChange(
              input.runId,
              source,
              BigInt(change.amountMicros),
              BigInt(change.cashAfterMicros) + removedBefore,
            )
      }),
  )
  return pipe(
    Result.all({
      cashChanges: adjustedCashChanges,
      expected: Result.succeed(expected),
    }),
    Result.flatMap(({ cashChanges, expected }) =>
      pipe(
        makeFeeEvent(input.runId, sessionDate, expected),
        Result.flatMap((fee) => {
          const correctedState = {
            ...state,
            cashMicros: state.cashMicros + charged.totalMicros - expected.totalMicros,
            totalFeesMicros: state.totalFeesMicros - charged.totalMicros + expected.totalMicros,
            sessionFeeInputs: [],
          }
          return pipe(
            makeCashChange(input.runId, fee, -expected.totalMicros, correctedState.cashMicros),
            Result.map((cashChange) => ({ correctedState, cashChanges, fee, cashChange })),
          )
        }),
      ),
    ),
    Result.map(({ correctedState, cashChanges, fee, cashChange }) => ({
      ...correctedState,
      events: Chunk.fromIterable([...events.filter((event) => event.kind !== 'fee' || !feeIds.has(event.id)), fee]),
      cashChanges: Chunk.fromIterable([...cashChanges, cashChange]),
    })),
  )
}

const terminalCloseTarget = (
  input: SimulationInput,
  source: SimulationTarget | undefined,
  finalSessionIndex: number,
): SimulationTarget => ({
  ...source,
  signalIndex: Math.max(0, finalSessionIndex - 1),
  executionIndex: finalSessionIndex,
  weights: Object.fromEntries(input.protocol.universe.map((symbol) => [symbol, 0])),
  requireDecisionEvidence: false,
  terminalClose: true,
})

const runSession = (
  state: SimulationState,
  session: AlignedSession,
  index: number,
  targets: Readonly<Record<number, SimulationTarget>>,
  input: SimulationInput,
): Result.Result<SimulationState, SimulationFailure> => {
  const opening = openingSnapshot(state)
  return pipe(
    accrueSessionCash(state, session, input),
    Result.flatMap((accrued) => {
      const target = targets[index]
      return target === undefined ? Result.succeed(accrued) : rebalanceSession(accrued, session, target, opening, input)
    }),
    Result.flatMap((updated) => {
      if (input.terminalCloseTarget === undefined || index !== input.sessions.length - 1 || !hasOpenPosition(updated)) {
        return Result.succeed(updated)
      }
      const source = targets[index] ?? input.targets.at(-1)
      const terminalTarget =
        input.terminalCloseTarget?.(source ?? terminalCloseTarget(input, undefined, index), index) ??
        terminalCloseTarget(input, source, index)
      return rebalanceSession(updated, session, terminalTarget, openingSnapshot(updated), input)
    }),
    Result.flatMap((updated) => consolidateSessionFees(updated, session.date, opening, input)),
    Result.flatMap((updated) => closeSession(updated, session, opening, input)),
  )
}

const targetSchedule = (
  targets: readonly SimulationTarget[],
): Result.Result<Readonly<Record<number, SimulationTarget>>, SimulationFailure> => {
  const duplicate = targets.find((target, index) =>
    targets.slice(0, index).some((prior) => prior.executionIndex === target.executionIndex),
  )
  return duplicate === undefined
    ? Result.succeed(Object.fromEntries(targets.map((target) => [target.executionIndex, target])))
    : fail({ _tag: 'DuplicateExecutionTarget', executionIndex: duplicate.executionIndex })
}

const completeSimulation = (
  state: SimulationState,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  recordEvents: boolean,
): SimulationDecision =>
  pipe(
    calculateExactPerformanceMetrics(
      Chunk.toReadonlyArray(state.equityMicros),
      state.turnoverMicros,
      state.totalFeesMicros,
      state.totalSpreadCostMicros,
      state.totalSlippageCostMicros,
      state.totalCashYieldMicros,
      state.initialCapitalMicros,
    ),
    Result.map((metrics) => ({
      metrics,
      events: Chunk.toReadonlyArray(state.events),
      signalDecisions: Chunk.toReadonlyArray(state.signalDecisions),
      dailyPerformance: Chunk.toReadonlyArray(state.dailyPerformance),
      simulation: recordEvents
        ? {
            schemaVersion: ContractVersion.SimulationTrace,
            executionModel: protocol.executionModel,
            costMultiplierMicros: costMultiplierMicros.toString(),
            orders: Chunk.toReadonlyArray(state.orders),
            cashChanges: Chunk.toReadonlyArray(state.cashChanges),
            dailyMarks: Chunk.toReadonlyArray(state.dailyMarks),
          }
        : null,
    })),
  )

const runSimulation = (
  input: SimulationInput,
  state: SimulationState,
  targets: Readonly<Record<number, SimulationTarget>>,
): Result.Result<SimulationState, SimulationFailure> =>
  input.sessions.slice(input.startIndex).reduce<Result.Result<SimulationState, SimulationFailure>>(
    (result, session, offset) =>
      pipe(
        result,
        Result.flatMap((current) => runSession(current, session, input.startIndex + offset, targets, input)),
      ),
    Result.succeed(state),
  )

export const simulate = (
  sessions: readonly AlignedSession[],
  targets: readonly SimulationTarget[],
  startIndex: number,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
  recordEvents: boolean,
  terminalCloseTarget?: (target: SimulationTarget, executionIndex: number) => SimulationTarget,
): SimulationDecision => {
  if (protocol.executionModel.schemaVersion !== 'bayn.execution-model.v2') {
    return fail({
      _tag: 'UnsupportedSimulationExecutionModel',
      actual: protocol.executionModel.schemaVersion,
      required: 'bayn.execution-model.v2',
    })
  }
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= sessions.length) {
    return fail({ _tag: 'InvalidSimulationRange', startIndex, sessionCount: sessions.length })
  }
  const input = {
    sessions,
    targets,
    terminalCloseTarget,
    startIndex,
    protocol,
    costMultiplierMicros,
    runId,
    recordEvents,
  }
  return pipe(
    Result.all({
      initialCapitalMicros: parseMicros(protocol.initialCapitalMicros, 'initialCapitalMicros'),
      targets: targetSchedule(targets),
    }),
    Result.flatMap(({ initialCapitalMicros, targets: schedule }) =>
      runSimulation(input, initialState(initialCapitalMicros), schedule),
    ),
    Result.flatMap((state) => completeSimulation(state, protocol, costMultiplierMicros, recordEvents)),
  )
}
