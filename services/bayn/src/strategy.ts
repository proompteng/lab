import { makeRunIdentity, makeStrategyProtocolHash, type RuntimeProvenance } from './contracts'
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
} from './execution-model'
import { canonicalHashV1, hashObject } from './hash'
import { hashTsmomParameters } from './protocol'
import { reconcileMarkedEquity } from './simulation-reconciliation'
import {
  ContractVersion,
  type CashChange,
  type DailyBar,
  type DailyPerformancePoint,
  type DailyPositionMark,
  type DecisionEvent,
  type EconomicVerdict,
  type EvaluationEvent,
  type EvaluationResult,
  type EvaluationSummary,
  type FeeEvent,
  type FillEvent,
  type GateResult,
  type InputManifest,
  type IsoDate,
  type PerformanceMetrics,
  type SimulatedOrder,
  type SimulationProtocol,
  type SimulationTrace,
  type StrategyDecisionPlan,
  type StrategyProtocol,
  type StrategySignalDecision,
  type TsmomDecisionPlan,
  type TsmomEvaluationResult,
  type TsmomProtocol,
} from './types'

export interface AlignedSession {
  readonly date: IsoDate
  readonly bars: Readonly<Record<string, DailyBar>>
}

interface Position {
  quantityMicros: bigint
  costBasisMicros: bigint
}

export interface SimulationTarget {
  readonly signalIndex: number
  readonly executionIndex: number
  readonly weights: Readonly<Record<string, number>>
  readonly decision?: StrategyDecisionPlan
}

export interface SimulationResult {
  readonly metrics: PerformanceMetrics
  readonly events: readonly EvaluationEvent[]
  readonly signalDecisions: readonly StrategySignalDecision[]
  readonly dailyPerformance: readonly DailyPerformancePoint[]
  readonly simulation: SimulationTrace | null
}

export const TRADING_DAYS = 252

const toMicros = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`cannot quantize invalid monetary value: ${value}`)
  return Math.round(value * Number(MICROS)).toString()
}

export const roundWeight = (value: number): number => Number.parseFloat(value.toFixed(12))

export const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length

export const sampleStandardDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0
  const average = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1))
}

export const alignBars = (
  bars: readonly DailyBar[],
  universe: readonly string[],
  inputManifest: InputManifest,
): readonly AlignedSession[] => {
  if (bars.length !== inputManifest.rowCount) throw new Error('strategy input row count does not match manifest')
  const requiredSymbols = new Set(universe)
  const byDate = new Map<IsoDate, Map<string, DailyBar>>()
  for (const bar of bars) {
    if (!requiredSymbols.has(bar.symbol)) throw new Error(`strategy input contains unexpected symbol ${bar.symbol}`)
    const session = byDate.get(bar.sessionDate) ?? new Map<string, DailyBar>()
    if (session.has(bar.symbol)) throw new Error(`strategy input contains duplicate ${bar.symbol} ${bar.sessionDate}`)
    session.set(bar.symbol, bar)
    byDate.set(bar.sessionDate, session)
  }
  const sessions = [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right))
  if (sessions.length !== inputManifest.sessionCount) {
    throw new Error('strategy input session count does not match manifest')
  }
  const aligned = sessions.map(([date, session]) => {
    const actualSymbols = [...session.keys()].sort()
    if (actualSymbols.join(',') !== universe.join(',')) {
      throw new Error(`strategy input session ${date} is incomplete`)
    }
    const sessionBars = Object.fromEntries(
      universe.map((symbol) => {
        const bar = session.get(symbol)
        if (bar === undefined) throw new Error(`strategy input session ${date} is missing ${symbol}`)
        return [symbol, bar]
      }),
    )
    return { date, bars: sessionBars }
  })
  if (aligned[0]?.date !== inputManifest.firstSession || aligned.at(-1)?.date !== inputManifest.lastSession) {
    throw new Error('strategy input bounds do not match manifest')
  }
  return aligned
}

export const isMonthEnd = (sessionDates: readonly IsoDate[], index: number): boolean => {
  const currentMonth = sessionDates[index].slice(0, 7)
  const nextMonth = sessionDates[index + 1]?.slice(0, 7)
  return nextMonth !== undefined && currentMonth !== nextMonth
}

export const makeTsmomDecision = (
  signalDate: IsoDate,
  closes: Readonly<Record<string, readonly number[]>>,
  protocol: TsmomProtocol,
): TsmomDecisionPlan => {
  const maximumLookback = Math.max(...protocol.lookbacks)
  const rawSignals = protocol.universe.map((symbol) => {
    const history = closes[symbol]
    if (history === undefined || history.length !== maximumLookback + 1) {
      throw new Error(`TSMOM decision requires ${maximumLookback + 1} ordered closes for ${symbol}`)
    }
    if (history.some((price) => !Number.isFinite(price) || price <= 0)) {
      throw new Error(`TSMOM decision contains an invalid close for ${symbol}`)
    }
    const current = history.at(-1)
    if (current === undefined) throw new Error(`TSMOM decision has no current close for ${symbol}`)
    const lookbacks = protocol.lookbacks.map((lookbackSessions) => {
      const prior = history[maximumLookback - lookbackSessions]
      if (prior === undefined) throw new Error(`TSMOM decision has no ${lookbackSessions}-session close for ${symbol}`)
      const value = current / prior - 1
      return {
        lookbackSessions,
        return: value,
        direction: value > 0 ? ('positive' as const) : ('non-positive' as const),
      }
    })
    const score = lookbacks.reduce((total, signal) => total + (signal.direction === 'positive' ? 1 : -1), 0)
    return { symbol, lookbacks, score, active: score > 0 }
  })
  const activeCount = rawSignals.filter((signal) => signal.active).length
  const activeWeight = activeCount === 0 ? 0 : roundWeight(1 / activeCount)
  const signals = rawSignals.map((signal) => ({
    ...signal,
    targetWeight: signal.active ? activeWeight : 0,
  }))
  return {
    schemaVersion: ContractVersion.TsmomDecisionPlan,
    signalDate,
    targetWeights: Object.fromEntries(signals.map((signal) => [signal.symbol, signal.targetWeight])),
    signals,
  }
}

export const directVolatilityWeights = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  protocol: SimulationProtocol,
): Readonly<Record<string, number>> => {
  const window = 63
  const equalWeightReturns: number[] = []
  for (let index = signalIndex - window + 1; index <= signalIndex; index += 1) {
    equalWeightReturns.push(
      mean(
        protocol.universe.map(
          (symbol) => sessions[index].bars[symbol].close / sessions[index - 1].bars[symbol].close - 1,
        ),
      ),
    )
  }
  const annualizedVolatility = sampleStandardDeviation(equalWeightReturns) * Math.sqrt(TRADING_DAYS)
  const exposure = annualizedVolatility <= 0 ? 0 : Math.min(1, protocol.directVolatilityTarget / annualizedVolatility)
  const weight = roundWeight(exposure / protocol.universe.length)
  return Object.fromEntries(protocol.universe.map((symbol) => [symbol, weight]))
}

export const calculatePerformanceMetrics = (
  equity: readonly number[],
  turnover: number,
  totalFees: number,
  initialCapital: number,
): PerformanceMetrics => {
  if (equity.length < 2 || equity.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('evaluation produced an invalid equity curve')
  }
  const endingEquity = equity.at(-1)
  if (endingEquity === undefined) throw new Error('evaluation produced an empty equity curve')
  const returns = [equity[0] / initialCapital - 1, ...equity.slice(1).map((value, index) => value / equity[index] - 1)]
  const totalReturn = endingEquity / initialCapital - 1
  const annualizedReturn = Math.pow(endingEquity / initialCapital, TRADING_DAYS / equity.length) - 1
  const volatility = sampleStandardDeviation(returns) * Math.sqrt(TRADING_DAYS)
  const sharpe = volatility === 0 ? 0 : (mean(returns) * TRADING_DAYS) / volatility
  let peak = initialCapital
  let maximumDrawdown = 0
  for (const value of equity) {
    peak = Math.max(peak, value)
    maximumDrawdown = Math.max(maximumDrawdown, 1 - value / peak)
  }
  const years = equity.length / TRADING_DAYS
  return {
    observations: equity.length,
    totalReturn,
    annualizedReturn,
    annualizedVolatility: volatility,
    sharpe,
    maximumDrawdown,
    annualTurnover: turnover / initialCapital / years,
    totalFeesMicros: toMicros(totalFees),
    totalSpreadCostMicros: '0',
    totalSlippageCostMicros: '0',
    totalCashYieldMicros: '0',
    endingEquityMicros: toMicros(endingEquity),
  }
}

const calculateExactPerformanceMetrics = (
  equityMicros: readonly bigint[],
  turnoverMicros: bigint,
  totalFeesMicros: bigint,
  totalSpreadCostMicros: bigint,
  totalSlippageCostMicros: bigint,
  totalCashYieldMicros: bigint,
  initialCapitalMicros: bigint,
): PerformanceMetrics => {
  const equity = equityMicros.map(microsToNumber)
  const initialCapital = microsToNumber(initialCapitalMicros)
  const metrics = calculatePerformanceMetrics(
    equity,
    microsToNumber(turnoverMicros),
    microsToNumber(totalFeesMicros),
    initialCapital,
  )
  const endingEquity = equityMicros.at(-1)
  if (endingEquity === undefined) throw new Error('evaluation produced an empty exact equity curve')
  return {
    ...metrics,
    totalFeesMicros: totalFeesMicros.toString(),
    totalSpreadCostMicros: totalSpreadCostMicros.toString(),
    totalSlippageCostMicros: totalSlippageCostMicros.toString(),
    totalCashYieldMicros: totalCashYieldMicros.toString(),
    endingEquityMicros: endingEquity.toString(),
  }
}

const makeOrder = (
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
      schemaVersion: ContractVersion.PartialFillSeed,
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
  return { id: hashObject({ runId, kind: 'order', ...payload }), ...payload }
}

const makeFill = (
  runId: string,
  decision: DecisionEvent,
  order: SimulatedOrder,
  terms: FillTerms,
  costBasisMicros: bigint,
): FillEvent => {
  const payload = {
    orderId: order.id,
    decisionId: decision.id,
    sessionDate: order.sessionDate,
    symbol: order.symbol,
    side: order.side,
    quantityMicros: order.filledQuantityMicros,
    referencePriceMicros: terms.referencePriceMicros.toString(),
    priceMicros: terms.fillPriceMicros.toString(),
    notionalMicros: terms.notionalMicros.toString(),
    spreadCostMicros: terms.spreadCostMicros.toString(),
    slippageCostMicros: terms.slippageCostMicros.toString(),
    costBasisMicros: costBasisMicros.toString(),
  }
  return { kind: 'fill', id: hashObject({ runId, kind: 'fill', ...payload }), ...payload }
}

const makeCashChange = (
  runId: string,
  source:
    | Pick<FillEvent | FeeEvent, 'kind' | 'id' | 'sessionDate'>
    | { kind: 'cash-yield'; id: string; sessionDate: IsoDate },
  amountMicros: bigint,
  cashAfterMicros: bigint,
): CashChange => {
  const payload = {
    sourceKind: source.kind,
    sourceId: source.id,
    sessionDate: source.sessionDate,
    amountMicros: amountMicros.toString(),
    cashAfterMicros: cashAfterMicros.toString(),
  }
  return { id: hashObject({ runId, kind: 'cash-change', ...payload }), ...payload }
}

const makeFeeEvent = (runId: string, sessionDate: IsoDate, fees: ReturnType<typeof calculateSessionFees>): FeeEvent => {
  const payload = {
    sessionDate,
    commissionMicros: fees.commissionMicros.toString(),
    secMicros: fees.secMicros.toString(),
    tafMicros: fees.tafMicros.toString(),
    catMicros: fees.catMicros.toString(),
    totalMicros: fees.totalMicros.toString(),
  }
  return { kind: 'fee', id: hashObject({ runId, kind: 'fee', ...payload }), ...payload }
}

const makeCashYieldEvent = (
  runId: string,
  sessionDate: IsoDate,
  elapsedDays: number,
  annualYieldBps: number,
  amountMicros: bigint,
) => {
  const payload = { sessionDate, elapsedDays, annualYieldBps, amountMicros: amountMicros.toString() }
  return { kind: 'cash-yield' as const, id: hashObject({ runId, kind: 'cash-yield', ...payload }), ...payload }
}

export const simulate = (
  sessions: readonly AlignedSession[],
  targets: readonly SimulationTarget[],
  startIndex: number,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
  recordEvents: boolean,
): SimulationResult => {
  const targetsByExecution = new Map(targets.map((target) => [target.executionIndex, target]))
  const positions = new Map<string, Position>()
  const initialCapitalMicros = BigInt(protocol.initialCapitalMicros)
  let cashMicros = initialCapitalMicros
  let turnoverMicros = 0n
  let totalFeesMicros = 0n
  let totalSpreadCostMicros = 0n
  let totalSlippageCostMicros = 0n
  let totalCashYieldMicros = 0n
  const equityMicros: bigint[] = []
  const events: EvaluationEvent[] = []
  const signalDecisions: StrategySignalDecision[] = []
  const orders: SimulatedOrder[] = []
  const cashChanges: CashChange[] = []
  const dailyMarks: DailyPositionMark[] = []
  const dailyPerformance: DailyPerformancePoint[] = []
  let previousEquityMicros = initialCapitalMicros
  let peakEquityMicros = initialCapitalMicros
  let previousSessionDate: IsoDate | undefined

  for (let index = startIndex; index < sessions.length; index += 1) {
    const session = sessions[index]
    const target = targetsByExecution.get(index)
    const turnoverBeforeSession = turnoverMicros
    const feesBeforeSession = totalFeesMicros
    const spreadBeforeSession = totalSpreadCostMicros
    const slippageBeforeSession = totalSlippageCostMicros
    const cashYieldBeforeSession = totalCashYieldMicros

    if (previousSessionDate !== undefined) {
      const elapsedDays = elapsedCalendarDays(previousSessionDate, session.date)
      const cashYield = accrueCashYield(cashMicros, elapsedDays, protocol.executionModel)
      if (cashYield > 0n) {
        cashMicros += cashYield
        totalCashYieldMicros += cashYield
        if (recordEvents) {
          const event = makeCashYieldEvent(
            runId,
            session.date,
            elapsedDays,
            protocol.executionModel.cash.annualYieldBps,
            cashYield,
          )
          events.push(event)
          cashChanges.push(makeCashChange(runId, event, cashYield, cashMicros))
        }
      }
    }
    previousSessionDate = session.date

    if (target) {
      const decisionPayload = {
        signalDate: sessions[target.signalIndex].date,
        executionDate: session.date,
        targetWeights: target.weights,
      }
      const decision: DecisionEvent = {
        kind: 'decision',
        id: hashObject({ runId, kind: 'decision', ...decisionPayload }),
        ...decisionPayload,
      }
      if (recordEvents) {
        if (target.decision === undefined) throw new Error('candidate target is missing its strategy decision')
        if (
          target.decision.signalDate !== decision.signalDate ||
          canonicalHashV1(target.decision.targetWeights) !== canonicalHashV1(decision.targetWeights)
        ) {
          throw new Error('strategy decision diverges from its execution target')
        }
        events.push(decision)
        signalDecisions.push({ ...target.decision, decisionId: decision.id, executionDate: decision.executionDate })
      }

      const openPrices = Object.fromEntries(
        Object.entries(session.bars).map(([symbol, bar]) => [
          symbol,
          referencePriceMicros(bar.open, protocol.executionModel),
        ]),
      ) as Readonly<Record<string, bigint>>
      const preTradeEquityMicros =
        cashMicros +
        Object.entries(openPrices).reduce(
          (value, [symbol, price]) => value + notionalMicros(positions.get(symbol)?.quantityMicros ?? 0n, price),
          0n,
        )
      const desiredQuantities = Object.fromEntries(
        Object.entries(target.weights).map(([symbol, weight]) => [
          symbol,
          desiredQuantityMicros(preTradeEquityMicros, weight, openPrices[symbol], protocol.executionModel),
        ]),
      ) as Readonly<Record<string, bigint>>
      const sessionFills: FillEvent[] = []

      for (const symbol of Object.keys(target.weights).sort()) {
        const position = positions.get(symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
        const desired = desiredQuantities[symbol]
        if (desired >= position.quantityMicros) continue
        const order = makeOrder(
          runId,
          decision,
          session.date,
          symbol,
          'sell',
          position.quantityMicros - desired,
          openPrices[symbol],
          protocol,
        )
        if (recordEvents) orders.push(order)
        const filledQuantity = BigInt(order.filledQuantityMicros)
        if (filledQuantity > 0n) {
          const terms = makeFillTerms(
            'sell',
            filledQuantity,
            openPrices[symbol],
            protocol.executionModel,
            costMultiplierMicros,
          )
          const costBasis = saleCostBasisMicros(position.costBasisMicros, filledQuantity, position.quantityMicros)
          const fill = makeFill(runId, decision, order, terms, costBasis)
          cashMicros += terms.notionalMicros
          turnoverMicros += terms.notionalMicros
          totalSpreadCostMicros += terms.spreadCostMicros
          totalSlippageCostMicros += terms.slippageCostMicros
          position.quantityMicros -= filledQuantity
          position.costBasisMicros -= costBasis
          positions.set(symbol, position)
          sessionFills.push(fill)
          if (recordEvents) {
            events.push(fill)
            cashChanges.push(makeCashChange(runId, fill, terms.notionalMicros, cashMicros))
          }
        }
      }

      const proposedBuys = Object.keys(target.weights)
        .sort()
        .map((symbol) => {
          const position = positions.get(symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
          const quantityMicros =
            desiredQuantities[symbol] > position.quantityMicros
              ? desiredQuantities[symbol] - position.quantityMicros
              : 0n
          return { symbol, position, quantityMicros, referencePriceMicros: openPrices[symbol] }
        })
        .filter((buy) => buy.quantityMicros > 0n)

      const sellFeeInputs: FeeInput[] = sessionFills.map((fill) => ({
        side: fill.side,
        quantityMicros: BigInt(fill.quantityMicros),
        notionalMicros: BigInt(fill.notionalMicros),
      }))
      const affordable = (scalePpm: bigint): boolean => {
        const buyInputs = proposedBuys.flatMap((buy): FeeInput[] => {
          const quantity = scaleQuantityMicros(buy.quantityMicros, scalePpm, protocol.executionModel)
          if (
            quantity === 0n ||
            notionalMicros(quantity, buy.referencePriceMicros) <
              BigInt(protocol.executionModel.precision.minimumBuyNotionalMicros)
          ) {
            return []
          }
          const terms = makeFillTerms(
            'buy',
            quantity,
            buy.referencePriceMicros,
            protocol.executionModel,
            costMultiplierMicros,
          )
          return [{ side: 'buy', quantityMicros: quantity, notionalMicros: terms.notionalMicros }]
        })
        const fees = calculateSessionFees(
          [...sellFeeInputs, ...buyInputs],
          protocol.executionModel,
          costMultiplierMicros,
        )
        const buyNotional = buyInputs.reduce((sum, fill) => sum + fill.notionalMicros, 0n)
        return buyNotional + fees.totalMicros <= cashMicros
      }
      let low = 0n
      let high = ppm
      while (low < high) {
        const middle = (low + high + 1n) / 2n
        if (affordable(middle)) low = middle
        else high = middle - 1n
      }

      for (const buy of proposedBuys) {
        const requestedQuantity = scaleQuantityMicros(buy.quantityMicros, low, protocol.executionModel)
        if (requestedQuantity === 0n) continue
        const order = makeOrder(
          runId,
          decision,
          session.date,
          buy.symbol,
          'buy',
          requestedQuantity,
          buy.referencePriceMicros,
          protocol,
        )
        if (recordEvents) orders.push(order)
        const filledQuantity = BigInt(order.filledQuantityMicros)
        if (filledQuantity > 0n) {
          const terms = makeFillTerms(
            'buy',
            filledQuantity,
            buy.referencePriceMicros,
            protocol.executionModel,
            costMultiplierMicros,
          )
          const fill = makeFill(runId, decision, order, terms, terms.notionalMicros)
          cashMicros -= terms.notionalMicros
          turnoverMicros += terms.notionalMicros
          totalSpreadCostMicros += terms.spreadCostMicros
          totalSlippageCostMicros += terms.slippageCostMicros
          buy.position.quantityMicros += filledQuantity
          buy.position.costBasisMicros += terms.notionalMicros
          positions.set(buy.symbol, buy.position)
          sessionFills.push(fill)
          if (recordEvents) {
            events.push(fill)
            cashChanges.push(makeCashChange(runId, fill, -terms.notionalMicros, cashMicros))
          }
        }
      }

      const feeInputs = sessionFills.map((fill) => ({
        side: fill.side,
        quantityMicros: BigInt(fill.quantityMicros),
        notionalMicros: BigInt(fill.notionalMicros),
      }))
      const fees = calculateSessionFees(feeInputs, protocol.executionModel, costMultiplierMicros)
      if (fees.totalMicros > 0n) {
        cashMicros -= fees.totalMicros
        totalFeesMicros += fees.totalMicros
        if (recordEvents) {
          const event = makeFeeEvent(runId, session.date, fees)
          events.push(event)
          cashChanges.push(makeCashChange(runId, event, -fees.totalMicros, cashMicros))
        }
      }
      if (cashMicros < 0n) throw new Error(`simulation spent unavailable cash: ${cashMicros}`)
    }

    const closingPrices = Object.fromEntries(
      Object.entries(session.bars).map(([symbol, bar]) => [
        symbol,
        referencePriceMicros(bar.close, protocol.executionModel),
      ]),
    ) as Readonly<Record<string, bigint>>
    const closingEquityMicros =
      cashMicros +
      Object.entries(closingPrices).reduce(
        (value, [symbol, price]) => value + notionalMicros(positions.get(symbol)?.quantityMicros ?? 0n, price),
        0n,
      )
    equityMicros.push(closingEquityMicros)
    const netReturn = Number(closingEquityMicros) / Number(previousEquityMicros) - 1
    peakEquityMicros = peakEquityMicros > closingEquityMicros ? peakEquityMicros : closingEquityMicros
    const performance = {
      sessionDate: session.date,
      equityMicros: closingEquityMicros.toString(),
      netReturn,
      turnoverMicros: (turnoverMicros - turnoverBeforeSession).toString(),
      cumulativeTurnoverMicros: turnoverMicros.toString(),
      feeMicros: (totalFeesMicros - feesBeforeSession).toString(),
      cumulativeFeesMicros: totalFeesMicros.toString(),
      spreadCostMicros: (totalSpreadCostMicros - spreadBeforeSession).toString(),
      cumulativeSpreadCostMicros: totalSpreadCostMicros.toString(),
      slippageCostMicros: (totalSlippageCostMicros - slippageBeforeSession).toString(),
      cumulativeSlippageCostMicros: totalSlippageCostMicros.toString(),
      cashYieldMicros: (totalCashYieldMicros - cashYieldBeforeSession).toString(),
      cumulativeCashYieldMicros: totalCashYieldMicros.toString(),
      peakEquityMicros: peakEquityMicros.toString(),
      drawdown: 1 - Number(closingEquityMicros) / Number(peakEquityMicros),
    } satisfies DailyPerformancePoint
    dailyPerformance.push(performance)
    if (recordEvents) {
      dailyMarks.push({
        ...performance,
        cashMicros: cashMicros.toString(),
        positions: Object.entries(session.bars)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([symbol]) => {
            const position = positions.get(symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
            const priceMicros = closingPrices[symbol]
            return {
              symbol,
              quantityMicros: position.quantityMicros.toString(),
              costBasisMicros: position.costBasisMicros.toString(),
              priceMicros: priceMicros.toString(),
              marketValueMicros: notionalMicros(position.quantityMicros, priceMicros).toString(),
            }
          }),
      })
    }
    previousEquityMicros = closingEquityMicros
  }

  return {
    metrics: calculateExactPerformanceMetrics(
      equityMicros,
      turnoverMicros,
      totalFeesMicros,
      totalSpreadCostMicros,
      totalSlippageCostMicros,
      totalCashYieldMicros,
      initialCapitalMicros,
    ),
    events,
    signalDecisions,
    dailyPerformance,
    simulation: recordEvents
      ? {
          schemaVersion: ContractVersion.SimulationTrace,
          executionModel: protocol.executionModel,
          costMultiplierMicros: costMultiplierMicros.toString(),
          orders,
          cashChanges,
          dailyMarks,
        }
      : null,
  }
}

export const buildVerdict = (
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

export const makeEvaluationIdentity = (
  inputManifest: InputManifest,
  protocol: StrategyProtocol,
  provenance: RuntimeProvenance,
  expectedStrategyName: string,
  parameterHash: string,
): { readonly runId: string; readonly protocolHash: string } => {
  if (provenance.strategy.name !== expectedStrategyName) {
    throw new Error(`runtime provenance strategy must be ${expectedStrategyName}`)
  }
  if (provenance.strategy.parameterSchemaVersion !== protocol.schemaVersion) {
    throw new Error('runtime provenance parameter schema does not match decoded strategy parameters')
  }
  if (provenance.strategy.parameterHash !== parameterHash) {
    throw new Error('runtime provenance parameter hash does not match decoded strategy parameters')
  }
  const protocolHash = makeStrategyProtocolHash(provenance.strategy)
  const { hash: inputManifestHash, ...inputManifestMaterial } = inputManifest
  if (canonicalHashV1(inputManifestMaterial) !== inputManifestHash) {
    throw new Error('input manifest hash does not match its content')
  }
  const runId = makeRunIdentity({
    schemaVersion: ContractVersion.RunIdentity,
    sourceRevision: provenance.sourceRevision,
    image: provenance.image,
    strategy: {
      name: provenance.strategy.name,
      behaviorHash: provenance.strategy.behaviorHash,
      parameters: protocol,
    },
    finalizedSnapshot: inputManifest.finalizedSnapshot,
    calendarVersion: inputManifest.finalizedSnapshot.calendarVersion,
    bounds: inputManifest.bounds,
  }).runId
  return { runId, protocolHash }
}

export interface EvaluationWindow {
  readonly signalIndices: readonly number[]
  readonly startIndex: number
  readonly evaluationEndExclusive: number
}

export interface TsmomQualificationPrecommit {
  readonly candidateRunId: string
  readonly protocolHash: string
  readonly selectedSessionCount: number
  readonly selectedRebalanceCount: number
  readonly signalDates: readonly IsoDate[]
  readonly executionDates: readonly IsoDate[]
}

export const selectEvaluationWindow = (
  sessionDates: readonly IsoDate[],
  inputManifest: InputManifest,
  requiredHistorySessions: number,
  minimumObservations: number,
): EvaluationWindow => {
  if (
    sessionDates.length !== inputManifest.sessionCount ||
    sessionDates[0] !== inputManifest.firstSession ||
    sessionDates.at(-1) !== inputManifest.lastSession ||
    sessionDates.some((date, index) => index > 0 && date <= sessionDates[index - 1])
  ) {
    throw new Error('qualification calendar does not match the input manifest')
  }
  const signalIndices = sessionDates
    .map((_, index) => index)
    .filter(
      (index) =>
        index >= requiredHistorySessions &&
        index < sessionDates.length - 1 &&
        isMonthEnd(sessionDates, index) &&
        sessionDates[index - requiredHistorySessions] >= inputManifest.bounds.lookbackStart &&
        sessionDates[index + 1] >= inputManifest.bounds.evaluationStart &&
        sessionDates[index + 1] <= inputManifest.bounds.evaluationEnd,
    )
  if (signalIndices.length === 0) {
    throw new Error('dataset has no eligible month-end signal followed by an execution session')
  }
  const startIndex = signalIndices[0] + 1
  const evaluationEndExclusive = sessionDates.findIndex((date) => date > inputManifest.bounds.evaluationEnd)
  const boundedEnd = evaluationEndExclusive === -1 ? sessionDates.length : evaluationEndExclusive
  const selectedSessionCount = boundedEnd - startIndex
  if (selectedSessionCount < minimumObservations) {
    throw new Error(`dataset has ${selectedSessionCount} comparable observations; ${minimumObservations} required`)
  }
  return { signalIndices, startIndex, evaluationEndExclusive: boundedEnd }
}

export const prepareTsmomQualification = (
  sessionDates: readonly IsoDate[],
  inputManifest: InputManifest,
  protocol: TsmomProtocol,
  provenance: RuntimeProvenance,
): TsmomQualificationPrecommit => {
  const { runId, protocolHash } = makeEvaluationIdentity(
    inputManifest,
    protocol,
    provenance,
    'tsmom',
    hashTsmomParameters(protocol),
  )
  const window = selectEvaluationWindow(
    sessionDates,
    inputManifest,
    Math.max(...protocol.lookbacks),
    protocol.thresholds.minimumObservations,
  )
  return {
    candidateRunId: runId,
    protocolHash,
    selectedSessionCount: window.evaluationEndExclusive - window.startIndex,
    selectedRebalanceCount: window.signalIndices.length,
    signalDates: window.signalIndices.map((index) => sessionDates[index]),
    executionDates: window.signalIndices.map((index) => sessionDates[index + 1]),
  }
}

export const evaluateTsmom = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: TsmomProtocol,
  provenance: RuntimeProvenance,
): TsmomEvaluationResult => {
  const { runId, protocolHash } = makeEvaluationIdentity(
    inputManifest,
    protocol,
    provenance,
    'tsmom',
    hashTsmomParameters(protocol),
  )
  const sessions = alignBars(bars, protocol.universe, inputManifest)
  const sessionDates = sessions.map((session) => session.date)
  const window = selectEvaluationWindow(
    sessionDates,
    inputManifest,
    Math.max(...protocol.lookbacks),
    protocol.thresholds.minimumObservations,
  )
  const maximumLookback = Math.max(...protocol.lookbacks)
  const { signalIndices, startIndex } = window
  const evaluationSessions = sessions.slice(0, window.evaluationEndExclusive)

  const strategyTargets: SimulationTarget[] = signalIndices.map((signalIndex) => {
    const closes = Object.fromEntries(
      protocol.universe.map((symbol) => [
        symbol,
        sessions.slice(signalIndex - maximumLookback, signalIndex + 1).map((session) => session.bars[symbol].close),
      ]),
    )
    const decision = makeTsmomDecision(sessions[signalIndex].date, closes, protocol)
    return {
      signalIndex,
      executionIndex: signalIndex + 1,
      weights: decision.targetWeights,
      decision,
    }
  })
  const equalWeight = roundWeight(1 / protocol.universe.length)
  const buyAndHoldTargets: SimulationTarget[] = [
    {
      signalIndex: startIndex - 1,
      executionIndex: startIndex,
      weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, equalWeight])),
    },
  ]
  const directVolTargets: SimulationTarget[] = signalIndices.map((signalIndex) => ({
    signalIndex,
    executionIndex: signalIndex + 1,
    weights: directVolatilityWeights(sessions, signalIndex, protocol),
  }))
  const strategy = simulate(evaluationSessions, strategyTargets, startIndex, protocol, MICROS, runId, true)
  const buyAndHold = simulate(evaluationSessions, buyAndHoldTargets, startIndex, protocol, MICROS, runId, false)
  const directVolTiming = simulate(evaluationSessions, directVolTargets, startIndex, protocol, MICROS, runId, false)
  const doubleCost = simulate(
    evaluationSessions,
    strategyTargets,
    startIndex,
    protocol,
    BigInt(protocol.executionModel.doubleCostMultiplier) * MICROS,
    runId,
    false,
  )
  if (strategy.simulation === null) throw new Error('candidate simulation did not retain its evidence trace')
  const signalDecisions = strategy.signalDecisions.map((decision) => {
    if (decision.schemaVersion !== ContractVersion.TsmomDecisionPlan) {
      throw new Error('TSMOM simulation retained a decision from another strategy')
    }
    return decision
  })
  const markedEquity = reconcileMarkedEquity({
    runId,
    initialCapitalMicros: protocol.initialCapitalMicros,
    evaluatorTotalFeesMicros: strategy.metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: strategy.metrics.endingEquityMicros,
    events: strategy.events,
    simulation: strategy.simulation,
  })

  return {
    schemaVersion: ContractVersion.Evaluation,
    runId,
    codeRevision: provenance.sourceRevision,
    protocolHash,
    initialCapitalMicros: protocol.initialCapitalMicros,
    inputManifest,
    strategy: strategy.metrics,
    buyAndHold: buyAndHold.metrics,
    directVolTiming: directVolTiming.metrics,
    doubleCostStrategy: doubleCost.metrics,
    verdict: buildVerdict(strategy.metrics, buyAndHold.metrics, directVolTiming.metrics, doubleCost.metrics, protocol),
    events: strategy.events,
    signalDecisions,
    simulation: strategy.simulation,
    benchmarkSeries: {
      buyAndHold: buyAndHold.dailyPerformance,
      directVolTiming: directVolTiming.dailyPerformance,
      doubleCostStrategy: doubleCost.dailyPerformance,
    },
    equitySeries: markedEquity.equitySeries,
    markedEquityReconciliation: markedEquity.reconciliation,
  }
}

export const summarizeEvaluation = (evaluation: EvaluationResult): EvaluationSummary => {
  const summary = {
    runId: evaluation.runId,
    codeRevision: evaluation.codeRevision,
    protocolHash: evaluation.protocolHash,
    initialCapitalMicros: evaluation.initialCapitalMicros,
    input: {
      snapshotId: evaluation.inputManifest.finalizedSnapshot.snapshotId,
      publicationId: evaluation.inputManifest.finalizedSnapshot.publicationId,
      manifestHash: evaluation.inputManifest.hash,
      bounds: evaluation.inputManifest.bounds,
      rowCount: evaluation.inputManifest.rowCount,
      sessionCount: evaluation.inputManifest.sessionCount,
      symbols: evaluation.inputManifest.symbols.map((coverage) => coverage.symbol),
    },
    strategy: evaluation.strategy,
    buyAndHold: evaluation.buyAndHold,
    directVolTiming: evaluation.directVolTiming,
    doubleCostStrategy: evaluation.doubleCostStrategy,
    verdict: evaluation.verdict,
    eventCount: evaluation.events.length,
    signalDecisionCount: evaluation.signalDecisions.length,
    orderCount: evaluation.simulation.orders.length,
    cashChangeCount: evaluation.simulation.cashChanges.length,
    dailyMarkCount: evaluation.simulation.dailyMarks.length,
    benchmarkSeriesCounts: {
      buyAndHold: evaluation.benchmarkSeries.buyAndHold.length,
      directVolTiming: evaluation.benchmarkSeries.directVolTiming.length,
      doubleCostStrategy: evaluation.benchmarkSeries.doubleCostStrategy.length,
    },
    markedEquityReconciliation: evaluation.markedEquityReconciliation,
  }
  return evaluation.schemaVersion === ContractVersion.Evaluation
    ? {
        ...summary,
        schemaVersion: ContractVersion.EvaluationSummary,
        evaluationSchemaVersion: ContractVersion.Evaluation,
      }
    : {
        ...summary,
        schemaVersion: ContractVersion.RiskBalancedTrendEvaluationSummary,
        evaluationSchemaVersion: ContractVersion.RiskBalancedTrendEvaluation,
      }
}
