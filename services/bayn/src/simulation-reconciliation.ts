import { accrueCashYield, calculateSessionFees, makeFillTerms, notionalMicros, type FeeInput } from './execution-model'
import { hashObject } from './hash'
import type {
  CashChange,
  CashYieldEvent,
  DailyPositionMark,
  DecisionEvent,
  EquityPoint,
  EvaluationEvent,
  FeeEvent,
  FillEvent,
  MarkedEquityReconciliation,
  SimulatedOrder,
  SimulationTrace,
} from './types'

export const MARKED_EQUITY_TOLERANCE_MICROS = 0n

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

const uniqueById = <A extends { readonly id: string }>(values: readonly A[], name: string): Map<string, A> => {
  const byId = new Map<string, A>()
  for (const value of values) {
    ensure(/^[0-9a-f]{64}$/.test(value.id), `${name} has an invalid ID`)
    ensure(!byId.has(value.id), `${name} contains duplicate ID ${value.id}`)
    byId.set(value.id, value)
  }
  return byId
}

const validateDecisionIdentity = (runId: string, decision: DecisionEvent): void => {
  const { id: _, kind: __, ...payload } = decision
  ensure(
    decision.id === hashObject({ runId, kind: 'decision', ...payload }),
    `decision ${decision.id} has an invalid identity`,
  )
}

const validateFill = (runId: string, fill: FillEvent, order: SimulatedOrder, trace: SimulationTrace): void => {
  ensure(fill.orderId === order.id, `fill ${fill.id} does not reference its order`)
  ensure(fill.decisionId === order.decisionId, `fill ${fill.id} and order ${order.id} disagree on decision`)
  ensure(fill.sessionDate === order.sessionDate, `fill ${fill.id} and order ${order.id} disagree on session`)
  ensure(fill.symbol === order.symbol, `fill ${fill.id} and order ${order.id} disagree on symbol`)
  ensure(fill.side === order.side, `fill ${fill.id} and order ${order.id} disagree on side`)
  const filledQuantity = unsigned(fill.quantityMicros, 'fill quantity')
  ensure(filledQuantity === unsigned(order.filledQuantityMicros, 'filled order quantity'), 'order and fill diverge')
  const terms = makeFillTerms(
    fill.side,
    filledQuantity,
    unsigned(fill.referencePriceMicros, 'fill reference price'),
    trace.executionModel,
    unsigned(trace.costMultiplierMicros, 'cost multiplier'),
  )
  ensure(terms.fillPriceMicros === unsigned(fill.priceMicros, 'fill price'), `fill ${fill.id} price diverges`)
  ensure(terms.notionalMicros === unsigned(fill.notionalMicros, 'fill notional'), `fill ${fill.id} notional diverges`)
  ensure(
    terms.spreadCostMicros === unsigned(fill.spreadCostMicros, 'fill spread cost'),
    `fill ${fill.id} spread cost diverges`,
  )
  ensure(
    terms.slippageCostMicros === unsigned(fill.slippageCostMicros, 'fill slippage cost'),
    `fill ${fill.id} slippage cost diverges`,
  )
  unsigned(fill.costBasisMicros, 'fill cost basis')
  const { id: _, kind: __, ...payload } = fill
  ensure(fill.id === hashObject({ runId, kind: 'fill', ...payload }), `fill ${fill.id} has an invalid identity`)
}

const validateOrder = (
  runId: string,
  order: SimulatedOrder,
  fill: FillEvent | undefined,
  decisions: ReadonlyMap<string, DecisionEvent>,
  trace: SimulationTrace,
): void => {
  const decision = decisions.get(order.decisionId)
  if (decision === undefined) throw new Error(`order ${order.id} references an unknown decision`)
  ensure(decision.executionDate === order.sessionDate, `order ${order.id} is outside its decision execution session`)
  const requested = unsigned(order.requestedQuantityMicros, 'requested order quantity')
  const filled = unsigned(order.filledQuantityMicros, 'filled order quantity')
  ensure(filled <= requested, `order ${order.id} filled more than requested`)
  if (order.status === 'filled') {
    ensure(requested > 0n && filled === requested, `filled order ${order.id} has inconsistent quantities`)
    ensure(
      order.rejectionReason === null && order.unfilledRemainder === 'none',
      `filled order ${order.id} is malformed`,
    )
  } else if (order.status === 'partially-filled') {
    ensure(filled > 0n && filled < requested, `partial order ${order.id} has inconsistent quantities`)
    ensure(
      order.rejectionReason === null && order.unfilledRemainder === 'canceled',
      `partial order ${order.id} is malformed`,
    )
  } else {
    ensure(filled === 0n && order.rejectionReason !== null, `rejected order ${order.id} is malformed`)
    ensure(order.unfilledRemainder === 'canceled', `rejected order ${order.id} must cancel its remainder`)
  }
  ensure((fill === undefined) === (filled === 0n), `order ${order.id} fill presence diverges from its status`)
  const { id: _, ...payload } = order
  ensure(order.id === hashObject({ runId, kind: 'order', ...payload }), `order ${order.id} has an invalid identity`)
  if (fill !== undefined) validateFill(runId, fill, order, trace)
}

const validateFee = (
  runId: string,
  fee: FeeEvent,
  sessionFills: readonly FillEvent[],
  trace: SimulationTrace,
): void => {
  const components =
    unsigned(fee.commissionMicros, 'commission fee') +
    unsigned(fee.secMicros, 'SEC fee') +
    unsigned(fee.tafMicros, 'TAF fee') +
    unsigned(fee.catMicros, 'CAT fee')
  ensure(components === unsigned(fee.totalMicros, 'total fee'), `fee ${fee.id} components do not sum`)
  const inputs: FeeInput[] = sessionFills.map((fill) => ({
    side: fill.side,
    quantityMicros: unsigned(fill.quantityMicros, 'fill quantity'),
    notionalMicros: unsigned(fill.notionalMicros, 'fill notional'),
  }))
  const expected = calculateSessionFees(
    inputs,
    trace.executionModel,
    unsigned(trace.costMultiplierMicros, 'cost multiplier'),
  )
  ensure(expected.commissionMicros === BigInt(fee.commissionMicros), `fee ${fee.id} commission diverges`)
  ensure(expected.secMicros === BigInt(fee.secMicros), `fee ${fee.id} SEC component diverges`)
  ensure(expected.tafMicros === BigInt(fee.tafMicros), `fee ${fee.id} TAF component diverges`)
  ensure(expected.catMicros === BigInt(fee.catMicros), `fee ${fee.id} CAT component diverges`)
  ensure(expected.totalMicros === BigInt(fee.totalMicros), `fee ${fee.id} total diverges`)
  const { id: _, kind: __, ...payload } = fee
  ensure(fee.id === hashObject({ runId, kind: 'fee', ...payload }), `fee ${fee.id} has an invalid identity`)
}

const validateCashChange = (
  runId: string,
  change: CashChange,
  event: FillEvent | FeeEvent | CashYieldEvent,
  amount: bigint,
  expectedCash: bigint,
): void => {
  ensure(change.sourceKind === event.kind, `cash change ${change.id} references the wrong source kind`)
  ensure(change.sourceId === event.id, `cash change ${change.id} references the wrong source`)
  ensure(change.sessionDate === event.sessionDate, `cash change ${change.id} references the wrong session`)
  ensure(signed(change.amountMicros, 'cash change amount') === amount, `cash change ${change.id} amount diverges`)
  ensure(
    signed(change.cashAfterMicros, 'cash after event') === expectedCash,
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
  ensure(input.simulation.schemaVersion === 'bayn.simulation-trace.v3', 'simulation trace version is unsupported')
  ensure(unsigned(input.simulation.costMultiplierMicros, 'cost multiplier') > 0n, 'cost multiplier must be positive')

  const decisions = uniqueById(
    input.events.filter((event): event is DecisionEvent => event.kind === 'decision'),
    'decision events',
  )
  for (const decision of decisions.values()) validateDecisionIdentity(input.runId, decision)
  const fills = input.events.filter((event): event is FillEvent => event.kind === 'fill')
  uniqueById(fills, 'fill events')
  const fillsByOrder = new Map<string, FillEvent>()
  for (const fill of fills) {
    ensure(!fillsByOrder.has(fill.orderId), `order ${fill.orderId} has multiple fills`)
    fillsByOrder.set(fill.orderId, fill)
  }
  const orders = uniqueById(input.simulation.orders, 'simulated orders')
  for (const order of orders.values()) {
    validateOrder(input.runId, order, fillsByOrder.get(order.id), decisions, input.simulation)
  }
  for (const fill of fills) ensure(orders.has(fill.orderId), `fill ${fill.id} references an unknown order`)

  const fees = input.events.filter((event): event is FeeEvent => event.kind === 'fee')
  const cashYields = input.events.filter((event): event is CashYieldEvent => event.kind === 'cash-yield')
  uniqueById(fees, 'fee events')
  uniqueById(cashYields, 'cash-yield events')
  for (const fee of fees) {
    validateFee(
      input.runId,
      fee,
      fills.filter((fill) => fill.sessionDate === fee.sessionDate),
      input.simulation,
    )
  }

  const monetaryEvents = input.events.filter(
    (event): event is FillEvent | FeeEvent | CashYieldEvent => event.kind !== 'decision',
  )
  const changes = uniqueById(input.simulation.cashChanges, 'cash changes')
  const changesBySource = new Map<string, CashChange>()
  for (const change of changes.values()) {
    ensure(!changesBySource.has(change.sourceId), `event ${change.sourceId} has multiple cash changes`)
    changesBySource.set(change.sourceId, change)
  }
  ensure(changes.size === monetaryEvents.length, 'cash change count does not match monetary event count')
  for (const event of monetaryEvents) ensure(changesBySource.has(event.id), `event ${event.id} has no cash change`)
  validateMarks(input.simulation.dailyMarks)

  let cash = unsigned(input.initialCapitalMicros, 'initial capital')
  const quantities = new Map<string, bigint>()
  let eventIndex = 0
  let maximumDifference = 0n
  let finalPositionValue = 0n
  let reconstructedTotalFees = 0n
  let cumulativeTurnover = 0n
  let cumulativeSpread = 0n
  let cumulativeSlippage = 0n
  let cumulativeCashYield = 0n
  const equitySeries: EquityPoint[] = []

  for (const mark of input.simulation.dailyMarks) {
    const turnoverBefore = cumulativeTurnover
    const feesBefore = reconstructedTotalFees
    const spreadBefore = cumulativeSpread
    const slippageBefore = cumulativeSlippage
    const yieldBefore = cumulativeCashYield
    while (eventIndex < monetaryEvents.length && monetaryEvents[eventIndex].sessionDate <= mark.sessionDate) {
      const event = monetaryEvents[eventIndex]
      ensure(event.sessionDate === mark.sessionDate, `event ${event.id} has no mark for its session`)
      let amount: bigint
      if (event.kind === 'fill') {
        const notional = unsigned(event.notionalMicros, 'fill notional')
        amount = event.side === 'buy' ? -notional : notional
        cumulativeTurnover += notional
        cumulativeSpread += unsigned(event.spreadCostMicros, 'fill spread cost')
        cumulativeSlippage += unsigned(event.slippageCostMicros, 'fill slippage cost')
        const quantity = unsigned(event.quantityMicros, 'fill quantity')
        const current = quantities.get(event.symbol) ?? 0n
        const next = event.side === 'buy' ? current + quantity : current - quantity
        ensure(next >= 0n, `fill ${event.id} creates a negative long-only position`)
        quantities.set(event.symbol, next)
      } else if (event.kind === 'fee') {
        const total = unsigned(event.totalMicros, 'fee total')
        amount = -total
        reconstructedTotalFees += total
      } else {
        ensure(
          event.annualYieldBps === input.simulation.executionModel.cash.annualYieldBps,
          `cash-yield event ${event.id} rate diverges from the model`,
        )
        const expected = accrueCashYield(cash, event.elapsedDays, input.simulation.executionModel)
        ensure(expected === unsigned(event.amountMicros, 'cash-yield amount'), `cash-yield event ${event.id} diverges`)
        amount = expected
        cumulativeCashYield += expected
        const { id: _, kind: __, ...payload } = event
        ensure(
          event.id === hashObject({ runId: input.runId, kind: 'cash-yield', ...payload }),
          `cash-yield event ${event.id} has an invalid identity`,
        )
      }
      cash += amount
      ensure(cash >= -tolerance, `event ${event.id} spends unavailable reconstructed cash`)
      const change = changesBySource.get(event.id)
      if (change === undefined) throw new Error(`event ${event.id} has no cash change`)
      validateCashChange(input.runId, change, event, amount, cash)
      eventIndex += 1
    }

    ensure(
      unsigned(mark.turnoverMicros, 'daily turnover') === cumulativeTurnover - turnoverBefore,
      'daily turnover diverges',
    )
    ensure(
      unsigned(mark.cumulativeTurnoverMicros, 'cumulative turnover') === cumulativeTurnover,
      'cumulative turnover diverges',
    )
    ensure(unsigned(mark.feeMicros, 'daily fees') === reconstructedTotalFees - feesBefore, 'daily fees diverge')
    ensure(unsigned(mark.cumulativeFeesMicros, 'cumulative fees') === reconstructedTotalFees, 'cumulative fees diverge')
    ensure(unsigned(mark.spreadCostMicros, 'daily spread') === cumulativeSpread - spreadBefore, 'daily spread diverges')
    ensure(
      unsigned(mark.cumulativeSpreadCostMicros, 'cumulative spread') === cumulativeSpread,
      'cumulative spread diverges',
    )
    ensure(
      unsigned(mark.slippageCostMicros, 'daily slippage') === cumulativeSlippage - slippageBefore,
      'daily slippage diverges',
    )
    ensure(
      unsigned(mark.cumulativeSlippageCostMicros, 'cumulative slippage') === cumulativeSlippage,
      'cumulative slippage diverges',
    )
    ensure(
      unsigned(mark.cashYieldMicros, 'daily cash yield') === cumulativeCashYield - yieldBefore,
      'daily cash yield diverges',
    )
    ensure(
      unsigned(mark.cumulativeCashYieldMicros, 'cumulative cash yield') === cumulativeCashYield,
      'cumulative cash yield diverges',
    )
    const markCash = unsigned(mark.cashMicros, 'daily cash')
    ensure(absolute(markCash - cash) <= tolerance, `daily cash diverges on ${mark.sessionDate}`)
    let reconstructedPositionValue = 0n
    const markedSymbols = new Set<string>()
    for (const position of mark.positions) {
      markedSymbols.add(position.symbol)
      const price = unsigned(position.priceMicros, 'position mark price')
      const reconstructedQuantity = quantities.get(position.symbol) ?? 0n
      ensure(
        unsigned(position.quantityMicros, 'position quantity') === reconstructedQuantity,
        `position quantity diverges for ${position.symbol} on ${mark.sessionDate}`,
      )
      unsigned(position.costBasisMicros, 'position cost basis')
      const reconstructedValue = notionalMicros(reconstructedQuantity, price)
      reconstructedPositionValue += reconstructedValue
      ensure(
        unsigned(position.marketValueMicros, 'position market value') === reconstructedValue,
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
  ensure(eventIndex === monetaryEvents.length, 'simulation has monetary events after its final daily mark')

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
      schemaVersion: 'bayn.marked-equity-reconciliation.v2',
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
