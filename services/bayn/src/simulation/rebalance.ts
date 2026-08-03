import { Chunk, pipe, Result } from 'effect'

import {
  calculateSessionFees,
  desiredQuantityMicros,
  makeFillTerms,
  notionalMicros,
  ppm,
  saleCostBasisMicros,
  scaleQuantityMicros,
  type FeeInput,
} from '../execution-model'
import type { DecisionEvent, SimulationProtocol } from '../types'
import {
  appendFillEvidence,
  appendOrder,
  limitOrderFillToBuyingPower,
  makeCashChange,
  makeDecision,
  makeFeeEvent,
  makeFill,
  makeOrder,
  parseMicros,
  recordDecision,
} from './evidence'
import type { AlignedSession, PreparedOrder, SimulationFailure, SimulationInput, SimulationTarget } from './model'
import { requiredRecordValue, requiredSession } from './inputs'
import {
  positionFor,
  updatePosition,
  type Position,
  type RebalanceState,
  type SessionOpeningSnapshot,
  type SimulationState,
  type TradeCandidate,
} from './state'
import { positionValueMicros, referencePricesFor } from './valuation'

const fail = <A = never>(failure: SimulationFailure): Result.Result<A, SimulationFailure> => Result.fail(failure)

const desiredQuantitiesFor = (
  planningEquityMicros: bigint,
  weights: Readonly<Record<string, number>>,
  prices: Readonly<Record<string, bigint>>,
  protocol: SimulationProtocol,
): Result.Result<Readonly<Record<string, bigint>>, SimulationFailure> =>
  pipe(
    Result.all(
      Object.entries(weights).map(([symbol, weight]) =>
        pipe(
          requiredRecordValue(prices, symbol, 'price', 'planning prices'),
          Result.flatMap((price) =>
            desiredQuantityMicros(planningEquityMicros, weight, price, protocol.executionModel),
          ),
          Result.map((quantityMicros) => [symbol, quantityMicros] as const),
        ),
      ),
    ),
    Result.map((entries) => Object.fromEntries(entries)),
  )

const scaledBuyFeeInputs = (
  buys: readonly TradeCandidate[],
  scalePpm: bigint,
  prices: Readonly<Record<string, bigint>>,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  minimumNotionalMicros?: bigint,
): Result.Result<readonly FeeInput[], SimulationFailure> =>
  buys.reduce<Result.Result<readonly FeeInput[], SimulationFailure>>(
    (result, buy) =>
      pipe(
        result,
        Result.flatMap((inputs) =>
          pipe(
            Result.all({
              price: requiredRecordValue(prices, buy.symbol, 'price', 'buy fee inputs'),
              quantity: scaleQuantityMicros(buy.quantityMicros, scalePpm, protocol.executionModel),
            }),
            Result.flatMap(({ price, quantity }) => {
              if (quantity === 0n) return Result.succeed(inputs)
              return pipe(
                notionalMicros(quantity, price),
                Result.flatMap((referenceNotionalMicros) => {
                  if (minimumNotionalMicros !== undefined && referenceNotionalMicros < minimumNotionalMicros) {
                    return Result.succeed(inputs)
                  }
                  return pipe(
                    makeFillTerms('buy', quantity, price, protocol.executionModel, costMultiplierMicros),
                    Result.map((terms) => [
                      ...inputs,
                      { side: 'buy' as const, quantityMicros: quantity, notionalMicros: terms.notionalMicros },
                    ]),
                  )
                }),
              )
            }),
          ),
        ),
      ),
    Result.succeed([]),
  )

const buysAffordable = (
  buys: readonly TradeCandidate[],
  scalePpm: bigint,
  prices: Readonly<Record<string, bigint>>,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  availableCashMicros: bigint,
  minimumNotionalMicros?: bigint,
): Result.Result<boolean, SimulationFailure> =>
  pipe(
    scaledBuyFeeInputs(buys, scalePpm, prices, protocol, costMultiplierMicros, minimumNotionalMicros),
    Result.flatMap((inputs) =>
      pipe(
        calculateSessionFees(inputs, protocol.executionModel, costMultiplierMicros),
        Result.map(
          (fees) =>
            inputs.reduce((sum, fill) => sum + fill.notionalMicros, 0n) + fees.totalMicros <= availableCashMicros,
        ),
      ),
    ),
  )

const maximumAffordableScale = (
  minimum: bigint,
  maximum: bigint,
  affordable: (candidate: bigint) => Result.Result<boolean, SimulationFailure>,
): Result.Result<bigint, SimulationFailure> => {
  if (minimum >= maximum) return Result.succeed(minimum)
  const candidate = (minimum + maximum + 1n) / 2n
  return pipe(
    affordable(candidate),
    Result.flatMap((accepted) =>
      accepted
        ? maximumAffordableScale(candidate, maximum, affordable)
        : maximumAffordableScale(minimum, candidate - 1n, affordable),
    ),
  )
}

const proposedTrades = (
  positions: Readonly<Record<string, Position>>,
  weights: Readonly<Record<string, number>>,
  desiredQuantities: Readonly<Record<string, bigint>>,
): Result.Result<
  { readonly sells: readonly TradeCandidate[]; readonly buys: readonly TradeCandidate[] },
  SimulationFailure
> =>
  pipe(
    Result.all(
      Object.keys(weights)
        .sort()
        .map((symbol) =>
          pipe(
            requiredRecordValue(desiredQuantities, symbol, 'target-weight', 'desired quantities'),
            Result.flatMap((desired) =>
              pipe(
                positionFor(positions, symbol),
                Result.map((position) => {
                  const current = position.quantityMicros
                  return {
                    symbol,
                    sellQuantityMicros: desired < current ? current - desired : 0n,
                    buyQuantityMicros: desired > current ? desired - current : 0n,
                  }
                }),
              ),
            ),
          ),
        ),
    ),
    Result.map((facts) => ({
      sells: facts
        .filter((fact) => fact.sellQuantityMicros > 0n)
        .map(({ symbol, sellQuantityMicros: quantityMicros }) => ({ symbol, quantityMicros })),
      buys: facts
        .filter((fact) => fact.buyQuantityMicros > 0n)
        .map(({ symbol, buyQuantityMicros: quantityMicros }) => ({ symbol, quantityMicros })),
    })),
  )

const plannedBuyOrders = (
  buys: readonly TradeCandidate[],
  scalePpm: bigint,
  planningPrices: Readonly<Record<string, bigint>>,
  executionPrices: Readonly<Record<string, bigint>>,
  minimumNotionalMicros: bigint,
  decision: DecisionEvent,
  session: AlignedSession,
  input: SimulationInput,
): Result.Result<readonly PreparedOrder[], SimulationFailure> =>
  buys.reduce<Result.Result<readonly PreparedOrder[], SimulationFailure>>(
    (orders, buy) =>
      pipe(
        orders,
        Result.flatMap((planned) =>
          pipe(
            Result.all({
              executionPrice: requiredRecordValue(executionPrices, buy.symbol, 'price', 'execution prices'),
              planningPrice: requiredRecordValue(planningPrices, buy.symbol, 'price', 'planning prices'),
              requestedQuantity: scaleQuantityMicros(buy.quantityMicros, scalePpm, input.protocol.executionModel),
            }),
            Result.flatMap(({ executionPrice, planningPrice, requestedQuantity }) => {
              if (requestedQuantity === 0n) return Result.succeed(planned)
              return pipe(
                notionalMicros(requestedQuantity, planningPrice),
                Result.flatMap((requestedNotional) =>
                  requestedNotional < minimumNotionalMicros
                    ? Result.succeed(planned)
                    : pipe(
                        makeOrder(
                          input.runId,
                          decision,
                          session.date,
                          buy.symbol,
                          'buy',
                          requestedQuantity,
                          executionPrice,
                          input.protocol,
                        ),
                        Result.map((order) => [...planned, order]),
                      ),
                ),
              )
            }),
          ),
        ),
      ),
    Result.succeed([]),
  )

const executionBuyOrders = (
  orders: readonly PreparedOrder[],
  scalePpm: bigint,
  input: SimulationInput,
): Result.Result<readonly PreparedOrder[], SimulationFailure> =>
  Result.all(
    orders.map((order) =>
      pipe(
        scaleQuantityMicros(order.filledQuantityMicros, scalePpm, input.protocol.executionModel),
        Result.flatMap((filledQuantity) => limitOrderFillToBuyingPower(input.runId, order, filledQuantity)),
      ),
    ),
  )

const sellOrder = (
  sell: TradeCandidate,
  executionPrices: Readonly<Record<string, bigint>>,
  decision: DecisionEvent,
  session: AlignedSession,
  input: SimulationInput,
  forceFullFill: boolean,
): Result.Result<PreparedOrder, SimulationFailure> =>
  pipe(
    requiredRecordValue(executionPrices, sell.symbol, 'price', 'execution prices'),
    Result.flatMap((price) =>
      makeOrder(
        input.runId,
        decision,
        session.date,
        sell.symbol,
        'sell',
        sell.quantityMicros,
        price,
        input.protocol,
        forceFullFill,
      ),
    ),
  )

const applySellOrder = (
  rebalance: RebalanceState,
  order: PreparedOrder,
  executionPrices: Readonly<Record<string, bigint>>,
  decision: DecisionEvent,
  input: SimulationInput,
): Result.Result<RebalanceState, SimulationFailure> => {
  const state = appendOrder(rebalance.simulation, order, input.recordEvents)
  if (order.filledQuantityMicros === 0n) return Result.succeed({ ...rebalance, simulation: state })
  return pipe(
    Result.all({
      position: positionFor(state.positions, order.event.symbol),
      price: requiredRecordValue(executionPrices, order.event.symbol, 'price', 'execution prices'),
    }),
    Result.flatMap(({ position, price }) =>
      pipe(
        Result.all({
          costBasis: saleCostBasisMicros(position.costBasisMicros, order.filledQuantityMicros, position.quantityMicros),
          terms: makeFillTerms(
            'sell',
            order.filledQuantityMicros,
            price,
            input.protocol.executionModel,
            input.costMultiplierMicros,
          ),
        }),
        Result.flatMap(({ costBasis, terms }) =>
          pipe(
            makeFill(input.runId, decision, order, terms, costBasis),
            Result.flatMap((fill) => {
              const updated = {
                ...state,
                cashMicros: state.cashMicros + terms.notionalMicros,
                turnoverMicros: state.turnoverMicros + terms.notionalMicros,
                totalSpreadCostMicros: state.totalSpreadCostMicros + terms.spreadCostMicros,
                totalSlippageCostMicros: state.totalSlippageCostMicros + terms.slippageCostMicros,
                positions: updatePosition(state.positions, order.event.symbol, {
                  quantityMicros: position.quantityMicros - order.filledQuantityMicros,
                  costBasisMicros: position.costBasisMicros - costBasis,
                }),
              }
              return pipe(
                appendFillEvidence(updated, fill, terms.notionalMicros, input.runId, input.recordEvents),
                Result.map((simulation) => ({
                  simulation,
                  fills: Chunk.append(rebalance.fills, fill),
                })),
              )
            }),
          ),
        ),
      ),
    ),
  )
}

const applyBuyOrder = (
  rebalance: RebalanceState,
  order: PreparedOrder,
  executionPrices: Readonly<Record<string, bigint>>,
  decision: DecisionEvent,
  input: SimulationInput,
): Result.Result<RebalanceState, SimulationFailure> => {
  const state = appendOrder(rebalance.simulation, order, input.recordEvents)
  if (order.filledQuantityMicros === 0n) return Result.succeed({ ...rebalance, simulation: state })
  return pipe(
    requiredRecordValue(executionPrices, order.event.symbol, 'price', 'execution prices'),
    Result.flatMap((price) =>
      pipe(
        makeFillTerms(
          'buy',
          order.filledQuantityMicros,
          price,
          input.protocol.executionModel,
          input.costMultiplierMicros,
        ),
        Result.flatMap((terms) =>
          pipe(
            makeFill(input.runId, decision, order, terms, terms.notionalMicros),
            Result.flatMap((fill) => {
              return pipe(
                positionFor(state.positions, order.event.symbol),
                Result.flatMap((position) => {
                  const updated = {
                    ...state,
                    cashMicros: state.cashMicros - terms.notionalMicros,
                    turnoverMicros: state.turnoverMicros + terms.notionalMicros,
                    totalSpreadCostMicros: state.totalSpreadCostMicros + terms.spreadCostMicros,
                    totalSlippageCostMicros: state.totalSlippageCostMicros + terms.slippageCostMicros,
                    positions: updatePosition(state.positions, order.event.symbol, {
                      quantityMicros: position.quantityMicros + order.filledQuantityMicros,
                      costBasisMicros: position.costBasisMicros + terms.notionalMicros,
                    }),
                  }
                  return pipe(
                    appendFillEvidence(updated, fill, -terms.notionalMicros, input.runId, input.recordEvents),
                    Result.map((simulation) => ({
                      simulation,
                      fills: Chunk.append(rebalance.fills, fill),
                    })),
                  )
                }),
              )
            }),
          ),
        ),
      ),
    ),
  )
}

const applySessionFees = (
  rebalance: RebalanceState,
  session: AlignedSession,
  input: SimulationInput,
): Result.Result<SimulationState, SimulationFailure> => {
  const feeInputs = Chunk.toReadonlyArray(rebalance.fills).map(
    (fill): FeeInput => ({
      side: fill.event.side,
      quantityMicros: fill.quantityMicros,
      notionalMicros: fill.notionalMicros,
    }),
  )
  return pipe(
    calculateSessionFees(feeInputs, input.protocol.executionModel, input.costMultiplierMicros),
    Result.flatMap((fees) => {
      if (fees.totalMicros === 0n) return Result.succeed(rebalance.simulation)
      const updated = {
        ...rebalance.simulation,
        cashMicros: rebalance.simulation.cashMicros - fees.totalMicros,
        totalFeesMicros: rebalance.simulation.totalFeesMicros + fees.totalMicros,
      }
      if (!input.recordEvents) return Result.succeed(updated)
      return pipe(
        makeFeeEvent(input.runId, session.date, fees),
        Result.flatMap((event) =>
          pipe(
            makeCashChange(input.runId, event, -fees.totalMicros, updated.cashMicros),
            Result.map((cashChange) => ({
              ...updated,
              events: Chunk.append(updated.events, event),
              cashChanges: Chunk.append(updated.cashChanges, cashChange),
            })),
          ),
        ),
      )
    }),
  )
}

interface RebalanceContext {
  readonly recordedState: SimulationState
  readonly session: AlignedSession
  readonly opening: SessionOpeningSnapshot
  readonly input: SimulationInput
  readonly decision: DecisionEvent
  readonly executionPrices: Readonly<Record<string, bigint>>
  readonly planningPrices: Readonly<Record<string, bigint>>
  readonly minimumNotionalMicros: bigint
  readonly terminalClose: boolean
}

interface RebalanceCandidates extends RebalanceContext {
  readonly buys: readonly TradeCandidate[]
  readonly sells: readonly TradeCandidate[]
}

interface RebalanceOrders extends RebalanceContext {
  readonly buyOrders: readonly PreparedOrder[]
  readonly sellOrders: readonly PreparedOrder[]
}

const prepareRebalanceContext = (
  state: SimulationState,
  session: AlignedSession,
  target: SimulationTarget,
  opening: SessionOpeningSnapshot,
  input: SimulationInput,
): Result.Result<RebalanceContext, SimulationFailure> =>
  pipe(
    requiredSession(input.sessions, target.signalIndex, 'planning'),
    Result.flatMap((signalSession) =>
      pipe(
        Result.all({
          decision: makeDecision(input.runId, target, signalSession.date, session.date),
          executionPrices: referencePricesFor(session.bars, input.protocol, (bar) => bar.open),
          minimumNotionalMicros: parseMicros(
            input.protocol.executionModel.precision.minimumBuyNotionalMicros,
            'minimumBuyNotionalMicros',
          ),
          planningPrices: referencePricesFor(signalSession.bars, input.protocol, (bar) => bar.close),
        }),
        Result.flatMap(({ decision, executionPrices, minimumNotionalMicros, planningPrices }) =>
          pipe(
            recordDecision(state, target, decision, input.recordEvents),
            Result.map((recordedState) => ({
              recordedState,
              session,
              opening,
              input,
              decision,
              executionPrices,
              planningPrices,
              minimumNotionalMicros,
              terminalClose: target.terminalClose === true,
            })),
          ),
        ),
      ),
    ),
  )

const deriveRebalanceCandidates = (
  context: RebalanceContext,
  target: SimulationTarget,
): Result.Result<RebalanceCandidates, SimulationFailure> =>
  pipe(
    positionValueMicros(context.planningPrices, context.recordedState.positions),
    Result.flatMap((planningPositionValue) =>
      desiredQuantitiesFor(
        context.opening.planningCashMicros + planningPositionValue,
        target.weights,
        context.planningPrices,
        context.input.protocol,
      ),
    ),
    Result.flatMap((desiredQuantities) =>
      proposedTrades(context.recordedState.positions, target.weights, desiredQuantities),
    ),
    Result.map(({ buys, sells }) => ({ ...context, buys, sells })),
  )

const planRebalanceOrders = (context: RebalanceCandidates): Result.Result<RebalanceOrders, SimulationFailure> =>
  pipe(
    maximumAffordableScale(0n, ppm, (candidate) =>
      buysAffordable(
        context.buys,
        candidate,
        context.planningPrices,
        context.input.protocol,
        context.input.costMultiplierMicros,
        context.opening.planningCashMicros,
        context.minimumNotionalMicros,
      ),
    ),
    Result.flatMap((plannedScale) =>
      Result.all({
        plannedBuys: plannedBuyOrders(
          context.buys,
          plannedScale,
          context.planningPrices,
          context.executionPrices,
          context.minimumNotionalMicros,
          context.decision,
          context.session,
          context.input,
        ),
        sellOrders: Result.all(
          context.sells.map((sell) =>
            sellOrder(
              sell,
              context.executionPrices,
              context.decision,
              context.session,
              context.input,
              context.terminalClose,
            ),
          ),
        ),
      }),
    ),
    Result.flatMap(({ plannedBuys, sellOrders }) => {
      const modeledFills = plannedBuys.map((order) => ({
        symbol: order.event.symbol,
        quantityMicros: order.filledQuantityMicros,
      }))
      return pipe(
        maximumAffordableScale(0n, ppm, (candidate) =>
          buysAffordable(
            modeledFills,
            candidate,
            context.executionPrices,
            context.input.protocol,
            context.input.costMultiplierMicros,
            context.opening.planningCashMicros,
          ),
        ),
        Result.flatMap((executionScale) =>
          pipe(
            executionBuyOrders(plannedBuys, executionScale, context.input),
            Result.map((buyOrders) => ({ ...context, buyOrders, sellOrders })),
          ),
        ),
      )
    }),
  )

const foldOrders = (
  initial: RebalanceState,
  orders: readonly PreparedOrder[],
  apply: (state: RebalanceState, order: PreparedOrder) => Result.Result<RebalanceState, SimulationFailure>,
): Result.Result<RebalanceState, SimulationFailure> =>
  orders.reduce<Result.Result<RebalanceState, SimulationFailure>>(
    (result, order) =>
      pipe(
        result,
        Result.flatMap((state) => apply(state, order)),
      ),
    Result.succeed(initial),
  )

const executeRebalanceOrders = (context: RebalanceOrders): Result.Result<SimulationState, SimulationFailure> => {
  const initial: RebalanceState = {
    simulation: context.recordedState,
    fills: Chunk.empty(),
  }
  return pipe(
    foldOrders(initial, context.sellOrders, (state, order) =>
      applySellOrder(state, order, context.executionPrices, context.decision, context.input),
    ),
    Result.flatMap((afterSells) =>
      foldOrders(afterSells, context.buyOrders, (state, order) =>
        applyBuyOrder(state, order, context.executionPrices, context.decision, context.input),
      ),
    ),
    Result.flatMap((state) => applySessionFees(state, context.session, context.input)),
    Result.flatMap((state) =>
      state.cashMicros < 0n
        ? fail({
            _tag: 'NegativeSimulationCash',
            sessionDate: context.session.date,
            cashMicros: state.cashMicros,
          })
        : Result.succeed(state),
    ),
  )
}

export const rebalanceSession = (
  state: SimulationState,
  session: AlignedSession,
  target: SimulationTarget,
  opening: SessionOpeningSnapshot,
  input: SimulationInput,
): Result.Result<SimulationState, SimulationFailure> =>
  pipe(
    prepareRebalanceContext(state, session, target, opening, input),
    Result.flatMap((context) => deriveRebalanceCandidates(context, target)),
    Result.flatMap(planRebalanceOrders),
    Result.flatMap(executeRebalanceOrders),
  )
