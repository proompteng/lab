import { Chunk, pipe, Result } from 'effect'

import { ContractVersion, type SimulationProtocol } from '../types'
import { accrueSessionCash, parseMicros } from './evidence'
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
      const target = Reflect.get(targets, index) as SimulationTarget | undefined
      return target === undefined ? Result.succeed(accrued) : rebalanceSession(accrued, session, target, opening, input)
    }),
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
