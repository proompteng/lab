import { Chunk, pipe, Result } from 'effect'

import { notionalMicros, referencePriceMicros } from '../execution-model'
import type { DailyBar, DailyPerformancePoint, DailyPositionMark, SimulationProtocol } from '../types'
import type { AlignedSession, SimulationFailure, SimulationInput } from './model'
import { requiredRecordValue } from './inputs'
import { positionFor, type Position, type SessionOpeningSnapshot, type SimulationState } from './state'

const fail = <A = never>(failure: SimulationFailure): Result.Result<A, SimulationFailure> => Result.fail(failure)

export const referencePricesFor = (
  bars: Readonly<Record<string, DailyBar>>,
  protocol: SimulationProtocol,
  price: (bar: DailyBar) => number,
): Result.Result<Readonly<Record<string, bigint>>, SimulationFailure> =>
  pipe(
    Result.all(
      Object.entries(bars).map(([symbol, bar]) =>
        pipe(
          referencePriceMicros(price(bar), protocol.executionModel),
          Result.map((priceMicros) => [symbol, priceMicros] as const),
        ),
      ),
    ),
    Result.map((entries) => Object.fromEntries(entries)),
  )

export const positionValueMicros = (
  prices: Readonly<Record<string, bigint>>,
  positions: Readonly<Record<string, Position>>,
): Result.Result<bigint, SimulationFailure> =>
  Object.entries(prices).reduce<Result.Result<bigint, SimulationFailure>>(
    (total, [symbol, price]) =>
      pipe(
        total,
        Result.flatMap((value) =>
          pipe(
            notionalMicros(positionFor(positions, symbol).quantityMicros, price),
            Result.map((notional) => value + notional),
          ),
        ),
      ),
    Result.succeed(0n),
  )

const markedPositions = (
  session: AlignedSession,
  positions: Readonly<Record<string, Position>>,
  closingPrices: Readonly<Record<string, bigint>>,
): Result.Result<DailyPositionMark['positions'], SimulationFailure> =>
  Result.all(
    Object.keys(session.bars)
      .sort()
      .map((symbol) => {
        const position = positionFor(positions, symbol)
        return pipe(
          requiredRecordValue(closingPrices, symbol, 'price', 'closing prices'),
          Result.flatMap((priceMicros) =>
            pipe(
              notionalMicros(position.quantityMicros, priceMicros),
              Result.map((marketValueMicros) => ({
                symbol,
                quantityMicros: position.quantityMicros.toString(),
                costBasisMicros: position.costBasisMicros.toString(),
                priceMicros: priceMicros.toString(),
                marketValueMicros: marketValueMicros.toString(),
              })),
            ),
          ),
        )
      }),
  )

export const closeSession = (
  state: SimulationState,
  session: AlignedSession,
  opening: SessionOpeningSnapshot,
  input: SimulationInput,
): Result.Result<SimulationState, SimulationFailure> =>
  pipe(
    referencePricesFor(session.bars, input.protocol, (bar) => bar.close),
    Result.flatMap((closingPrices) =>
      pipe(
        positionValueMicros(closingPrices, state.positions),
        Result.flatMap((closingPositionValue) => {
          const closingEquityMicros = state.cashMicros + closingPositionValue
          const peakEquityMicros =
            state.peakEquityMicros > closingEquityMicros ? state.peakEquityMicros : closingEquityMicros
          const netReturn = Number(closingEquityMicros) / Number(state.previousEquityMicros) - 1
          const drawdown = 1 - Number(closingEquityMicros) / Number(peakEquityMicros)
          if (!Number.isFinite(netReturn) || !Number.isFinite(drawdown)) {
            return fail({
              _tag: 'InvalidPerformanceInput',
              reason: 'invalid-total',
              index: Chunk.size(state.equityMicros),
              value: !Number.isFinite(netReturn) ? netReturn : drawdown,
            })
          }
          const performance = {
            sessionDate: session.date,
            equityMicros: closingEquityMicros.toString(),
            netReturn,
            turnoverMicros: (state.turnoverMicros - opening.turnoverMicros).toString(),
            cumulativeTurnoverMicros: state.turnoverMicros.toString(),
            feeMicros: (state.totalFeesMicros - opening.totalFeesMicros).toString(),
            cumulativeFeesMicros: state.totalFeesMicros.toString(),
            spreadCostMicros: (state.totalSpreadCostMicros - opening.totalSpreadCostMicros).toString(),
            cumulativeSpreadCostMicros: state.totalSpreadCostMicros.toString(),
            slippageCostMicros: (state.totalSlippageCostMicros - opening.totalSlippageCostMicros).toString(),
            cumulativeSlippageCostMicros: state.totalSlippageCostMicros.toString(),
            cashYieldMicros: (state.totalCashYieldMicros - opening.totalCashYieldMicros).toString(),
            cumulativeCashYieldMicros: state.totalCashYieldMicros.toString(),
            peakEquityMicros: peakEquityMicros.toString(),
            drawdown,
          } satisfies DailyPerformancePoint
          const updated = {
            ...state,
            previousEquityMicros: closingEquityMicros,
            peakEquityMicros,
            equityMicros: Chunk.append(state.equityMicros, closingEquityMicros),
            dailyPerformance: Chunk.append(state.dailyPerformance, performance),
          }
          if (!input.recordEvents) return Result.succeed(updated)
          return pipe(
            markedPositions(session, state.positions, closingPrices),
            Result.map((positions) => ({
              ...updated,
              dailyMarks: Chunk.append(updated.dailyMarks, {
                ...performance,
                cashMicros: state.cashMicros.toString(),
                positions,
              }),
            })),
          )
        }),
      ),
    ),
  )
