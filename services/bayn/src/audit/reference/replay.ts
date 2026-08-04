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
import { makeReferenceCashYieldEvent, makeReferenceDecisionEvent, makeReferenceFeeEvent } from './replay/identities'
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
} from './replay-calculations'

export { restrictReferenceBuyFill } from './replay-calculations'

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

const hasOpenPosition = (positions: ReadonlyMap<string, Position>): boolean =>
  [...positions.values()].some((position) => position.quantityMicros !== 0n)

const isFlatTarget = (target: Target): boolean => Object.values(target.weights).every((weight) => weight === 0)

export const replay = (
  sessions: readonly Session[],
  targets: readonly Target[],
  startIndex: number,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
  retainTrace: boolean,
  closeAtEnd = false,
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
    const scheduledTarget = targetBySession.get(index)
    const lastTarget = targets.at(-1)
    const beforeTurnover = state.turnoverMicros
    const beforeFees = state.feeMicros
    const beforeSpread = state.spreadMicros
    const beforeSlippage = state.slippageMicros
    const beforeYield = state.cashYieldMicros
    let planningCashSnapshot = state.cashMicros
    let cash = state.cashMicros
    let turnover = state.turnoverMicros
    let fees = state.feeMicros
    let spread = state.spreadMicros
    let slippage = state.slippageMicros
    let cashYield = state.cashYieldMicros
    const allSessionFills: FillEvent[] = []
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
          const eventResult = makeReferenceCashYieldEvent(runId, material)
          if (Result.isFailure(eventResult)) return Result.fail(eventResult.failure)
          const event = eventResult.success
          events.push(event)
          const change = makeCashChange(runId, event, accrued, cash)
          if (Result.isFailure(change)) return Result.fail(change.failure)
          changes.push(change.success)
        }
      }
    }

    const runTarget = (target: Target, execute = true): ReferenceComputation<void> => {
      const terminalClose = target.terminalClose === true
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
        ...('terminalClose' in target && target.terminalClose === true ? { terminalClose: true as const } : {}),
      }
      const decisionResult = makeReferenceDecisionEvent(runId, decisionMaterial)
      if (Result.isFailure(decisionResult)) return Result.fail(decisionResult.failure)
      const decision: DecisionEvent = decisionResult.success
      if (retainTrace) {
        const plan = 'plan' in target ? target.plan : undefined
        if (plan === undefined && !terminalClose && target.requireDecisionEvidence !== false) {
          return Result.fail({
            _tag: 'ReferenceMissingDecisionPlan',
            signalIndex: target.signalIndex,
            executionIndex: target.executionIndex,
          })
        }
        events.push(decision)
        if (plan !== undefined) {
          decisions.push({ ...plan, decisionId: decision.id, executionDate: decision.executionDate })
        }
      }
      if (!execute) return Result.succeed(undefined)

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
      const targetFills: FillEvent[] = []

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
            terminalClose,
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
        const eventResult = makeReferenceFill(runId, decision, simulatedOrder, terms, costBasis)
        if (Result.isFailure(eventResult)) return Result.fail(eventResult.failure)
        const event = eventResult.success
        cash += terms.notionalMicros
        turnover += terms.notionalMicros
        spread += terms.spreadCostMicros
        slippage += terms.slippageCostMicros
        writePosition(simulatedOrder.symbol, {
          quantityMicros: position.quantityMicros - quantity,
          costBasisMicros: position.costBasisMicros - costBasis,
        })
        targetFills.push(event)
        if (retainTrace) {
          events.push(event)
          const change = makeCashChange(runId, event, terms.notionalMicros, cash)
          if (Result.isFailure(change)) return Result.fail(change.failure)
          changes.push(change.success)
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
        const eventResult = makeReferenceFill(runId, decision, simulatedOrder, terms, terms.notionalMicros)
        if (Result.isFailure(eventResult)) return Result.fail(eventResult.failure)
        const event = eventResult.success
        cash -= terms.notionalMicros
        turnover += terms.notionalMicros
        spread += terms.spreadCostMicros
        slippage += terms.slippageCostMicros
        const position = positions.get(simulatedOrder.symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
        writePosition(simulatedOrder.symbol, {
          quantityMicros: position.quantityMicros + quantity,
          costBasisMicros: position.costBasisMicros + terms.notionalMicros,
        })
        targetFills.push(event)
        if (retainTrace) {
          events.push(event)
          const change = makeCashChange(runId, event, -terms.notionalMicros, cash)
          if (Result.isFailure(change)) return Result.fail(change.failure)
          changes.push(change.success)
        }
      }

      const feeResult = calculateSessionFees(
        targetFills.map((event) => ({
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
          const eventResult = makeReferenceFeeEvent(runId, material)
          if (Result.isFailure(eventResult)) return Result.fail(eventResult.failure)
          const event: FeeEvent = eventResult.success
          events.push(event)
          const change = makeCashChange(runId, event, -fee.totalMicros, cash)
          if (Result.isFailure(change)) return Result.fail(change.failure)
          changes.push(change.success)
        }
      }
      if (cash < 0n) {
        return Result.fail({ _tag: 'ReferenceNegativeCash', sessionDate: session.date, cashMicros: cash.toString() })
      }
      allSessionFills.push(...targetFills)
      planningCashSnapshot = cash
      return Result.succeed(undefined)
    }

    const terminalSession = closeAtEnd && index === sessions.length - 1
    const replaceScheduledTarget = terminalSession && scheduledTarget !== undefined && !isFlatTarget(scheduledTarget)
    const terminalTargetFor = (source: Target | undefined): Target => ({
      ...(source ?? {
        signalIndex: Math.max(0, index - 1),
        executionIndex: index,
        weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, 0])),
      }),
      executionIndex: index,
      weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, 0])),
      plan: undefined,
      terminalClose: true,
    })
    const target = replaceScheduledTarget ? terminalTargetFor(scheduledTarget) : scheduledTarget

    if (replaceScheduledTarget && scheduledTarget !== undefined) {
      const scheduledResult = runTarget(scheduledTarget, false)
      if (Result.isFailure(scheduledResult)) return Result.fail(scheduledResult.failure)
    }
    if (target !== undefined) {
      const scheduledResult = runTarget(target)
      if (Result.isFailure(scheduledResult)) return Result.fail(scheduledResult.failure)
    }

    const mustCloseAtEnd = terminalSession && !replaceScheduledTarget && hasOpenPosition(positions)
    const closeSource = scheduledTarget ?? lastTarget
    const terminalTarget =
      mustCloseAtEnd && closeSource !== undefined
        ? {
            ...closeSource,
            executionIndex: index,
            weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, 0])),
            plan: undefined,
            terminalClose: true,
          }
        : mustCloseAtEnd
          ? {
              signalIndex: Math.max(0, index - 1),
              executionIndex: index,
              weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, 0])),
              terminalClose: true,
            }
          : undefined
    if (terminalTarget !== undefined) {
      const terminalResult = runTarget(terminalTarget)
      if (Result.isFailure(terminalResult)) return Result.fail(terminalResult.failure)
    }

    const aggregateFeeResult = calculateSessionFees(
      allSessionFills.map((fill) => ({
        side: fill.side,
        quantityMicros: BigInt(fill.quantityMicros),
        notionalMicros: BigInt(fill.notionalMicros),
      })),
      protocol.executionModel,
      costMultiplierMicros,
    )
    if (Result.isFailure(aggregateFeeResult)) return Result.fail(aggregateFeeResult.failure)
    const aggregateFee = aggregateFeeResult.success
    if (!retainTrace && allSessionFills.length > 0) {
      const charged = fees - beforeFees
      cash += charged - aggregateFee.totalMicros
      fees += aggregateFee.totalMicros - charged
    }

    if (retainTrace) {
      const sessionFees = events.filter(
        (event): event is FeeEvent => event.kind === 'fee' && event.sessionDate === session.date,
      )
      if (sessionFees.length >= 2) {
        const feeIds = new Set(sessionFees.map((fee) => fee.id))
        const charged = sessionFees.reduce(
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
        const adjustedChangesResult = Result.all(
          changes
            .filter((change) => change.sourceKind !== 'fee' || !feeIds.has(change.sourceId))
            .map((change) => {
              if (change.sourceKind !== 'fill') return Result.succeed(change)
              const source = events.find(
                (event): event is FillEvent => event.kind === 'fill' && event.id === change.sourceId,
              )
              const sourceIndex = eventIndexById.get(change.sourceId)
              if (source === undefined || sourceIndex === undefined) return Result.succeed(change)
              const removedBefore = sessionFees
                .filter((fee) => (eventIndexById.get(fee.id) ?? Number.MAX_SAFE_INTEGER) < sourceIndex)
                .reduce((total, fee) => total + BigInt(fee.totalMicros), 0n)
              return removedBefore === 0n
                ? Result.succeed(change)
                : makeCashChange(
                    runId,
                    source,
                    BigInt(change.amountMicros),
                    BigInt(change.cashAfterMicros) + removedBefore,
                  )
            }),
        )
        if (Result.isFailure(adjustedChangesResult)) return Result.fail(adjustedChangesResult.failure)
        cash += charged.totalMicros - aggregateFee.totalMicros
        fees += aggregateFee.totalMicros - charged.totalMicros
        const aggregateResult = makeReferenceFeeEvent(runId, {
          sessionDate: session.date,
          commissionMicros: aggregateFee.commissionMicros.toString(),
          secMicros: aggregateFee.secMicros.toString(),
          tafMicros: aggregateFee.tafMicros.toString(),
          catMicros: aggregateFee.catMicros.toString(),
          totalMicros: aggregateFee.totalMicros.toString(),
        })
        if (Result.isFailure(aggregateResult)) return Result.fail(aggregateResult.failure)
        const aggregate = aggregateResult.success
        const changeResult = makeCashChange(runId, aggregate, -aggregateFee.totalMicros, cash)
        if (Result.isFailure(changeResult)) return Result.fail(changeResult.failure)
        events.splice(
          0,
          events.length,
          ...events.filter((event) => event.kind !== 'fee' || !feeIds.has(event.id)),
          aggregate,
        )
        changes.splice(0, changes.length, ...adjustedChangesResult.success, changeResult.success)
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
