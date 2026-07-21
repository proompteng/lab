import type {
  CashChange,
  DailyPositionMark,
  DecisionEvent,
  EquityPoint,
  EvaluationEvent,
  FillEvent,
  MarkedEquityReconciliation,
  SimulatedOrder,
  SimulationTrace,
} from './types'
import { hashObject } from './hash'

const MICROS = 1_000_000n
const BASIS_POINTS = 10_000n
export const MARKED_EQUITY_TOLERANCE_MICROS = 10_000n
const POSITION_QUANTITY_TOLERANCE_MICROS = 100n

const ensure = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

const unsigned = (value: string, name: string): bigint => {
  ensure(/^\d+$/.test(value), `${name} must be an unsigned integer string`)
  return BigInt(value)
}

const signed = (value: string, name: string): bigint => {
  ensure(/^-?\d+$/.test(value), `${name} must be an integer string`)
  return BigInt(value)
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value)

const roundedMicrosProduct = (quantityMicros: bigint, priceMicros: bigint): bigint =>
  (quantityMicros * priceMicros + MICROS / 2n) / MICROS

const roundedFee = (notionalMicros: bigint, transactionCostBpsMicros: bigint): bigint => {
  const denominator = BASIS_POINTS * MICROS
  return (notionalMicros * transactionCostBpsMicros + denominator / 2n) / denominator
}

const uniqueById = <A extends { readonly id: string }>(values: readonly A[], name: string): Map<string, A> => {
  const byId = new Map<string, A>()
  for (const value of values) {
    ensure(/^[0-9a-f]{64}$/.test(value.id), `${name} has an invalid ID`)
    ensure(!byId.has(value.id), `${name} contains duplicate ID ${value.id}`)
    byId.set(value.id, value)
  }
  return byId
}

const expectedCashAmount = (fill: FillEvent): bigint => {
  const notional = unsigned(fill.notionalMicros, 'fill notional')
  const fee = unsigned(fill.feeMicros, 'fill fee')
  return fill.side === 'buy' ? -(notional + fee) : notional - fee
}

const validateDecisionIdentity = (runId: string, decision: DecisionEvent): void => {
  const { id: _, kind: __, ...payload } = decision
  ensure(
    decision.id === hashObject({ runId, kind: 'decision', ...payload }),
    `decision ${decision.id} has an invalid identity`,
  )
}

const validateOrder = (
  runId: string,
  order: SimulatedOrder,
  fill: FillEvent,
  decisions: ReadonlyMap<string, DecisionEvent>,
  transactionCostBpsMicros: bigint,
): void => {
  const decision = decisions.get(order.decisionId)
  if (decision === undefined) throw new Error(`order ${order.id} references an unknown decision`)
  ensure(fill.orderId === order.id, `fill ${fill.id} does not reference its order`)
  ensure(fill.decisionId === order.decisionId, `fill ${fill.id} and order ${order.id} disagree on decision`)
  ensure(fill.sessionDate === order.sessionDate, `fill ${fill.id} and order ${order.id} disagree on session`)
  ensure(fill.symbol === order.symbol, `fill ${fill.id} and order ${order.id} disagree on symbol`)
  ensure(fill.side === order.side, `fill ${fill.id} and order ${order.id} disagree on side`)
  ensure(decision.executionDate === order.sessionDate, `order ${order.id} is outside its decision execution session`)
  const requested = unsigned(order.requestedQuantityMicros, 'requested order quantity')
  const filled = unsigned(order.filledQuantityMicros, 'filled order quantity')
  ensure(filled > 0n, `order ${order.id} has no filled quantity`)
  ensure(filled <= requested, `order ${order.id} filled more than requested`)
  ensure(filled === unsigned(fill.quantityMicros, 'fill quantity'), `order ${order.id} and fill quantity diverge`)
  const { id: _, ...orderPayload } = order
  ensure(
    order.id === hashObject({ runId, kind: 'order', ...orderPayload }),
    `order ${order.id} has an invalid identity`,
  )
  const { id: __, kind: ___, ...fillPayload } = fill
  ensure(fill.id === hashObject({ runId, kind: 'fill', ...fillPayload }), `fill ${fill.id} has an invalid identity`)
  const reconstructedNotional = roundedMicrosProduct(filled, unsigned(fill.priceMicros, 'fill price'))
  ensure(
    absolute(reconstructedNotional - unsigned(fill.notionalMicros, 'fill notional')) <= MARKED_EQUITY_TOLERANCE_MICROS,
    `fill ${fill.id} notional diverges from quantity and price`,
  )
  ensure(
    absolute(unsigned(fill.feeMicros, 'fill fee') - roundedFee(reconstructedNotional, transactionCostBpsMicros)) <=
      MARKED_EQUITY_TOLERANCE_MICROS,
    `fill ${fill.id} fee diverges from the declared transaction-cost model`,
  )
}

const validateCashChange = (runId: string, change: CashChange, fill: FillEvent, expectedCash: bigint): void => {
  ensure(change.fillId === fill.id, `cash change ${change.id} references the wrong fill`)
  ensure(change.sessionDate === fill.sessionDate, `cash change ${change.id} references the wrong session`)
  ensure(
    signed(change.amountMicros, 'cash change amount') === expectedCashAmount(fill),
    `cash change ${change.id} diverges`,
  )
  ensure(
    signed(change.cashAfterMicros, 'cash after fill') === expectedCash,
    `cash change ${change.id} balance diverges`,
  )
  const { id: _, ...payload } = change
  ensure(
    change.id === hashObject({ runId, kind: 'cash-change', ...payload }),
    `cash change ${change.id} has an invalid identity`,
  )
}

const validateMarks = (marks: readonly DailyPositionMark[]): void => {
  ensure(marks.length > 0, 'simulation has no daily marks')
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index]
    if (index > 0) ensure(marks[index - 1].sessionDate < mark.sessionDate, 'daily marks are not strictly ordered')
    const symbols = mark.positions.map((position) => position.symbol)
    ensure(new Set(symbols).size === symbols.length, `daily mark ${mark.sessionDate} contains duplicate positions`)
    ensure(
      symbols.every((symbol, symbolIndex) => symbolIndex === 0 || symbols[symbolIndex - 1] < symbol),
      `daily mark ${mark.sessionDate} positions are not sorted`,
    )
  }
}

export interface MarkedEquityProof {
  readonly reconciliation: MarkedEquityReconciliation
  readonly equitySeries: readonly EquityPoint[]
}

export const reconcileMarkedEquity = (input: {
  readonly runId: string
  readonly initialCapitalMicros: string
  readonly evaluatorTotalFeesMicros: string
  readonly evaluatorEndingEquityMicros: string
  readonly events: readonly EvaluationEvent[]
  readonly simulation: SimulationTrace
  readonly toleranceMicros?: bigint
}): MarkedEquityProof => {
  const tolerance = input.toleranceMicros ?? MARKED_EQUITY_TOLERANCE_MICROS
  ensure(tolerance >= 0n, 'marked-equity tolerance must not be negative')
  ensure(/^[0-9a-f]{64}$/.test(input.runId), 'marked-equity run ID is invalid')
  ensure(input.simulation.schemaVersion === 'bayn.simulation-trace.v2', 'simulation trace version is unsupported')
  const transactionCostBpsMicros = unsigned(input.simulation.transactionCostBpsMicros, 'transaction cost basis points')
  ensure(transactionCostBpsMicros <= BASIS_POINTS * MICROS, 'transaction cost basis points exceed 100%')

  const decisions = uniqueById(
    input.events.filter((event): event is DecisionEvent => event.kind === 'decision'),
    'decision events',
  )
  for (const decision of decisions.values()) validateDecisionIdentity(input.runId, decision)
  const fills = input.events.filter((event): event is FillEvent => event.kind === 'fill')
  const fillsById = uniqueById(fills, 'fill events')
  const orders = uniqueById(input.simulation.orders, 'simulated orders')
  const changes = uniqueById(input.simulation.cashChanges, 'cash changes')
  const changesByFill = new Map<string, CashChange>()
  for (const change of changes.values()) {
    ensure(!changesByFill.has(change.fillId), `fill ${change.fillId} has multiple cash changes`)
    changesByFill.set(change.fillId, change)
  }
  ensure(orders.size === fills.length, 'simulated order count does not match fill count')
  ensure(changes.size === fills.length, 'cash change count does not match fill count')
  const filledOrderIds = new Set<string>()
  for (const fill of fills) {
    const order = orders.get(fill.orderId)
    if (order === undefined) throw new Error(`fill ${fill.id} references an unknown order`)
    ensure(!filledOrderIds.has(order.id), `order ${order.id} has multiple fills`)
    filledOrderIds.add(order.id)
    validateOrder(input.runId, order, fill, decisions, transactionCostBpsMicros)
    ensure(changesByFill.has(fill.id), `fill ${fill.id} has no cash change`)
  }
  ensure(filledOrderIds.size === orders.size, 'simulation contains an unfilled order')
  for (const change of changes.values()) ensure(fillsById.has(change.fillId), `cash change ${change.id} has no fill`)
  validateMarks(input.simulation.dailyMarks)

  let cash = unsigned(input.initialCapitalMicros, 'initial capital')
  const quantities = new Map<string, bigint>()
  let fillIndex = 0
  let previousFillDate: string | undefined
  let maximumDifference = 0n
  let finalPositionValue = 0n
  let reconstructedTotalFees = 0n
  const equitySeries: EquityPoint[] = []

  for (const mark of input.simulation.dailyMarks) {
    while (fillIndex < fills.length && fills[fillIndex].sessionDate <= mark.sessionDate) {
      const fill = fills[fillIndex]
      if (previousFillDate !== undefined) ensure(previousFillDate <= fill.sessionDate, 'fill events are not ordered')
      previousFillDate = fill.sessionDate
      ensure(fill.sessionDate === mark.sessionDate, `fill ${fill.id} has no mark for its session`)
      cash += expectedCashAmount(fill)
      reconstructedTotalFees += unsigned(fill.feeMicros, 'fill fee')
      ensure(cash >= -tolerance, `fill ${fill.id} spends unavailable reconstructed cash`)
      const quantity = unsigned(fill.quantityMicros, 'fill quantity')
      const current = quantities.get(fill.symbol) ?? 0n
      const next = fill.side === 'buy' ? current + quantity : current - quantity
      ensure(next >= -POSITION_QUANTITY_TOLERANCE_MICROS, `fill ${fill.id} creates a negative long-only position`)
      quantities.set(fill.symbol, next < 0n ? 0n : next)
      validateCashChange(input.runId, changesByFill.get(fill.id)!, fill, cash)
      fillIndex += 1
    }

    const markCash = unsigned(mark.cashMicros, 'daily cash')
    const cashDifference = absolute(markCash - cash)
    ensure(cashDifference <= tolerance, `daily cash diverges on ${mark.sessionDate}`)
    let reconstructedPositionValue = 0n
    const markedSymbols = new Set<string>()
    for (const position of mark.positions) {
      markedSymbols.add(position.symbol)
      const price = unsigned(position.priceMicros, 'position mark price')
      const reconstructedQuantity = quantities.get(position.symbol) ?? 0n
      const evaluatorQuantity = unsigned(position.quantityMicros, 'position quantity')
      ensure(
        absolute(evaluatorQuantity - reconstructedQuantity) <= POSITION_QUANTITY_TOLERANCE_MICROS,
        `position quantity diverges for ${position.symbol} on ${mark.sessionDate}`,
      )
      unsigned(position.costBasisMicros, 'position cost basis')
      const reconstructedValue = roundedMicrosProduct(reconstructedQuantity, price)
      reconstructedPositionValue += reconstructedValue
      const evaluatorValue = unsigned(position.marketValueMicros, 'position market value')
      ensure(
        absolute(evaluatorValue - reconstructedValue) <= tolerance,
        `position value diverges for ${position.symbol} on ${mark.sessionDate}`,
      )
    }
    for (const [symbol, quantity] of quantities) {
      ensure(
        quantity === 0n || markedSymbols.has(symbol),
        `daily mark ${mark.sessionDate} omits open position ${symbol}`,
      )
    }
    const reconstructedEquity = cash + reconstructedPositionValue
    const evaluatorEquity = unsigned(mark.equityMicros, 'daily evaluator equity')
    const difference = absolute(reconstructedEquity - evaluatorEquity)
    ensure(difference <= tolerance, `daily marked equity diverges on ${mark.sessionDate}`)
    maximumDifference = maximumDifference > difference ? maximumDifference : difference
    finalPositionValue = reconstructedPositionValue
    equitySeries.push({
      sessionDate: mark.sessionDate,
      evaluatorEquityMicros: evaluatorEquity.toString(),
      reconstructedEquityMicros: reconstructedEquity.toString(),
      differenceMicros: difference.toString(),
    })
  }
  ensure(fillIndex === fills.length, 'simulation has fills after its final daily mark')

  const evaluatorEnding = unsigned(input.evaluatorEndingEquityMicros, 'evaluator ending equity')
  const evaluatorTotalFees = unsigned(input.evaluatorTotalFeesMicros, 'evaluator total fees')
  const feeDifference = absolute(reconstructedTotalFees - evaluatorTotalFees)
  ensure(feeDifference <= tolerance, 'reconstructed fees exceed the declared tolerance')
  const reconstructedEnding = cash + finalPositionValue
  const finalDifference = absolute(reconstructedEnding - evaluatorEnding)
  ensure(finalDifference <= tolerance, 'final marked equity exceeds the declared tolerance')
  maximumDifference = maximumDifference > finalDifference ? maximumDifference : finalDifference

  return {
    reconciliation: {
      schemaVersion: 'bayn.marked-equity-reconciliation.v1',
      runId: input.runId,
      toleranceMicros: tolerance.toString(),
      maximumDailyDifferenceMicros: maximumDifference.toString(),
      reconstructedCashMicros: cash.toString(),
      reconstructedPositionValueMicros: finalPositionValue.toString(),
      evaluatorTotalFeesMicros: evaluatorTotalFees.toString(),
      reconstructedTotalFeesMicros: reconstructedTotalFees.toString(),
      feeDifferenceMicros: feeDifference.toString(),
      evaluatorEndingEquityMicros: evaluatorEnding.toString(),
      reconstructedEndingEquityMicros: reconstructedEnding.toString(),
      differenceMicros: finalDifference.toString(),
      exact: maximumDifference === 0n && feeDifference === 0n,
      withinTolerance: true,
    },
    equitySeries,
  }
}
