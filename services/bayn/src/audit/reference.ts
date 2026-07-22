import { makeRunIdentity, makeStrategyProtocolHash, type RuntimeProvenance } from '../contracts'
import {
  MICROS,
  accrueCashYield,
  calculateSessionFees,
  desiredQuantityMicros,
  elapsedCalendarDays,
  makeFillTerms,
  makeOrderOutcome,
  microsToNumber,
  notionalMicros,
  ppm,
  referencePriceMicros,
  saleCostBasisMicros,
  scaleQuantityMicros,
  type FeeInput,
  type FillTerms,
} from '../execution-model'
import { canonicalHashV1 } from '../hash'
import type {
  CashChange,
  DailyBar,
  DailyPerformancePoint,
  DailyPositionMark,
  DecisionEvent,
  EconomicVerdict,
  EvaluationEvent,
  FeeEvent,
  FillEvent,
  GateResult,
  InputManifest,
  IsoDate,
  PerformanceMetrics,
  DecisionPlan,
  Protocol,
  SignalDecision,
  SimulatedOrder,
  SimulationProtocol,
  SimulationTrace,
} from '../types'

interface Session {
  readonly date: IsoDate
  readonly bars: Readonly<Record<string, DailyBar>>
}

interface Target {
  readonly signalIndex: number
  readonly executionIndex: number
  readonly weights: Readonly<Record<string, number>>
  readonly plan?: DecisionPlan
}

interface Position {
  quantityMicros: bigint
  costBasisMicros: bigint
}

interface Replay {
  readonly metrics: PerformanceMetrics
  readonly events: readonly EvaluationEvent[]
  readonly decisions: readonly SignalDecision[]
  readonly daily: readonly DailyPerformancePoint[]
  readonly trace: SimulationTrace | null
}

export interface ReferenceEvaluation {
  readonly runId: string
  readonly protocolHash: string
  readonly strategy: Replay
  readonly buyAndHold: Replay
  readonly directVolTiming: Replay
  readonly doubleCostStrategy: Replay
  readonly verdict: EconomicVerdict
}

const tradingDays = 252

const roundWeight = (value: number): number => Number.parseFloat(value.toFixed(12))

const average = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length

const sampleDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0
  const center = average(values)
  const variance = values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

const align = (bars: readonly DailyBar[], manifest: InputManifest, universe: readonly string[]): readonly Session[] => {
  if (bars.length !== manifest.rowCount) throw new Error('reference input row count differs from the manifest')
  const expected = new Set(universe)
  const grouped = new Map<IsoDate, Map<string, DailyBar>>()
  for (const bar of bars) {
    if (!expected.has(bar.symbol)) throw new Error(`reference input has unexpected symbol ${bar.symbol}`)
    const day = grouped.get(bar.sessionDate) ?? new Map<string, DailyBar>()
    if (day.has(bar.symbol)) throw new Error(`reference input duplicates ${bar.symbol} ${bar.sessionDate}`)
    day.set(bar.symbol, bar)
    grouped.set(bar.sessionDate, day)
  }
  const sessions = [...grouped.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, day]): Session => {
      if (day.size !== universe.length || universe.some((symbol) => !day.has(symbol))) {
        throw new Error(`reference input session ${date} is incomplete`)
      }
      const sessionBars = Object.fromEntries(
        universe.map((symbol) => {
          const bar = day.get(symbol)
          if (bar === undefined) throw new Error(`reference input session ${date} is missing ${symbol}`)
          return [symbol, bar]
        }),
      )
      return { date, bars: sessionBars }
    })
  if (
    sessions.length !== manifest.sessionCount ||
    sessions[0]?.date !== manifest.firstSession ||
    sessions.at(-1)?.date !== manifest.lastSession
  ) {
    throw new Error('reference input sessions differ from the manifest')
  }
  return sessions
}

const monthEnds = (dates: readonly IsoDate[]): readonly number[] => {
  const result: number[] = []
  for (let index = 0; index < dates.length - 1; index += 1) {
    if (dates[index].slice(0, 7) !== dates[index + 1].slice(0, 7)) result.push(index)
  }
  return result
}

const riskBalancedHistoryLength = (protocol: Protocol): number =>
  Math.max(protocol.volatilityWindow, ...protocol.horizons)

const allocateCapped = (
  scores: Readonly<Record<string, number>>,
  maximumWeight: number,
): Readonly<Record<string, number>> => {
  const weights: Record<string, number> = Object.fromEntries(
    Object.keys(scores)
      .sort()
      .map((symbol) => [symbol, 0]),
  )
  let unallocated = 1
  let available = Object.keys(scores)
    .filter((symbol) => scores[symbol] > 0)
    .sort()

  while (available.length > 0 && unallocated > 0) {
    const availableScore = available.reduce((total, symbol) => total + scores[symbol], 0)
    if (!Number.isFinite(availableScore) || availableScore <= 0) break
    const exceedsCap = available.filter((symbol) => (unallocated * scores[symbol]) / availableScore > maximumWeight)
    if (exceedsCap.length === 0) {
      for (const symbol of available) weights[symbol] = (unallocated * scores[symbol]) / availableScore
      break
    }
    for (const symbol of exceedsCap) {
      weights[symbol] = maximumWeight
      unallocated = Math.max(0, unallocated - maximumWeight)
    }
    const allocated = new Set(exceedsCap)
    available = available.filter((symbol) => !allocated.has(symbol))
  }

  return weights
}

const weightScale = 1_000_000_000_000

const quantizeCappedWeights = (
  weights: Readonly<Record<string, number>>,
  maximumWeight: number,
): Readonly<Record<string, number>> => {
  const maximumUnits = Math.floor(maximumWeight * weightScale + Number.EPSILON)
  const units: Record<string, number> = Object.fromEntries(
    Object.keys(weights)
      .sort()
      .map((symbol) => {
        const weight = weights[symbol]
        if (!Number.isFinite(weight) || weight < 0) throw new Error(`reference target weight is invalid for ${symbol}`)
        return [symbol, Math.min(maximumUnits, Math.max(0, Math.round(weight * weightScale)))]
      }),
  )
  let total = Object.values(units).reduce((sum, value) => sum + value, 0)
  let excess = Math.max(0, total - weightScale)
  for (const symbol of Object.keys(units).sort().reverse()) {
    if (excess === 0) break
    const reduction = Math.min(units[symbol], excess)
    units[symbol] -= reduction
    excess -= reduction
    total -= reduction
  }
  if (total > weightScale || excess > 0) throw new Error('reference weights cannot be bounded at full exposure')
  return Object.fromEntries(Object.entries(units).map(([symbol, value]) => [symbol, value / weightScale]))
}

const sampleCovariance = (left: readonly number[], right: readonly number[]): number => {
  if (left.length !== right.length || left.length < 2) throw new Error('reference covariance inputs are not aligned')
  const leftAverage = average(left)
  const rightAverage = average(right)
  const value =
    left.reduce((total, observation, index) => total + (observation - leftAverage) * (right[index] - rightAverage), 0) /
    (left.length - 1)
  if (!Number.isFinite(value)) throw new Error('reference covariance is not finite')
  return value
}

const portfolioVolatility = (
  weights: Readonly<Record<string, number>>,
  returns: Readonly<Record<string, readonly number[]>>,
): number => {
  const symbols = Object.keys(weights).sort()
  const dailyVariance = symbols.reduce(
    (outer, left) =>
      outer +
      symbols.reduce(
        (inner, right) => inner + weights[left] * weights[right] * sampleCovariance(returns[left], returns[right]),
        0,
      ),
    0,
  )
  if (!Number.isFinite(dailyVariance) || dailyVariance < -1e-12) {
    throw new Error('reference covariance produced an invalid portfolio variance')
  }
  const annualized = Math.sqrt(Math.max(0, dailyVariance) * tradingDays)
  if (!Number.isFinite(annualized)) throw new Error('reference portfolio volatility is not finite')
  return annualized
}

const riskBalancedDecisionPlan = (
  signalIndex: number,
  sessions: readonly Session[],
  protocol: Protocol,
): DecisionPlan => {
  const requiredHistory = riskBalancedHistoryLength(protocol)
  if (signalIndex < requiredHistory) throw new Error('reference risk-balanced trend has insufficient history')
  const history = sessions.slice(signalIndex - requiredHistory, signalIndex + 1)
  const sessionDates = history.map((session) => session.date)
  const returnsBySymbol: Record<string, readonly number[]> = {}
  const baseSignals = protocol.universe.map((symbol) => {
    const closes = history.map((session) => session.bars[symbol].close)
    if (closes.some((close) => !Number.isFinite(close) || close <= 0)) {
      throw new Error(`reference risk-balanced trend has an invalid close for ${symbol}`)
    }
    const current = closes.at(-1)
    if (current === undefined) throw new Error(`reference risk-balanced trend has no current close for ${symbol}`)
    const volatilityCloses = closes.slice(-(protocol.volatilityWindow + 1))
    const recentReturns = volatilityCloses.slice(1).map((close, index) => close / volatilityCloses[index] - 1)
    if (recentReturns.some((value) => !Number.isFinite(value))) {
      throw new Error(`reference risk-balanced trend has an invalid return for ${symbol}`)
    }
    returnsBySymbol[symbol] = recentReturns
    const dailyVolatility = sampleDeviation(recentReturns)
    const annualizedVolatility = dailyVolatility * Math.sqrt(tradingDays)
    const horizons = protocol.horizons.map((horizonSessions) => {
      const prior = closes[closes.length - 1 - horizonSessions]
      if (prior === undefined) throw new Error(`reference risk-balanced trend has no prior close for ${symbol}`)
      const value = current / prior - 1
      const normalizedTrend = dailyVolatility === 0 ? 0 : value / (dailyVolatility * Math.sqrt(horizonSessions))
      if (![value, normalizedTrend].every(Number.isFinite)) {
        throw new Error(`reference risk-balanced trend has an invalid horizon signal for ${symbol}`)
      }
      return { horizonSessions, return: value, normalizedTrend }
    })
    const compositeScore = dailyVolatility === 0 ? 0 : average(horizons.map((horizon) => horizon.normalizedTrend))
    if (![annualizedVolatility, compositeScore].every(Number.isFinite)) {
      throw new Error(`reference risk-balanced trend has an invalid score for ${symbol}`)
    }
    return {
      symbol,
      horizons,
      dailyVolatility,
      annualizedVolatility,
      compositeScore,
      positiveScore: Math.max(0, compositeScore),
      eligible: dailyVolatility > 0,
    }
  })

  const scores = Object.fromEntries(baseSignals.map((signal) => [signal.symbol, signal.positiveScore]))
  const scoreTotal = Object.values(scores).reduce((total, score) => total + score, 0)
  const uncappedWeights = Object.fromEntries(
    protocol.universe.map((symbol) => [symbol, scoreTotal === 0 ? 0 : scores[symbol] / scoreTotal]),
  )
  const cappedWeights = quantizeCappedWeights(
    allocateCapped(scores, protocol.maximumSymbolWeight),
    protocol.maximumSymbolWeight,
  )
  const estimatedAnnualizedPortfolioVolatility = portfolioVolatility(cappedWeights, returnsBySymbol)
  const exposureScale =
    estimatedAnnualizedPortfolioVolatility === 0
      ? 1
      : Math.min(1, protocol.maximumPortfolioVolatility / estimatedAnnualizedPortfolioVolatility)
  let targetWeights = quantizeCappedWeights(
    Object.fromEntries(protocol.universe.map((symbol) => [symbol, cappedWeights[symbol] * exposureScale])),
    protocol.maximumSymbolWeight,
  )
  const scaledVolatility = portfolioVolatility(targetWeights, returnsBySymbol)
  if (scaledVolatility > protocol.maximumPortfolioVolatility) {
    const correction = protocol.maximumPortfolioVolatility / scaledVolatility
    targetWeights = Object.fromEntries(
      Object.entries(targetWeights).map(([symbol, weight]) => [
        symbol,
        Math.floor(weight * correction * weightScale) / weightScale,
      ]),
    )
  }
  const totalWeight = Object.values(targetWeights).reduce((total, weight) => total + weight, 0)
  if (
    totalWeight > 1 + 1e-12 ||
    Object.values(targetWeights).some(
      (weight) => !Number.isFinite(weight) || weight < 0 || weight > protocol.maximumSymbolWeight + 1e-12,
    ) ||
    portfolioVolatility(targetWeights, returnsBySymbol) > protocol.maximumPortfolioVolatility + 1e-12
  ) {
    throw new Error('reference risk-balanced trend produced weights outside the protocol limits')
  }

  const covarianceDates = sessionDates.slice(-protocol.volatilityWindow)
  return {
    schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
    signalDate: sessions[signalIndex].date,
    covarianceWindow: {
      returnCount: protocol.volatilityWindow,
      firstSession: covarianceDates[0],
      lastSession: covarianceDates.at(-1) ?? sessions[signalIndex].date,
      sessionsHash: canonicalHashV1(covarianceDates),
    },
    estimatedAnnualizedPortfolioVolatility,
    exposureScale,
    targetWeights,
    signals: baseSignals.map((signal) => ({
      ...signal,
      uncappedWeight: roundWeight(uncappedWeights[signal.symbol]),
      cappedWeight: cappedWeights[signal.symbol],
      targetWeight: targetWeights[signal.symbol],
    })),
  }
}

const directVolatilityTarget = (
  sessions: readonly Session[],
  signalIndex: number,
  protocol: SimulationProtocol,
): Readonly<Record<string, number>> => {
  const portfolioReturns: number[] = []
  for (let index = signalIndex - 62; index <= signalIndex; index += 1) {
    const returns = protocol.universe.map(
      (symbol) => sessions[index].bars[symbol].close / sessions[index - 1].bars[symbol].close - 1,
    )
    portfolioReturns.push(average(returns))
  }
  const volatility = sampleDeviation(portfolioReturns) * Math.sqrt(tradingDays)
  const exposure = volatility <= 0 ? 0 : Math.min(1, protocol.directVolatilityTarget / volatility)
  const weight = roundWeight(exposure / protocol.universe.length)
  return Object.fromEntries(protocol.universe.map((symbol) => [symbol, weight]))
}

const metrics = (
  equityMicros: readonly bigint[],
  turnoverMicros: bigint,
  feeMicros: bigint,
  spreadMicros: bigint,
  slippageMicros: bigint,
  yieldMicros: bigint,
  initialMicros: bigint,
): PerformanceMetrics => {
  if (equityMicros.length < 2 || equityMicros.some((value) => value <= 0n)) {
    throw new Error('reference replay produced an invalid equity curve')
  }
  const endingEquityMicros = equityMicros.at(-1)
  if (endingEquityMicros === undefined) throw new Error('reference replay produced an empty equity curve')
  const equity = equityMicros.map(microsToNumber)
  const initial = microsToNumber(initialMicros)
  const endingEquity = microsToNumber(endingEquityMicros)
  const returns = equity.map((value, index) => value / (index === 0 ? initial : equity[index - 1]) - 1)
  const totalReturn = endingEquity / initial - 1
  const annualizedReturn = Math.pow(endingEquity / initial, tradingDays / equity.length) - 1
  const annualizedVolatility = sampleDeviation(returns) * Math.sqrt(tradingDays)
  const sharpe = annualizedVolatility === 0 ? 0 : (average(returns) * tradingDays) / annualizedVolatility
  let peak = initial
  let maximumDrawdown = 0
  for (const value of equity) {
    peak = Math.max(peak, value)
    maximumDrawdown = Math.max(maximumDrawdown, 1 - value / peak)
  }
  return {
    observations: equity.length,
    totalReturn,
    annualizedReturn,
    annualizedVolatility,
    sharpe,
    maximumDrawdown,
    annualTurnover: microsToNumber(turnoverMicros) / initial / (equity.length / tradingDays),
    totalFeesMicros: feeMicros.toString(),
    totalSpreadCostMicros: spreadMicros.toString(),
    totalSlippageCostMicros: slippageMicros.toString(),
    totalCashYieldMicros: yieldMicros.toString(),
    endingEquityMicros: endingEquityMicros.toString(),
  }
}

const order = (
  runId: string,
  decision: DecisionEvent,
  sessionDate: IsoDate,
  symbol: string,
  side: 'buy' | 'sell',
  requestedQuantityMicros: bigint,
  referencePrice: bigint,
  protocol: SimulationProtocol,
): SimulatedOrder => {
  const outcome = makeOrderOutcome({
    identity: {
      schemaVersion: 'bayn.partial-fill-seed.v1',
      signalDate: decision.signalDate,
      executionDate: decision.executionDate,
      symbol,
      side,
    },
    side,
    requestedQuantityMicros,
    referencePriceMicros: referencePrice,
    model: protocol.executionModel,
  })
  const material = {
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
  return { id: canonicalHashV1({ runId, kind: 'order', ...material }), ...material }
}

const fill = (
  runId: string,
  decision: DecisionEvent,
  simulatedOrder: SimulatedOrder,
  terms: FillTerms,
  costBasisMicros: bigint,
): FillEvent => {
  const material = {
    orderId: simulatedOrder.id,
    decisionId: decision.id,
    sessionDate: simulatedOrder.sessionDate,
    symbol: simulatedOrder.symbol,
    side: simulatedOrder.side,
    quantityMicros: simulatedOrder.filledQuantityMicros,
    referencePriceMicros: terms.referencePriceMicros.toString(),
    priceMicros: terms.fillPriceMicros.toString(),
    notionalMicros: terms.notionalMicros.toString(),
    spreadCostMicros: terms.spreadCostMicros.toString(),
    slippageCostMicros: terms.slippageCostMicros.toString(),
    costBasisMicros: costBasisMicros.toString(),
  }
  return { kind: 'fill', id: canonicalHashV1({ runId, kind: 'fill', ...material }), ...material }
}

const cashChange = (
  runId: string,
  source:
    | Pick<FillEvent | FeeEvent, 'kind' | 'id' | 'sessionDate'>
    | { kind: 'cash-yield'; id: string; sessionDate: IsoDate },
  amountMicros: bigint,
  cashAfterMicros: bigint,
): CashChange => {
  const material = {
    sourceKind: source.kind,
    sourceId: source.id,
    sessionDate: source.sessionDate,
    amountMicros: amountMicros.toString(),
    cashAfterMicros: cashAfterMicros.toString(),
  }
  return { id: canonicalHashV1({ runId, kind: 'cash-change', ...material }), ...material }
}

const replay = (
  sessions: readonly Session[],
  targets: readonly Target[],
  startIndex: number,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
  retainTrace: boolean,
): Replay => {
  const targetBySession = new Map(targets.map((target) => [target.executionIndex, target]))
  const positions = new Map<string, Position>()
  const initial = BigInt(protocol.initialCapitalMicros)
  let cash = initial
  let turnover = 0n
  let fees = 0n
  let spread = 0n
  let slippage = 0n
  let cashYield = 0n
  let previousEquity = initial
  let peakEquity = initial
  let previousDate: IsoDate | undefined
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
    const beforeTurnover = turnover
    const beforeFees = fees
    const beforeSpread = spread
    const beforeSlippage = slippage
    const beforeYield = cashYield

    if (previousDate !== undefined) {
      const elapsedDays = elapsedCalendarDays(previousDate, session.date)
      const accrued = accrueCashYield(cash, elapsedDays, protocol.executionModel)
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
          changes.push(cashChange(runId, event, accrued, cash))
        }
      }
    }
    previousDate = session.date

    if (target !== undefined) {
      const decisionMaterial = {
        signalDate: sessions[target.signalIndex].date,
        executionDate: session.date,
        targetWeights: target.weights,
      }
      const decision: DecisionEvent = {
        kind: 'decision',
        id: canonicalHashV1({ runId, kind: 'decision', ...decisionMaterial }),
        ...decisionMaterial,
      }
      if (retainTrace) {
        if (target.plan === undefined) throw new Error('reference candidate target lacks a signal plan')
        events.push(decision)
        decisions.push({ ...target.plan, decisionId: decision.id, executionDate: decision.executionDate })
      }

      const opens = Object.fromEntries(
        protocol.universe.map((symbol) => [
          symbol,
          referencePriceMicros(session.bars[symbol].open, protocol.executionModel),
        ]),
      ) as Readonly<Record<string, bigint>>
      const equityAtOpen =
        cash +
        protocol.universe.reduce(
          (sum, symbol) => sum + notionalMicros(positions.get(symbol)?.quantityMicros ?? 0n, opens[symbol]),
          0n,
        )
      const desired = Object.fromEntries(
        protocol.universe.map((symbol) => [
          symbol,
          desiredQuantityMicros(equityAtOpen, target.weights[symbol], opens[symbol], protocol.executionModel),
        ]),
      ) as Readonly<Record<string, bigint>>
      const sessionFills: FillEvent[] = []

      for (const symbol of [...protocol.universe].sort()) {
        const position = positions.get(symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
        if (desired[symbol] >= position.quantityMicros) continue
        const simulatedOrder = order(
          runId,
          decision,
          session.date,
          symbol,
          'sell',
          position.quantityMicros - desired[symbol],
          opens[symbol],
          protocol,
        )
        if (retainTrace) orders.push(simulatedOrder)
        const quantity = BigInt(simulatedOrder.filledQuantityMicros)
        if (quantity === 0n) continue
        const terms = makeFillTerms('sell', quantity, opens[symbol], protocol.executionModel, costMultiplierMicros)
        const costBasis = saleCostBasisMicros(position.costBasisMicros, quantity, position.quantityMicros)
        const event = fill(runId, decision, simulatedOrder, terms, costBasis)
        cash += terms.notionalMicros
        turnover += terms.notionalMicros
        spread += terms.spreadCostMicros
        slippage += terms.slippageCostMicros
        position.quantityMicros -= quantity
        position.costBasisMicros -= costBasis
        positions.set(symbol, position)
        sessionFills.push(event)
        if (retainTrace) {
          events.push(event)
          changes.push(cashChange(runId, event, terms.notionalMicros, cash))
        }
      }

      const buys = [...protocol.universe]
        .sort()
        .map((symbol) => {
          const position = positions.get(symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
          return {
            symbol,
            position,
            quantityMicros: desired[symbol] > position.quantityMicros ? desired[symbol] - position.quantityMicros : 0n,
            referencePriceMicros: opens[symbol],
          }
        })
        .filter((candidate) => candidate.quantityMicros > 0n)
      const sellFees: FeeInput[] = sessionFills.map((event) => ({
        side: event.side,
        quantityMicros: BigInt(event.quantityMicros),
        notionalMicros: BigInt(event.notionalMicros),
      }))
      const isAffordable = (scale: bigint): boolean => {
        const buyFees: FeeInput[] = []
        for (const candidate of buys) {
          const quantity = scaleQuantityMicros(candidate.quantityMicros, scale, protocol.executionModel)
          if (
            quantity === 0n ||
            notionalMicros(quantity, candidate.referencePriceMicros) <
              BigInt(protocol.executionModel.precision.minimumBuyNotionalMicros)
          ) {
            continue
          }
          const terms = makeFillTerms(
            'buy',
            quantity,
            candidate.referencePriceMicros,
            protocol.executionModel,
            costMultiplierMicros,
          )
          buyFees.push({ side: 'buy', quantityMicros: quantity, notionalMicros: terms.notionalMicros })
        }
        const fee = calculateSessionFees([...sellFees, ...buyFees], protocol.executionModel, costMultiplierMicros)
        return buyFees.reduce((sum, value) => sum + value.notionalMicros, 0n) + fee.totalMicros <= cash
      }
      let minimum = 0n
      let maximum = ppm
      while (minimum < maximum) {
        const candidate = (minimum + maximum + 1n) / 2n
        if (isAffordable(candidate)) minimum = candidate
        else maximum = candidate - 1n
      }

      for (const candidate of buys) {
        const requested = scaleQuantityMicros(candidate.quantityMicros, minimum, protocol.executionModel)
        if (requested === 0n) continue
        const simulatedOrder = order(
          runId,
          decision,
          session.date,
          candidate.symbol,
          'buy',
          requested,
          candidate.referencePriceMicros,
          protocol,
        )
        if (retainTrace) orders.push(simulatedOrder)
        const quantity = BigInt(simulatedOrder.filledQuantityMicros)
        if (quantity === 0n) continue
        const terms = makeFillTerms(
          'buy',
          quantity,
          candidate.referencePriceMicros,
          protocol.executionModel,
          costMultiplierMicros,
        )
        const event = fill(runId, decision, simulatedOrder, terms, terms.notionalMicros)
        cash -= terms.notionalMicros
        turnover += terms.notionalMicros
        spread += terms.spreadCostMicros
        slippage += terms.slippageCostMicros
        candidate.position.quantityMicros += quantity
        candidate.position.costBasisMicros += terms.notionalMicros
        positions.set(candidate.symbol, candidate.position)
        sessionFills.push(event)
        if (retainTrace) {
          events.push(event)
          changes.push(cashChange(runId, event, -terms.notionalMicros, cash))
        }
      }

      const fee = calculateSessionFees(
        sessionFills.map((event) => ({
          side: event.side,
          quantityMicros: BigInt(event.quantityMicros),
          notionalMicros: BigInt(event.notionalMicros),
        })),
        protocol.executionModel,
        costMultiplierMicros,
      )
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
          changes.push(cashChange(runId, event, -fee.totalMicros, cash))
        }
      }
      if (cash < 0n) throw new Error('reference replay spent unavailable cash')
    }

    const closes = Object.fromEntries(
      protocol.universe.map((symbol) => [
        symbol,
        referencePriceMicros(session.bars[symbol].close, protocol.executionModel),
      ]),
    ) as Readonly<Record<string, bigint>>
    const closingEquity =
      cash +
      protocol.universe.reduce(
        (sum, symbol) => sum + notionalMicros(positions.get(symbol)?.quantityMicros ?? 0n, closes[symbol]),
        0n,
      )
    equity.push(closingEquity)
    peakEquity = peakEquity > closingEquity ? peakEquity : closingEquity
    const point: DailyPerformancePoint = {
      sessionDate: session.date,
      equityMicros: closingEquity.toString(),
      netReturn: Number(closingEquity) / Number(previousEquity) - 1,
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
      marks.push({
        ...point,
        cashMicros: cash.toString(),
        positions: [...protocol.universe].sort().map((symbol) => {
          const position = positions.get(symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
          return {
            symbol,
            quantityMicros: position.quantityMicros.toString(),
            costBasisMicros: position.costBasisMicros.toString(),
            priceMicros: closes[symbol].toString(),
            marketValueMicros: notionalMicros(position.quantityMicros, closes[symbol]).toString(),
          }
        }),
      })
    }
    previousEquity = closingEquity
  }

  return {
    metrics: metrics(equity, turnover, fees, spread, slippage, cashYield, initial),
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
  }
}

const verdict = (
  strategy: PerformanceMetrics,
  buyAndHold: PerformanceMetrics,
  directVolTiming: PerformanceMetrics,
  doubleCost: PerformanceMetrics,
  protocol: SimulationProtocol,
): EconomicVerdict => {
  const threshold = protocol.thresholds
  const benchmarkSharpe = Math.max(buyAndHold.sharpe, directVolTiming.sharpe)
  const finite = [
    strategy.annualizedReturn,
    strategy.sharpe,
    strategy.maximumDrawdown,
    strategy.annualTurnover,
    doubleCost.annualizedReturn,
  ].every(Number.isFinite)
  const gates: GateResult[] = [
    { name: 'finite_metrics', passed: finite, actual: finite, required: true },
    {
      name: 'minimum_observations',
      passed: strategy.observations >= threshold.minimumObservations,
      actual: strategy.observations,
      required: threshold.minimumObservations,
    },
    {
      name: 'positive_net_return',
      passed: strategy.annualizedReturn > threshold.minimumAnnualizedReturn,
      actual: strategy.annualizedReturn,
      required: `>${threshold.minimumAnnualizedReturn}`,
    },
    {
      name: 'benchmark_sharpe_improvement',
      passed: strategy.sharpe - benchmarkSharpe > threshold.minimumSharpeImprovement,
      actual: strategy.sharpe - benchmarkSharpe,
      required: `>${threshold.minimumSharpeImprovement}`,
    },
    {
      name: 'maximum_drawdown',
      passed: strategy.maximumDrawdown <= threshold.maximumDrawdown,
      actual: strategy.maximumDrawdown,
      required: `<=${threshold.maximumDrawdown}`,
    },
    {
      name: 'maximum_turnover',
      passed: strategy.annualTurnover <= threshold.maximumAnnualTurnover,
      actual: strategy.annualTurnover,
      required: `<=${threshold.maximumAnnualTurnover}`,
    },
    {
      name: 'double_cost_return',
      passed: !threshold.requirePositiveDoubleCostReturn || doubleCost.annualizedReturn > 0,
      actual: doubleCost.annualizedReturn,
      required: threshold.requirePositiveDoubleCostReturn ? '>0' : 'not-required',
    },
  ]
  return { status: gates.every((gate) => gate.passed) ? 'PASS' : 'FAIL_CLOSED', gates }
}

export const evaluateReference = (
  bars: readonly DailyBar[],
  manifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
): ReferenceEvaluation => {
  const sessions = align(bars, manifest, protocol.universe)
  const dates = sessions.map((session) => session.date)
  const requiredHistory = riskBalancedHistoryLength(protocol)
  const eligibleSignals = monthEnds(dates).filter(
    (index) =>
      index >= requiredHistory &&
      index < dates.length - 1 &&
      dates[index - requiredHistory] >= manifest.bounds.lookbackStart &&
      dates[index + 1] >= manifest.bounds.evaluationStart &&
      dates[index + 1] <= manifest.bounds.evaluationEnd,
  )
  if (eligibleSignals.length === 0) throw new Error('reference dataset has no eligible signal session')
  const startIndex = eligibleSignals[0] + 1
  const firstAfterEnd = dates.findIndex((date) => date > manifest.bounds.evaluationEnd)
  const endExclusive = firstAfterEnd === -1 ? dates.length : firstAfterEnd
  const boundedSessions = sessions.slice(0, endExclusive)
  if (endExclusive - startIndex < protocol.thresholds.minimumObservations) {
    throw new Error('reference dataset has too few evaluation observations')
  }

  const parameterHash = canonicalHashV1(protocol)
  const strategyIdentity = {
    name: provenance.strategy.name,
    behaviorHash: provenance.strategy.behaviorHash,
    parameterHash,
    parameterSchemaVersion: protocol.schemaVersion,
  }
  if (parameterHash !== provenance.strategy.parameterHash || provenance.strategy.name !== 'risk-balanced-trend') {
    throw new Error('reference protocol does not match runtime provenance')
  }
  const runId = makeRunIdentity({
    schemaVersion: 'bayn.run-identity.v1',
    sourceRevision: provenance.sourceRevision,
    image: provenance.image,
    strategy: {
      name: provenance.strategy.name,
      behaviorHash: provenance.strategy.behaviorHash,
      parameters: protocol,
    },
    finalizedSnapshot: manifest.finalizedSnapshot,
    calendarVersion: manifest.finalizedSnapshot.calendarVersion,
    bounds: manifest.bounds,
  }).runId
  const protocolHash = makeStrategyProtocolHash(strategyIdentity)
  const candidateTargets = eligibleSignals.map((signalIndex): Target => {
    const plan = riskBalancedDecisionPlan(signalIndex, sessions, protocol)
    return { signalIndex, executionIndex: signalIndex + 1, weights: plan.targetWeights, plan }
  })
  const equalWeight = roundWeight(1 / protocol.universe.length)
  const buyAndHoldTargets: readonly Target[] = [
    {
      signalIndex: startIndex - 1,
      executionIndex: startIndex,
      weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, equalWeight])),
    },
  ]
  const directVolTargets = eligibleSignals.map(
    (signalIndex): Target => ({
      signalIndex,
      executionIndex: signalIndex + 1,
      weights: directVolatilityTarget(sessions, signalIndex, protocol),
    }),
  )
  const strategy = replay(boundedSessions, candidateTargets, startIndex, protocol, MICROS, runId, true)
  const buyAndHold = replay(boundedSessions, buyAndHoldTargets, startIndex, protocol, MICROS, runId, false)
  const directVolTiming = replay(boundedSessions, directVolTargets, startIndex, protocol, MICROS, runId, false)
  const doubleCostStrategy = replay(
    boundedSessions,
    candidateTargets,
    startIndex,
    protocol,
    BigInt(protocol.executionModel.doubleCostMultiplier) * MICROS,
    runId,
    false,
  )
  return {
    runId,
    protocolHash,
    strategy,
    buyAndHold,
    directVolTiming,
    doubleCostStrategy,
    verdict: verdict(
      strategy.metrics,
      buyAndHold.metrics,
      directVolTiming.metrics,
      doubleCostStrategy.metrics,
      protocol,
    ),
  }
}
