import { Chunk } from 'effect'

import type {
  CashChange,
  DailyPerformancePoint,
  DailyPositionMark,
  EvaluationEvent,
  FillEvent,
  IsoDate,
  SignalDecision,
  SimulatedOrder,
} from '../types'

export interface Position {
  readonly quantityMicros: bigint
  readonly costBasisMicros: bigint
}

export interface PreparedFill {
  readonly event: FillEvent
  readonly quantityMicros: bigint
  readonly notionalMicros: bigint
}

export interface SimulationState {
  readonly initialCapitalMicros: bigint
  readonly cashMicros: bigint
  readonly positions: Readonly<Record<string, Position>>
  readonly turnoverMicros: bigint
  readonly totalFeesMicros: bigint
  readonly totalSpreadCostMicros: bigint
  readonly totalSlippageCostMicros: bigint
  readonly totalCashYieldMicros: bigint
  readonly previousEquityMicros: bigint
  readonly peakEquityMicros: bigint
  readonly previousSessionDate: IsoDate | null
  readonly equityMicros: Chunk.Chunk<bigint>
  readonly events: Chunk.Chunk<EvaluationEvent>
  readonly signalDecisions: Chunk.Chunk<SignalDecision>
  readonly orders: Chunk.Chunk<SimulatedOrder>
  readonly cashChanges: Chunk.Chunk<CashChange>
  readonly dailyMarks: Chunk.Chunk<DailyPositionMark>
  readonly dailyPerformance: Chunk.Chunk<DailyPerformancePoint>
}

export interface SessionOpeningSnapshot {
  readonly planningCashMicros: bigint
  readonly turnoverMicros: bigint
  readonly totalFeesMicros: bigint
  readonly totalSpreadCostMicros: bigint
  readonly totalSlippageCostMicros: bigint
  readonly totalCashYieldMicros: bigint
}

export interface RebalanceState {
  readonly simulation: SimulationState
  readonly fills: Chunk.Chunk<PreparedFill>
}

export interface TradeCandidate {
  readonly symbol: string
  readonly quantityMicros: bigint
}

const zeroPosition: Position = { quantityMicros: 0n, costBasisMicros: 0n }

export const positionFor = (positions: Readonly<Record<string, Position>>, symbol: string): Position =>
  (Reflect.get(positions, symbol) as Position | undefined) ?? zeroPosition

export const updatePosition = (
  positions: Readonly<Record<string, Position>>,
  symbol: string,
  position: Position,
): Readonly<Record<string, Position>> => ({ ...positions, [symbol]: position })

export const initialState = (initialCapitalMicros: bigint): SimulationState => ({
  initialCapitalMicros,
  cashMicros: initialCapitalMicros,
  positions: {},
  turnoverMicros: 0n,
  totalFeesMicros: 0n,
  totalSpreadCostMicros: 0n,
  totalSlippageCostMicros: 0n,
  totalCashYieldMicros: 0n,
  previousEquityMicros: initialCapitalMicros,
  peakEquityMicros: initialCapitalMicros,
  previousSessionDate: null,
  equityMicros: Chunk.empty(),
  events: Chunk.empty(),
  signalDecisions: Chunk.empty(),
  orders: Chunk.empty(),
  cashChanges: Chunk.empty(),
  dailyMarks: Chunk.empty(),
  dailyPerformance: Chunk.empty(),
})
