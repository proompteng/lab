import { makeRunIdentity, makeStrategyProtocolHash, type RuntimeProvenance } from './contracts'
import { canonicalHashV1, hashObject } from './hash'
import { hashTsmomParameters } from './protocol'
import { reconcileMarkedEquity } from './simulation-reconciliation'
import type {
  CashChange,
  DailyBar,
  DailyPerformancePoint,
  DailyPositionMark,
  DecisionEvent,
  EconomicVerdict,
  EvaluationEvent,
  EvaluationResult,
  EvaluationSummary,
  FillEvent,
  GateResult,
  InputManifest,
  IsoDate,
  PerformanceMetrics,
  SimulatedOrder,
  SimulationTrace,
  TsmomDecisionPlan,
  TsmomProtocol,
  TsmomSignalDecision,
} from './types'

interface AlignedSession {
  readonly date: IsoDate
  readonly bars: Readonly<Record<string, DailyBar>>
}

interface Position {
  quantity: number
  costBasis: number
}

interface Target {
  readonly signalIndex: number
  readonly executionIndex: number
  readonly weights: Readonly<Record<string, number>>
  readonly decision?: TsmomDecisionPlan
}

interface SimulationResult {
  readonly metrics: PerformanceMetrics
  readonly events: readonly EvaluationEvent[]
  readonly signalDecisions: readonly TsmomSignalDecision[]
  readonly dailyPerformance: readonly DailyPerformancePoint[]
  readonly simulation: SimulationTrace | null
}

const MICROS = 1_000_000
const TRADING_DAYS = 252

const toMicros = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`cannot quantize invalid monetary value: ${value}`)
  return Math.round(value * MICROS).toString()
}

const roundWeight = (value: number): number => Number.parseFloat(value.toFixed(12))

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length

const sampleStandardDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0
  const average = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1))
}

const alignBars = (
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
    return {
      date,
      bars: Object.fromEntries(universe.map((symbol) => [symbol, session.get(symbol)!])),
    }
  })
  if (aligned[0]?.date !== inputManifest.firstSession || aligned.at(-1)?.date !== inputManifest.lastSession) {
    throw new Error('strategy input bounds do not match manifest')
  }
  return aligned
}

const isMonthEnd = (sessions: readonly AlignedSession[], index: number): boolean => {
  const currentMonth = sessions[index].date.slice(0, 7)
  const nextMonth = sessions[index + 1]?.date.slice(0, 7)
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
    const current = history.at(-1)!
    const lookbacks = protocol.lookbacks.map((lookbackSessions) => {
      const prior = history[maximumLookback - lookbackSessions]
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
    schemaVersion: 'bayn.tsmom-decision-plan.v1',
    signalDate,
    targetWeights: Object.fromEntries(signals.map((signal) => [signal.symbol, signal.targetWeight])),
    signals,
  }
}

const directVolatilityWeights = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  protocol: TsmomProtocol,
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
  const returns = [equity[0] / initialCapital - 1, ...equity.slice(1).map((value, index) => value / equity[index] - 1)]
  const totalReturn = equity.at(-1)! / initialCapital - 1
  const annualizedReturn = Math.pow(equity.at(-1)! / initialCapital, TRADING_DAYS / equity.length) - 1
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
    endingEquityMicros: toMicros(equity.at(-1)!),
  }
}

const makeOrder = (
  runId: string,
  decision: DecisionEvent,
  sessionDate: IsoDate,
  symbol: string,
  side: 'buy' | 'sell',
  requestedQuantity: number,
  filledQuantity: number,
): SimulatedOrder => {
  const payload = {
    decisionId: decision.id,
    sessionDate,
    symbol,
    side,
    requestedQuantityMicros: toMicros(requestedQuantity),
    filledQuantityMicros: toMicros(filledQuantity),
  }
  return { id: hashObject({ runId, kind: 'order', ...payload }), ...payload }
}

const makeFill = (
  runId: string,
  decision: DecisionEvent,
  order: SimulatedOrder,
  price: number,
  fee: number,
  costBasis: number,
): FillEvent => {
  const quantity = Number(BigInt(order.filledQuantityMicros)) / MICROS
  const payload = {
    orderId: order.id,
    decisionId: decision.id,
    sessionDate: order.sessionDate,
    symbol: order.symbol,
    side: order.side,
    quantityMicros: toMicros(quantity),
    priceMicros: toMicros(price),
    notionalMicros: toMicros(quantity * price),
    feeMicros: toMicros(fee),
    costBasisMicros: toMicros(costBasis),
  }
  return { kind: 'fill', id: hashObject({ runId, kind: 'fill', ...payload }), ...payload }
}

const makeCashChange = (runId: string, fill: FillEvent, cashAfterMicros: bigint): CashChange => {
  const notional = BigInt(fill.notionalMicros)
  const fee = BigInt(fill.feeMicros)
  const amount = fill.side === 'buy' ? -(notional + fee) : notional - fee
  const payload = {
    fillId: fill.id,
    sessionDate: fill.sessionDate,
    amountMicros: amount.toString(),
    cashAfterMicros: cashAfterMicros.toString(),
  }
  return { id: hashObject({ runId, kind: 'cash-change', ...payload }), ...payload }
}

const simulate = (
  sessions: readonly AlignedSession[],
  targets: readonly Target[],
  startIndex: number,
  initialCapital: number,
  costBps: number,
  runId: string,
  recordEvents: boolean,
): SimulationResult => {
  const targetsByExecution = new Map(targets.map((target) => [target.executionIndex, target]))
  const positions = new Map<string, Position>()
  let cash = initialCapital
  let turnover = 0
  let totalFees = 0
  const equity: number[] = []
  const events: EvaluationEvent[] = []
  const signalDecisions: TsmomSignalDecision[] = []
  const orders: SimulatedOrder[] = []
  const cashChanges: CashChange[] = []
  const dailyMarks: DailyPositionMark[] = []
  const dailyPerformance: DailyPerformancePoint[] = []
  let reconstructedCashMicros = BigInt(toMicros(initialCapital))
  const feeRate = costBps / 10_000
  let previousEquity = initialCapital
  let peakEquity = initialCapital

  for (let index = startIndex; index < sessions.length; index += 1) {
    const session = sessions[index]
    const target = targetsByExecution.get(index)
    const turnoverBeforeSession = turnover
    const feesBeforeSession = totalFees
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
        if (target.decision === undefined) throw new Error('candidate target is missing its TSMOM signal decision')
        if (
          target.decision.signalDate !== decision.signalDate ||
          canonicalHashV1(target.decision.targetWeights) !== canonicalHashV1(decision.targetWeights)
        ) {
          throw new Error('TSMOM signal decision diverges from its execution target')
        }
        events.push(decision)
        signalDecisions.push({ ...target.decision, decisionId: decision.id, executionDate: decision.executionDate })
      }

      const preTradeEquity =
        cash +
        Object.entries(session.bars).reduce(
          (value, [symbol, bar]) => value + (positions.get(symbol)?.quantity ?? 0) * bar.open,
          0,
        )
      const desiredQuantities = Object.fromEntries(
        Object.entries(target.weights).map(([symbol, weight]) => [
          symbol,
          (preTradeEquity * weight) / session.bars[symbol].open,
        ]),
      )

      for (const symbol of Object.keys(target.weights).sort()) {
        const position = positions.get(symbol) ?? { quantity: 0, costBasis: 0 }
        const desired = desiredQuantities[symbol]
        if (desired >= position.quantity - 1e-9) continue
        const quantity = position.quantity - desired
        const price = session.bars[symbol].open
        const notional = quantity * price
        const fee = notional * feeRate
        const soldFraction = position.quantity === 0 ? 0 : quantity / position.quantity
        const costBasis = position.costBasis * soldFraction
        cash += notional - fee
        turnover += notional
        totalFees += fee
        position.quantity = Math.max(0, desired)
        position.costBasis = Math.max(0, position.costBasis - costBasis)
        positions.set(symbol, position)
        if (recordEvents) {
          const order = makeOrder(runId, decision, session.date, symbol, 'sell', quantity, quantity)
          const fill = makeFill(runId, decision, order, price, fee, costBasis)
          orders.push(order)
          events.push(fill)
          reconstructedCashMicros += BigInt(fill.notionalMicros) - BigInt(fill.feeMicros)
          cashChanges.push(makeCashChange(runId, fill, reconstructedCashMicros))
        }
      }

      const proposedBuys = Object.keys(target.weights)
        .sort()
        .map((symbol) => {
          const position = positions.get(symbol) ?? { quantity: 0, costBasis: 0 }
          const quantity = Math.max(0, desiredQuantities[symbol] - position.quantity)
          return { symbol, position, quantity, price: session.bars[symbol].open }
        })
        .filter((buy) => buy.quantity > 1e-9)
      const proposedNotional = proposedBuys.reduce((sum, buy) => sum + buy.quantity * buy.price, 0)
      const scale = proposedNotional === 0 ? 0 : Math.min(1, cash / (proposedNotional * (1 + feeRate)))
      for (const buy of proposedBuys) {
        const quantity = buy.quantity * scale
        if (quantity <= 1e-9) continue
        const notional = quantity * buy.price
        const fee = notional * feeRate
        cash -= notional + fee
        turnover += notional
        totalFees += fee
        buy.position.quantity += quantity
        buy.position.costBasis += notional
        positions.set(buy.symbol, buy.position)
        if (recordEvents) {
          const order = makeOrder(runId, decision, session.date, buy.symbol, 'buy', buy.quantity, quantity)
          const fill = makeFill(runId, decision, order, buy.price, fee, notional)
          orders.push(order)
          events.push(fill)
          reconstructedCashMicros -= BigInt(fill.notionalMicros) + BigInt(fill.feeMicros)
          cashChanges.push(makeCashChange(runId, fill, reconstructedCashMicros))
        }
      }
      if (cash < -0.01) throw new Error(`simulation spent unavailable cash: ${cash}`)
    }

    const closingEquity =
      cash +
      Object.entries(session.bars).reduce(
        (value, [symbol, bar]) => value + (positions.get(symbol)?.quantity ?? 0) * bar.close,
        0,
      )
    equity.push(closingEquity)
    const netReturn = closingEquity / previousEquity - 1
    peakEquity = Math.max(peakEquity, closingEquity)
    const performance = {
      sessionDate: session.date,
      equityMicros: toMicros(closingEquity),
      netReturn,
      turnoverMicros: toMicros(Math.max(0, turnover - turnoverBeforeSession)),
      cumulativeTurnoverMicros: toMicros(turnover),
      feeMicros: toMicros(Math.max(0, totalFees - feesBeforeSession)),
      cumulativeFeesMicros: toMicros(totalFees),
      peakEquityMicros: toMicros(peakEquity),
      drawdown: 1 - closingEquity / peakEquity,
    } satisfies DailyPerformancePoint
    dailyPerformance.push(performance)
    if (recordEvents) {
      dailyMarks.push({
        ...performance,
        cashMicros: toMicros(Math.max(0, cash)),
        positions: Object.entries(session.bars)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([symbol, bar]) => {
            const position = positions.get(symbol) ?? { quantity: 0, costBasis: 0 }
            return {
              symbol,
              quantityMicros: toMicros(position.quantity),
              costBasisMicros: toMicros(position.costBasis),
              priceMicros: toMicros(bar.close),
              marketValueMicros: toMicros(position.quantity * bar.close),
            }
          }),
      })
    }
    previousEquity = closingEquity
  }

  return {
    metrics: calculatePerformanceMetrics(equity, turnover, totalFees, initialCapital),
    events,
    signalDecisions,
    dailyPerformance,
    simulation: recordEvents
      ? {
          schemaVersion: 'bayn.simulation-trace.v2',
          transactionCostBpsMicros: toMicros(costBps),
          orders,
          cashChanges,
          dailyMarks,
        }
      : null,
  }
}

const buildVerdict = (
  strategy: PerformanceMetrics,
  buyAndHold: PerformanceMetrics,
  directVolTiming: PerformanceMetrics,
  doubleCost: PerformanceMetrics,
  protocol: TsmomProtocol,
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

const makeTsmomEvaluationIdentity = (
  inputManifest: InputManifest,
  protocol: TsmomProtocol,
  provenance: RuntimeProvenance,
): { readonly runId: string; readonly protocolHash: string } => {
  const parameterHash = hashTsmomParameters(protocol)
  if (provenance.strategy.name !== 'tsmom') throw new Error('runtime provenance strategy must be tsmom')
  if (provenance.strategy.parameterSchemaVersion !== protocol.schemaVersion) {
    throw new Error('runtime provenance parameter schema does not match decoded TSMOM parameters')
  }
  if (provenance.strategy.parameterHash !== parameterHash) {
    throw new Error('runtime provenance parameter hash does not match decoded TSMOM parameters')
  }
  const protocolHash = makeStrategyProtocolHash(provenance.strategy)
  const { hash: inputManifestHash, ...inputManifestMaterial } = inputManifest
  if (canonicalHashV1(inputManifestMaterial) !== inputManifestHash) {
    throw new Error('input manifest hash does not match its content')
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
    finalizedSnapshot: inputManifest.finalizedSnapshot,
    calendarVersion: inputManifest.finalizedSnapshot.calendarVersion,
    bounds: inputManifest.bounds,
  }).runId
  return { runId, protocolHash }
}

export const identifyTsmomRun = (
  inputManifest: InputManifest,
  protocol: TsmomProtocol,
  provenance: RuntimeProvenance,
): string => makeTsmomEvaluationIdentity(inputManifest, protocol, provenance).runId

export const evaluateTsmom = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: TsmomProtocol,
  provenance: RuntimeProvenance,
): EvaluationResult => {
  const { runId, protocolHash } = makeTsmomEvaluationIdentity(inputManifest, protocol, provenance)
  const sessions = alignBars(bars, protocol.universe, inputManifest)
  const maximumLookback = Math.max(...protocol.lookbacks)
  const signalIndices = sessions
    .map((_, index) => index)
    .filter(
      (index) =>
        index >= maximumLookback &&
        index < sessions.length - 1 &&
        isMonthEnd(sessions, index) &&
        sessions[index - maximumLookback].date >= inputManifest.bounds.lookbackStart &&
        sessions[index + 1].date >= inputManifest.bounds.evaluationStart &&
        sessions[index + 1].date <= inputManifest.bounds.evaluationEnd,
    )
  if (signalIndices.length === 0)
    throw new Error('dataset has no eligible month-end signal followed by an execution session')
  const startIndex = signalIndices[0] + 1
  const evaluationSessions = sessions.filter((session) => session.date <= inputManifest.bounds.evaluationEnd)
  if (evaluationSessions.length - startIndex < protocol.thresholds.minimumObservations) {
    throw new Error(
      `dataset has ${evaluationSessions.length - startIndex} comparable observations; ${protocol.thresholds.minimumObservations} required`,
    )
  }

  const strategyTargets: Target[] = signalIndices.map((signalIndex) => {
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
  const buyAndHoldTargets: Target[] = [
    {
      signalIndex: startIndex - 1,
      executionIndex: startIndex,
      weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, equalWeight])),
    },
  ]
  const directVolTargets: Target[] = signalIndices.map((signalIndex) => ({
    signalIndex,
    executionIndex: signalIndex + 1,
    weights: directVolatilityWeights(sessions, signalIndex, protocol),
  }))
  const initialCapital = Number(BigInt(protocol.initialCapitalMicros)) / MICROS

  const strategy = simulate(
    evaluationSessions,
    strategyTargets,
    startIndex,
    initialCapital,
    protocol.transactionCostBps,
    runId,
    true,
  )
  const buyAndHold = simulate(
    evaluationSessions,
    buyAndHoldTargets,
    startIndex,
    initialCapital,
    protocol.transactionCostBps,
    runId,
    false,
  )
  const directVolTiming = simulate(
    evaluationSessions,
    directVolTargets,
    startIndex,
    initialCapital,
    protocol.transactionCostBps,
    runId,
    false,
  )
  const doubleCost = simulate(
    evaluationSessions,
    strategyTargets,
    startIndex,
    initialCapital,
    protocol.transactionCostBps * 2,
    runId,
    false,
  )
  if (strategy.simulation === null) throw new Error('candidate simulation did not retain its evidence trace')
  const markedEquity = reconcileMarkedEquity({
    runId,
    initialCapitalMicros: protocol.initialCapitalMicros,
    evaluatorTotalFeesMicros: strategy.metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: strategy.metrics.endingEquityMicros,
    events: strategy.events,
    simulation: strategy.simulation,
  })

  return {
    schemaVersion: 'bayn.evaluation.v3',
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
    signalDecisions: strategy.signalDecisions,
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

export const summarizeEvaluation = (evaluation: EvaluationResult): EvaluationSummary => ({
  schemaVersion: 'bayn.evaluation-summary.v2',
  runId: evaluation.runId,
  evaluationSchemaVersion: evaluation.schemaVersion,
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
})
