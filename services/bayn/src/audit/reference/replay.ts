import { Result } from 'effect'

import {
  accrueCashYield,
  calculateSessionFees,
  elapsedCalendarDays,
  makeFillTerms,
  notionalMicros,
  ppm,
  saleCostBasisMicros,
  scaleQuantityMicros,
} from '../../execution-model'
import { canonicalHashV1 } from '../../hash'
import type {
  CashChange,
  DailyPerformancePoint,
  DailyPositionMark,
  DecisionEvent,
  EvaluationEvent,
  FeeEvent,
  FillEvent,
  IsoDate,
  SignalDecision,
  SimulatedOrder,
  SimulationProtocol,
} from '../../types'
import type { Position, ReferenceComputation, ReplayWithWork, Session, Target } from './model'
import {
  calculateReplayMetrics,
  makeCashChange,
  makeReferenceFill,
  makeReferenceOrder,
  replayBuysFitCash,
  replayDesiredQuantities,
  replayPositionValue,
  replayPrices,
  restrictReferenceBuyFill,
} from './replay/support'

export { restrictReferenceBuyFill } from './replay/support'

interface ReplayState {
  readonly positions: ReadonlyMap<string, Position>
  readonly cashMicros: bigint
  readonly turnoverMicros: bigint
  readonly feeMicros: bigint
  readonly spreadMicros: bigint
  readonly slippageMicros: bigint
  readonly cashYieldMicros: bigint
  readonly previousEquityMicros: bigint
  readonly peakEquityMicros: bigint
  readonly previousDate?: IsoDate
}

export const replay = (
  sessions: readonly Session[],
  targets: readonly Target[],
  startIndex: number,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
  retainTrace: boolean,
): ReferenceComputation<ReplayWithWork> => {
  if (protocol.executionModel.schemaVersion !== 'bayn.execution-model.v2') {
    return Result.fail({
      _tag: 'UnsupportedReferenceExecutionModel',
      actual: protocol.executionModel.schemaVersion,
      required: 'bayn.execution-model.v2',
    })
  }
  const targetBySession = new Map(targets.map((target) => [target.executionIndex, target]))
  const initial = BigInt(protocol.initialCapitalMicros)
  let state: ReplayState = {
    positions: new Map(),
    cashMicros: initial,
    turnoverMicros: 0n,
    feeMicros: 0n,
    spreadMicros: 0n,
    slippageMicros: 0n,
    cashYieldMicros: 0n,
    previousEquityMicros: initial,
    peakEquityMicros: initial,
  }
  let positionStateCopies = 0
  let positionWrites = 0
  const equity: bigint[] = []
  const events: EvaluationEvent[] = []
  const decisions: SignalDecision[] = []
  const orders: SimulatedOrder[] = []
  const changes: CashChange[] = []
  const marks: DailyPositionMark[] = []
  const daily: DailyPerformancePoint[] = []

  for (let index = startIndex; index < sessions.length; index += 1) {
    const session = sessions[index]
    const target = targetBySession.get(index)
    const beforeTurnover = state.turnoverMicros
    const beforeFees = state.feeMicros
    const beforeSpread = state.spreadMicros
    const beforeSlippage = state.slippageMicros
    const beforeYield = state.cashYieldMicros
    const planningCashSnapshot = state.cashMicros
    let cash = state.cashMicros
    let turnover = state.turnoverMicros
    let fees = state.feeMicros
    let spread = state.spreadMicros
    let slippage = state.slippageMicros
    let cashYield = state.cashYieldMicros
    let positions = state.positions
    let writablePositions: Map<string, Position> | undefined
    const writePosition = (symbol: string, position: Position): void => {
      if (writablePositions === undefined) {
        writablePositions = new Map(positions)
        positionStateCopies += 1
      }
      writablePositions.set(symbol, position)
      positions = writablePositions
      positionWrites += 1
    }

    if (state.previousDate !== undefined) {
      const elapsedDaysResult = elapsedCalendarDays(state.previousDate, session.date)
      if (Result.isFailure(elapsedDaysResult)) return Result.fail(elapsedDaysResult.failure)
      const elapsedDays = elapsedDaysResult.success
      const accruedResult = accrueCashYield(cash, elapsedDays, protocol.executionModel)
      if (Result.isFailure(accruedResult)) return Result.fail(accruedResult.failure)
      const accrued = accruedResult.success
      if (accrued > 0n) {
        cash += accrued
        cashYield += accrued
        if (retainTrace) {
          const material = {
            sessionDate: session.date,
            elapsedDays,
            annualYieldBps: protocol.executionModel.cash.annualYieldBps,
            amountMicros: accrued.toString(),
          }
          const event = {
            kind: 'cash-yield' as const,
            id: canonicalHashV1({ runId, kind: 'cash-yield', ...material }),
            ...material,
          }
          events.push(event)
          changes.push(makeCashChange(runId, event, accrued, cash))
        }
      }
    }

    if (target !== undefined) {
      const signalSession = sessions[target.signalIndex]
      if (signalSession === undefined) {
        return Result.fail({
          _tag: 'ReferenceTargetSignalMissing',
          signalIndex: target.signalIndex,
          executionIndex: target.executionIndex,
          sessionCount: sessions.length,
        })
      }
      const decisionMaterial = {
        signalDate: signalSession.date,
        executionDate: session.date,
        targetWeights: target.weights,
      }
      const decision: DecisionEvent = {
        kind: 'decision',
        id: canonicalHashV1({ runId, kind: 'decision', ...decisionMaterial }),
        ...decisionMaterial,
      }
      if (retainTrace) {
        if (target.plan === undefined) {
          return Result.fail({
            _tag: 'ReferenceMissingDecisionPlan',
            signalIndex: target.signalIndex,
            executionIndex: target.executionIndex,
          })
        }
        events.push(decision)
        decisions.push({ ...target.plan, decisionId: decision.id, executionDate: decision.executionDate })
      }

      const planPricesResult = replayPrices(signalSession, protocol, (bar) => bar.close)
      if (Result.isFailure(planPricesResult)) return Result.fail(planPricesResult.failure)
      const planPrices = planPricesResult.success
      const fillPricesResult = replayPrices(session, protocol, (bar) => bar.open)
      if (Result.isFailure(fillPricesResult)) return Result.fail(fillPricesResult.failure)
      const fillPrices = fillPricesResult.success
      const cashAvailableWhenPlanned = planningCashSnapshot
      const plannedPositionValue = replayPositionValue(planPrices, positions, protocol)
      if (Result.isFailure(plannedPositionValue)) return Result.fail(plannedPositionValue.failure)
      const planEquity = planningCashSnapshot + plannedPositionValue.success
      const desiredResult = replayDesiredQuantities(planEquity, target.weights, planPrices, protocol)
      if (Result.isFailure(desiredResult)) return Result.fail(desiredResult.failure)
      const desired = desiredResult.success
      const sessionFills: FillEvent[] = []

      const sellPlans = [...protocol.universe]
        .sort()
        .map((symbol) => {
          const held = positions.get(symbol)?.quantityMicros ?? 0n
          return { symbol, quantityMicros: desired[symbol] < held ? held - desired[symbol] : 0n }
        })
        .filter((candidate) => candidate.quantityMicros > 0n)
      const buyPlans = [...protocol.universe]
        .sort()
        .map((symbol) => {
          const held = positions.get(symbol)?.quantityMicros ?? 0n
          return { symbol, quantityMicros: desired[symbol] > held ? desired[symbol] - held : 0n }
        })
        .filter((candidate) => candidate.quantityMicros > 0n)
      const minimumBuyNotionalMicros = BigInt(protocol.executionModel.precision.minimumBuyNotionalMicros)
      let acceptedPlanScale = 0n
      let upperPlanScale = ppm
      while (acceptedPlanScale < upperPlanScale) {
        const midpoint = (acceptedPlanScale + upperPlanScale + 1n) / 2n
        const fitsCash = replayBuysFitCash(
          buyPlans,
          midpoint,
          planPrices,
          protocol,
          costMultiplierMicros,
          cashAvailableWhenPlanned,
          minimumBuyNotionalMicros,
        )
        if (Result.isFailure(fitsCash)) return Result.fail(fitsCash.failure)
        if (fitsCash.success) acceptedPlanScale = midpoint
        else upperPlanScale = midpoint - 1n
      }
      const sellOrdersResult = Result.all(
        sellPlans.map((candidate) =>
          makeReferenceOrder(
            runId,
            decision,
            session.date,
            candidate.symbol,
            'sell',
            candidate.quantityMicros,
            fillPrices[candidate.symbol],
            protocol,
          ),
        ),
      )
      if (Result.isFailure(sellOrdersResult)) return Result.fail(sellOrdersResult.failure)
      const sellOrders = sellOrdersResult.success
      const unboundedBuyOrders: SimulatedOrder[] = []
      for (const candidate of buyPlans) {
        const requested = scaleQuantityMicros(candidate.quantityMicros, acceptedPlanScale, protocol.executionModel)
        if (Result.isFailure(requested)) return Result.fail(requested.failure)
        if (requested.success === 0n) continue
        const requestedNotional = notionalMicros(requested.success, planPrices[candidate.symbol])
        if (Result.isFailure(requestedNotional)) return Result.fail(requestedNotional.failure)
        if (requestedNotional.success < minimumBuyNotionalMicros) continue
        const simulatedOrder = makeReferenceOrder(
          runId,
          decision,
          session.date,
          candidate.symbol,
          'buy',
          requested.success,
          fillPrices[candidate.symbol],
          protocol,
        )
        if (Result.isFailure(simulatedOrder)) return Result.fail(simulatedOrder.failure)
        unboundedBuyOrders.push(simulatedOrder.success)
      }
      const unboundedFillCandidates = unboundedBuyOrders.map((candidate) => ({
        symbol: candidate.symbol,
        quantityMicros: BigInt(candidate.filledQuantityMicros),
      }))
      let acceptedFillScale = 0n
      let upperFillScale = ppm
      while (acceptedFillScale < upperFillScale) {
        const midpoint = (acceptedFillScale + upperFillScale + 1n) / 2n
        const fitsCash = replayBuysFitCash(
          unboundedFillCandidates,
          midpoint,
          fillPrices,
          protocol,
          costMultiplierMicros,
          cashAvailableWhenPlanned,
        )
        if (Result.isFailure(fitsCash)) return Result.fail(fitsCash.failure)
        if (fitsCash.success) acceptedFillScale = midpoint
        else upperFillScale = midpoint - 1n
      }
      const buyOrders: SimulatedOrder[] = []
      for (const candidate of unboundedBuyOrders) {
        const permittedQuantity = scaleQuantityMicros(
          BigInt(candidate.filledQuantityMicros),
          acceptedFillScale,
          protocol.executionModel,
        )
        if (Result.isFailure(permittedQuantity)) return Result.fail(permittedQuantity.failure)
        const restricted = restrictReferenceBuyFill(runId, candidate, permittedQuantity.success)
        if (Result.isFailure(restricted)) return Result.fail(restricted.failure)
        buyOrders.push(restricted.success)
      }

      for (const simulatedOrder of sellOrders) {
        if (retainTrace) orders.push(simulatedOrder)
        const position = positions.get(simulatedOrder.symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
        const quantity = BigInt(simulatedOrder.filledQuantityMicros)
        if (quantity === 0n) continue
        const termsResult = makeFillTerms(
          'sell',
          quantity,
          fillPrices[simulatedOrder.symbol],
          protocol.executionModel,
          costMultiplierMicros,
        )
        if (Result.isFailure(termsResult)) return Result.fail(termsResult.failure)
        const terms = termsResult.success
        const costBasisResult = saleCostBasisMicros(position.costBasisMicros, quantity, position.quantityMicros)
        if (Result.isFailure(costBasisResult)) return Result.fail(costBasisResult.failure)
        const costBasis = costBasisResult.success
        const event = makeReferenceFill(runId, decision, simulatedOrder, terms, costBasis)
        cash += terms.notionalMicros
        turnover += terms.notionalMicros
        spread += terms.spreadCostMicros
        slippage += terms.slippageCostMicros
        writePosition(simulatedOrder.symbol, {
          quantityMicros: position.quantityMicros - quantity,
          costBasisMicros: position.costBasisMicros - costBasis,
        })
        sessionFills.push(event)
        if (retainTrace) {
          events.push(event)
          changes.push(makeCashChange(runId, event, terms.notionalMicros, cash))
        }
      }

      for (const simulatedOrder of buyOrders) {
        if (retainTrace) orders.push(simulatedOrder)
        const quantity = BigInt(simulatedOrder.filledQuantityMicros)
        if (quantity === 0n) continue
        const termsResult = makeFillTerms(
          'buy',
          quantity,
          fillPrices[simulatedOrder.symbol],
          protocol.executionModel,
          costMultiplierMicros,
        )
        if (Result.isFailure(termsResult)) return Result.fail(termsResult.failure)
        const terms = termsResult.success
        const event = makeReferenceFill(runId, decision, simulatedOrder, terms, terms.notionalMicros)
        cash -= terms.notionalMicros
        turnover += terms.notionalMicros
        spread += terms.spreadCostMicros
        slippage += terms.slippageCostMicros
        const position = positions.get(simulatedOrder.symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
        writePosition(simulatedOrder.symbol, {
          quantityMicros: position.quantityMicros + quantity,
          costBasisMicros: position.costBasisMicros + terms.notionalMicros,
        })
        sessionFills.push(event)
        if (retainTrace) {
          events.push(event)
          changes.push(makeCashChange(runId, event, -terms.notionalMicros, cash))
        }
      }

      const feeResult = calculateSessionFees(
        sessionFills.map((event) => ({
          side: event.side,
          quantityMicros: BigInt(event.quantityMicros),
          notionalMicros: BigInt(event.notionalMicros),
        })),
        protocol.executionModel,
        costMultiplierMicros,
      )
      if (Result.isFailure(feeResult)) return Result.fail(feeResult.failure)
      const fee = feeResult.success
      if (fee.totalMicros > 0n) {
        cash -= fee.totalMicros
        fees += fee.totalMicros
        if (retainTrace) {
          const material = {
            sessionDate: session.date,
            commissionMicros: fee.commissionMicros.toString(),
            secMicros: fee.secMicros.toString(),
            tafMicros: fee.tafMicros.toString(),
            catMicros: fee.catMicros.toString(),
            totalMicros: fee.totalMicros.toString(),
          }
          const event: FeeEvent = {
            kind: 'fee',
            id: canonicalHashV1({ runId, kind: 'fee', ...material }),
            ...material,
          }
          events.push(event)
          changes.push(makeCashChange(runId, event, -fee.totalMicros, cash))
        }
      }
      if (cash < 0n) {
        return Result.fail({ _tag: 'ReferenceNegativeCash', sessionDate: session.date, cashMicros: cash.toString() })
      }
    }

    const closesResult = replayPrices(session, protocol, (bar) => bar.close)
    if (Result.isFailure(closesResult)) return Result.fail(closesResult.failure)
    const closes = closesResult.success
    const closingPositionValue = replayPositionValue(closes, positions, protocol)
    if (Result.isFailure(closingPositionValue)) return Result.fail(closingPositionValue.failure)
    const closingEquity = cash + closingPositionValue.success
    equity.push(closingEquity)
    const peakEquity = state.peakEquityMicros > closingEquity ? state.peakEquityMicros : closingEquity
    const point: DailyPerformancePoint = {
      sessionDate: session.date,
      equityMicros: closingEquity.toString(),
      netReturn: Number(closingEquity) / Number(state.previousEquityMicros) - 1,
      turnoverMicros: (turnover - beforeTurnover).toString(),
      cumulativeTurnoverMicros: turnover.toString(),
      feeMicros: (fees - beforeFees).toString(),
      cumulativeFeesMicros: fees.toString(),
      spreadCostMicros: (spread - beforeSpread).toString(),
      cumulativeSpreadCostMicros: spread.toString(),
      slippageCostMicros: (slippage - beforeSlippage).toString(),
      cumulativeSlippageCostMicros: slippage.toString(),
      cashYieldMicros: (cashYield - beforeYield).toString(),
      cumulativeCashYieldMicros: cashYield.toString(),
      peakEquityMicros: peakEquity.toString(),
      drawdown: 1 - Number(closingEquity) / Number(peakEquity),
    }
    daily.push(point)
    if (retainTrace) {
      const markedPositions: DailyPositionMark['positions'][number][] = []
      for (const symbol of [...protocol.universe].sort()) {
        const position = positions.get(symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
        const marketValue = notionalMicros(position.quantityMicros, closes[symbol])
        if (Result.isFailure(marketValue)) return Result.fail(marketValue.failure)
        markedPositions.push({
          symbol,
          quantityMicros: position.quantityMicros.toString(),
          costBasisMicros: position.costBasisMicros.toString(),
          priceMicros: closes[symbol].toString(),
          marketValueMicros: marketValue.success.toString(),
        })
      }
      marks.push({ ...point, cashMicros: cash.toString(), positions: markedPositions })
    }
    state = {
      positions,
      cashMicros: cash,
      turnoverMicros: turnover,
      feeMicros: fees,
      spreadMicros: spread,
      slippageMicros: slippage,
      cashYieldMicros: cashYield,
      previousEquityMicros: closingEquity,
      peakEquityMicros: peakEquity,
      previousDate: session.date,
    }
  }

  const metricsResult = calculateReplayMetrics(
    equity,
    state.turnoverMicros,
    state.feeMicros,
    state.spreadMicros,
    state.slippageMicros,
    state.cashYieldMicros,
    initial,
  )
  if (Result.isFailure(metricsResult)) return Result.fail(metricsResult.failure)
  return Result.succeed({
    metrics: metricsResult.success,
    events,
    decisions,
    daily,
    trace: retainTrace
      ? {
          schemaVersion: 'bayn.simulation-trace.v3',
          executionModel: protocol.executionModel,
          costMultiplierMicros: costMultiplierMicros.toString(),
          orders,
          cashChanges: changes,
          dailyMarks: marks,
        }
      : null,
    work: { sessionsProcessed: daily.length, positionStateCopies, positionWrites },
  })
}
