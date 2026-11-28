import { Schema } from 'effect'

import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { compareIntradayInstants, intradayAgeNanos, millisecondsAsNanos } from '../src/market-data/intraday/time'
import { quantityScale, quantityToDecimal } from '../src/quantity'
import {
  IsoDateSchema,
  PositiveMicrosSchema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcInstantSchema,
  UtcSourceTimestampSchema,
  strictParseOptions,
} from '../src/schemas'
import { IntradayAlphaPhase, intradayAlphaNoiseAreaSymbols } from '../src/strategy/intraday-alpha/constants'

const before = (left: string, right: string) => compareIntradayInstants(left, right) < 0
const atOrBefore = (left: string, right: string) => compareIntradayInstants(left, right) <= 0

const Id = StrictNonEmptyStringSchema
const At = UtcInstantSchema
const Signed = SignedMicrosSchema.check(Schema.isMaxLength(40))
const Positive = PositiveMicrosSchema.check(Schema.isMaxLength(39))
const Price = Schema.NullOr(Positive)
const NonNegative = Schema.String.check(Schema.isPattern(/^\d{1,39}$/))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Side = Schema.Enum(OrderSide)
const Feed = Schema.Literals(['iex', 'sip'])

const Calendar = Schema.Struct({ openAt: At, closeAt: At })
const Entry = Schema.Struct({
  id: Id,
  sleeve: Schema.Enum(IntradayAlphaPhase).check(
    Schema.makeFilter((phase) => phase !== IntradayAlphaPhase.OutsideWindow),
  ),
  symbol: SymbolSchema,
  side: Side,
  quantityAtoms: Positive,
  signalMicros: Price,
  referenceMicros: Price,
  holdMinutes: Schema.NullOr(Count.check(Schema.isBetween({ minimum: 1, maximum: 390 }))),
})
const Order = Schema.Struct({
  id: Id,
  entryId: Schema.NullOr(Id),
  parentId: Schema.NullOr(Id),
  symbol: SymbolSchema,
  side: Side,
  type: Schema.Enum(OrderType),
  status: Schema.Enum(OrderStatus),
  quantityAtoms: Schema.NullOr(Positive),
  limitMicros: Price,
  stopMicros: Price,
  exitReferenceMicros: Price,
  openedAt: UtcSourceTimestampSchema,
  terminalAt: Schema.NullOr(UtcSourceTimestampSchema),
  protective: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (row) => {
      const working =
        row.status === OrderStatus.New ||
        row.status === OrderStatus.Pending ||
        row.status === OrderStatus.PartiallyFilled
      if (working !== (row.terminalAt === null) || row.id === row.parentId) return false
      if (row.type === OrderType.Market) return row.limitMicros === null && row.stopMicros === null
      if (row.quantityAtoms === null || row.limitMicros === null) return false
      if (row.type === OrderType.Limit) return row.stopMicros === null
      return (
        row.stopMicros !== null &&
        (row.side === OrderSide.Buy
          ? BigInt(row.limitMicros) >= BigInt(row.stopMicros)
          : BigInt(row.limitMicros) <= BigInt(row.stopMicros))
      )
    },
    { expected: 'coherent broker order terms and terminal status' },
  ),
)
const Fill = Schema.Struct({
  id: Id,
  orderId: Id,
  symbol: SymbolSchema,
  side: Side,
  at: UtcSourceTimestampSchema,
  quantityAtoms: Positive,
  priceAtoms: Positive,
  feeMicros: NonNegative,
  realizedMicros: Schema.NullOr(Signed),
})
const Position = Schema.Struct({ symbol: SymbolSchema, quantityAtoms: Signed, unrealizedMicros: Signed })
const Reconciliation = Schema.Struct({
  at: At,
  positionsAt: Schema.NullOr(At),
  exact: Schema.Boolean,
  coversActivity: Schema.Boolean,
  positionCount: Schema.NullOr(Count),
  positions: Schema.Array(Position),
}).check(
  Schema.makeFilter(
    (row) =>
      row.positionsAt === null
        ? row.positionCount === null && row.positions.length === 0
        : row.positionsAt <= row.at &&
          row.positions.length === row.positionCount &&
          new Set(row.positions.map((position) => position.symbol)).size === row.positionCount,
    { expected: 'complete, unique positions from the bound snapshot' },
  ),
)

export const MarketEvidence = Schema.Struct({
  quotes: Schema.Array(
    Schema.Struct({
      symbol: SymbolSchema,
      at: UtcSourceTimestampSchema,
      feed: Feed,
      bidMicros: Price,
      askMicros: Price,
    }).check(
      Schema.makeFilter(
        (row) => row.bidMicros === null || row.askMicros === null || BigInt(row.bidMicros) <= BigInt(row.askMicros),
        { expected: 'uncrossed quote' },
      ),
    ),
  ),
  bars: Schema.Array(
    Schema.Struct({
      symbol: SymbolSchema,
      at: At.check(
        Schema.makeFilter((at) => Date.parse(at) % 60_000 === 0, {
          expected: 'completed minute bar start',
        }),
      ),
      feed: Feed,
      closeMicros: Positive,
    }),
  ),
})
const Controller = Schema.Struct({
  id: Id,
  at: At,
  noAdmissibleCut: Schema.Boolean,
  closeMarketDataUnavailable: Schema.Boolean,
  closeWindowExpired: Schema.Boolean,
})
const Session = Schema.Struct({
  date: IsoDateSchema,
  dayStartAt: At,
  asOf: At,
  calendar: Schema.NullOr(Calendar),
  openingEquityMicros: Price,
  positionMarks: Schema.Array(
    Schema.Struct({
      symbol: SymbolSchema,
      at: UtcSourceTimestampSchema,
      quantityAtoms: Signed,
      priceMicros: Positive,
    }),
  ),
  openingPositions: Schema.Array(Schema.Struct({ symbol: SymbolSchema, quantityAtoms: Signed })),
  reconciliation: Schema.NullOr(Reconciliation),
  entries: Schema.Array(Entry),
  orders: Schema.Array(Order),
  fills: Schema.Array(Fill),
  controller: Schema.Array(Controller),
  market: MarketEvidence,
  postedFeeDebitMicros: Signed,
  pendingFees: Count,
  missingFillEvents: Count,
  unverifiedDecisions: Count,
}).check(
  Schema.makeFilter(
    (row) =>
      row.dayStartAt.startsWith(row.date) &&
      row.dayStartAt <= row.asOf &&
      (row.calendar === null ||
        (row.calendar.openAt < row.calendar.closeAt &&
          row.calendar.openAt.startsWith(row.date) &&
          row.calendar.closeAt.startsWith(row.date))) &&
      (row.reconciliation === null || row.reconciliation.at <= row.asOf) &&
      row.fills.every((fill) => atOrBefore(row.dayStartAt, fill.at) && atOrBefore(fill.at, row.asOf)) &&
      row.controller.every((pass) => pass.at <= row.asOf) &&
      row.orders.every(
        (order) =>
          atOrBefore(order.openedAt, row.asOf) &&
          (order.terminalAt === null ||
            (atOrBefore(order.openedAt, order.terminalAt) && atOrBefore(order.terminalAt, row.asOf))),
      ) &&
      unique(row.entries.map(({ id }) => id)) &&
      unique(row.orders.map(({ id }) => id)) &&
      unique(row.fills.map(({ id }) => id)) &&
      unique(row.controller.map(({ id }) => id)) &&
      unique(row.openingPositions.map(({ symbol }) => symbol)),
    { expected: 'one consistent time cut with unique durable row identities' },
  ),
)
const unique = (keys: readonly string[]) => new Set(keys).size === keys.length

export const AuditInput = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.live-profitability-evidence.v1'),
  sessions: Schema.Array(Session),
}).check(Schema.makeFilter((row) => unique(row.sessions.map(({ date }) => date)), { expected: 'unique session dates' }))
export const decodeAuditInput = Schema.decodeUnknownResult(AuditInput, strictParseOptions)
type AuditInput = typeof AuditInput.Type
type Session = typeof Session.Type
type Fill = typeof Fill.Type
type Order = typeof Order.Type
type Entry = typeof Entry.Type

const priceScale = 1_000_000_000n
const promotionBps = 2.5
const breakevenBps = 11.2
const recentBreakevenBps = 15.6
const byKey = (a: string, b: string) => (a < b ? -1 : a === b ? 0 : 1)
const add = (values: readonly bigint[]) => values.reduce((sum, value) => sum + value, 0n)
const sign = (side: OrderSide) => (side === OrderSide.Buy ? 1n : -1n)
const ratio = (n: number, d: number) => (d === 0 ? null : n / d)
const round = (value: number) => Number(value.toFixed(6))
const usdMicros = (notional: bigint) => notional / ((priceScale / 1_000_000n) * quantityScale)
const fillNotional = (fill: Fill) => BigInt(fill.priceAtoms) * BigInt(fill.quantityAtoms)
const quantity = (fills: readonly Fill[]) => add(fills.map((fill) => BigInt(fill.quantityAtoms)))
const delta = (fill: Fill) => sign(fill.side) * BigInt(fill.quantityAtoms)
const working = (order: Order) =>
  [OrderStatus.New, OrderStatus.Pending, OrderStatus.PartiallyFilled].includes(order.status)

const summarizeBps = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const lower = sorted[Math.floor((sorted.length - 1) / 2)]
  const upper = sorted[Math.floor(sorted.length / 2)]
  return {
    samples: sorted.length,
    meanBps: sorted.length === 0 ? null : sorted.reduce((a, b) => a + b, 0) / sorted.length,
    medianBps: lower === undefined || upper === undefined ? null : (lower + upper) / 2,
  }
}
const presentBps = ({ samples, meanBps, medianBps }: ReturnType<typeof summarizeBps>) => ({
  samples,
  meanBps: meanBps === null ? null : round(meanBps),
  medianBps: medianBps === null ? null : round(medianBps),
})
const distribution = (values: readonly number[]) => presentBps(summarizeBps(values))

const slippage = (fills: readonly Fill[], benchmark: (fill: Fill) => string | null) => {
  let reference = 0n
  let adverse = 0n
  for (const fill of fills) {
    const micros = benchmark(fill)
    if (micros === null) return null
    const expected = BigInt(micros) * 1_000n * BigInt(fill.quantityAtoms)
    reference += expected
    adverse += sign(fill.side) * (fillNotional(fill) - expected)
  }
  return reference === 0n ? null : (Number(adverse) / Number(reference)) * 10_000
}

const group = <A>(rows: readonly A[], key: (row: A) => string) => {
  const groups = new Map<string, A[]>()
  for (const row of rows) {
    const k = key(row)
    const values = groups.get(k)
    if (values === undefined) groups.set(k, [row])
    else values.push(row)
  }
  return groups
}

const marketDrift = (session: Session) => {
  const bars = session.market.bars.filter(
    ({ at }) =>
      session.calendar !== null &&
      at >= session.calendar.openAt &&
      Date.parse(at) + 60_000 <= Date.parse(session.calendar.closeAt) &&
      Date.parse(at) + 60_000 <= Date.parse(session.asOf),
  )
  const bySymbol = group(bars, ({ symbol }) => symbol)
  return [...bySymbol]
    .sort(([a], [b]) => byKey(a, b))
    .map(([symbol, rows]) => {
      const samples: number[] = []
      let unmatchedMinutes = 0
      let conflictingMinutes = 0
      for (const [, minute] of [...group(rows, ({ at }) => at)].sort(([a], [b]) => byKey(a, b))) {
        const iex = new Set(minute.filter(({ feed }) => feed === 'iex').map(({ closeMicros }) => closeMicros))
        const sip = new Set(minute.filter(({ feed }) => feed === 'sip').map(({ closeMicros }) => closeMicros))
        const [left] = iex
        const [right] = sip
        if (iex.size > 1 || sip.size > 1) conflictingMinutes++
        else if (left === undefined || right === undefined) unmatchedMinutes++
        else samples.push((Number(BigInt(left) - BigInt(right)) / Number(right)) * 10_000)
      }
      return {
        symbol,
        ...distribution(samples),
        absolute: distribution(samples.map(Math.abs)),
        unmatchedMinutes,
        conflictingMinutes,
      }
    })
}

const auditSession = (session: Session) => {
  const orderById = new Map(session.orders.map((order) => [order.id, order]))
  const entryById = new Map(session.entries.map((entry) => [entry.id, entry]))
  const fills = session.fills.toSorted((a, b) => compareIntradayInstants(a.at, b.at) || byKey(a.id, b.id))
  const fillsByOrder = group(fills, ({ orderId }) => orderId)
  const symbolFills = group(fills, ({ symbol }) => symbol)
  const openingQty = new Map(
    session.openingPositions.map(({ symbol, quantityAtoms }) => [symbol, BigInt(quantityAtoms)]),
  )
  const entryFor = (order: Order | undefined) => {
    if (order === undefined || order.entryId === null || order.parentId !== null || order.protective) return undefined
    const entry = entryById.get(order.entryId)
    return entry?.symbol === order.symbol && entry.side === order.side ? entry : undefined
  }
  const boundOrder = (fill: Fill) => {
    const order = orderById.get(fill.orderId)
    return order?.symbol === fill.symbol && order.side === fill.side ? order : undefined
  }
  const ordersByEntry = group(session.orders, (order) => entryFor(order)?.id ?? '')
  const quotes = group(
    session.market.quotes
      .filter(({ at }) => atOrBefore(session.dayStartAt, at) && atOrBefore(at, session.asOf))
      .toSorted(
        (a, b) =>
          compareIntradayInstants(a.at, b.at) ||
          byKey(a.feed, b.feed) ||
          byKey(a.bidMicros ?? '', b.bidMicros ?? '') ||
          byKey(a.askMicros ?? '', b.askMicros ?? ''),
      ),
    ({ symbol }) => symbol,
  )
  const marks = group(session.positionMarks, ({ symbol }) => symbol)
  const oppositePrice = (order: Order, quote: Session['market']['quotes'][number]) =>
    order.side === OrderSide.Buy ? quote.askMicros : quote.bidMicros
  const pastLimit = (order: Order, price: string) =>
    order.limitMicros !== null && sign(order.side) * (BigInt(price) - BigInt(order.limitMicros)) > 0n
  const orderFills = (order: Order) => (fillsByOrder.get(order.id) ?? []).filter((fill) => boundOrder(fill) === order)
  const entryReports = session.entries
    .toSorted((a, b) => byKey(a.id, b.id))
    .map((entry) => {
      const orders = ordersByEntry.get(entry.id) ?? []
      const matched = orders.flatMap(orderFills)
      const filled = quantity(matched)
      const collarMissed =
        filled === 0n &&
        orders.length > 0 &&
        orders.every((order) => {
          if (
            order.limitMicros === null ||
            order.terminalAt === null ||
            (order.status !== OrderStatus.Expired && order.status !== OrderStatus.Canceled)
          )
            return false
          // Count only an observed outside-collar quote at submission, not every canceled or expired entry.
          const outsideAtSubmit = (quotes.get(order.symbol) ?? [])
            .filter(
              ({ at, feed }) =>
                feed === 'iex' &&
                atOrBefore(at, order.openedAt) &&
                intradayAgeNanos(order.openedAt, at) <= millisecondsAsNanos(1_000),
            )
            .at(-1)
          const price = outsideAtSubmit === undefined ? null : oppositePrice(order, outsideAtSubmit)
          return price !== null && pastLimit(order, price)
        })
      const displaySlip = (reference: (fill: Fill) => string | null) => {
        const result = slippage(matched, reference)
        return result === null ? null : round(result)
      }
      return {
        ...entry,
        orderIds: orders.map(({ id }) => id).sort(),
        filledQuantityAtoms: filled.toString(),
        fullyFilled: filled === BigInt(entry.quantityAtoms),
        collarMissed,
        versusSignalBps: displaySlip(() => entry.signalMicros),
        versusReferenceBps: displaySlip(() => entry.referenceMicros),
        versusLimitBps: displaySlip((fill) => boundOrder(fill)?.limitMicros ?? null),
      }
    })

  const stopReports = session.orders
    .filter((order) => order.type === OrderType.StopLimit && order.protective)
    .toSorted((a, b) => byKey(a.id, b.id))
    .map((order) => {
      const expected = order.quantityAtoms === null ? null : BigInt(order.quantityAtoms)
      const matched = orderFills(order)
      // A resting child is not an exit for a flat account (e.g. before its entry fills or after a sibling fills).
      const inventoryFills = symbolFills.get(order.symbol) ?? []
      let inventory = openingQty.get(order.symbol) ?? 0n
      let cursor = 0
      const executable = (quotes.get(order.symbol) ?? []).filter((quote) => {
        let fill = inventoryFills[cursor]
        while (fill !== undefined && atOrBefore(fill.at, quote.at)) {
          inventory += delta(fill)
          fill = inventoryFills[++cursor]
        }
        return (
          sign(order.side) * inventory < 0n &&
          atOrBefore(order.openedAt, quote.at) &&
          (order.terminalAt === null || before(quote.at, order.terminalAt)) &&
          oppositePrice(order, quote) !== null
        )
      })
      const liveQuotes = executable.filter(({ feed }) => feed === 'iex')
      const observed = liveQuotes.length > 0 ? liveQuotes : executable
      const stop = order.stopMicros
      const crossesStop = (price: string) => stop !== null && sign(order.side) * (BigInt(price) - BigInt(stop)) >= 0n
      const unfilledAt = (at: string) =>
        expected !== null && quantity(matched.filter((fill) => atOrBefore(fill.at, at))) < expected
      const crossed = observed.flatMap((quote) => {
        const price = oppositePrice(order, quote)
        return price !== null && crossesStop(price) ? [{ ...quote, price }] : []
      })
      const incident = crossed.find(({ price, at }) => pastLimit(order, price) && unfilledAt(at))
      // Position marks can document a stranded order without an archive quote. They never prove executable liquidity.
      const mark = (marks.get(order.symbol) ?? [])
        .filter(
          (row) =>
            sign(order.side) * BigInt(row.quantityAtoms) < 0n &&
            atOrBefore(session.dayStartAt, row.at) &&
            atOrBefore(order.openedAt, row.at) &&
            atOrBefore(row.at, order.terminalAt ?? session.asOf) &&
            crossesStop(row.priceMicros) &&
            pastLimit(order, row.priceMicros) &&
            unfilledAt(row.at),
        )
        .toSorted((a, b) => compareIntradayInstants(a.at, b.at) || byKey(a.priceMicros, b.priceMicros))[0]
      const owner = entryById.get(order.entryId ?? '') ?? entryFor(orderById.get(order.parentId ?? ''))
      return {
        orderId: order.id,
        symbol: order.symbol,
        sleeve: owner?.sleeve ?? 'UNATTRIBUTED',
        status: order.status,
        terminalAt: order.terminalAt,
        stopMicros: stop,
        limitMicros: order.limitMicros,
        filledQuantityAtoms: quantity(matched).toString(),
        fullyFilled: quantity(matched) === expected,
        observedQuotes: observed.length,
        stopCrossed: crossed.length > 0 || matched.length > 0 || mark !== undefined,
        gapThrough:
          incident !== undefined
            ? {
                source: 'QUOTE' as const,
                at: incident.at,
                feed: incident.feed,
                oppositePriceMicros: incident.price,
                firstObservedCrossAlreadyPastLimit: incident === crossed[0],
              }
            : mark !== undefined
              ? {
                  source: 'POSITION_MARK' as const,
                  at: mark.at,
                  markPriceMicros: mark.priceMicros,
                }
              : null,
      }
    })

  // Own a flat-to-flat episode only when every opening/add fill binds the same verified entry.
  // Reversals and carry-ins are not manufactured into attributable round trips.
  const closeQty = new Map(openingQty)
  const endQty = new Map(openingQty)
  const postCloseOrders = session.orders.filter(
    ({ openedAt }) => session.calendar !== null && atOrBefore(session.calendar.closeAt, openedAt),
  )
  const postCloseFills = fills.filter(({ at }) => session.calendar !== null && atOrBefore(session.calendar.closeAt, at))
  const sleevesByFill = new Map<string, IntradayAlphaPhase>()
  const openSleeves = new Map<string, IntradayAlphaPhase>()
  const closeSleeves = new Map<string, IntradayAlphaPhase>()
  type OwnedTrade = { entryId: string; symbol: string; sleeve: IntradayAlphaPhase }
  const episodes: (OwnedTrade & { roundTripBps: number | null })[] = []
  const timedExitBreaches: (OwnedTrade & { dueAt: string; flatAt: string | null })[] = []
  for (const [symbol, rows] of symbolFills) {
    let inventory = openingQty.get(symbol) ?? 0n
    let owner: Entry | undefined
    let entered: Fill[] = []
    let exited: Fill[] = []
    const finish = (open: boolean) => {
      const firstFill = entered[0]
      const lastExit = exited.at(-1)
      if (owner === undefined || firstFill === undefined) return
      for (const fill of [...entered, ...exited]) sleevesByFill.set(fill.id, owner.sleeve)
      if (open) openSleeves.set(symbol, owner.sleeve)
      if (
        session.calendar !== null &&
        before(firstFill.at, session.calendar.closeAt) &&
        (open || lastExit === undefined || atOrBefore(session.calendar.closeAt, lastExit.at))
      )
        closeSleeves.set(symbol, owner.sleeve)
      if (owner.holdMinutes !== null) {
        const dueAt = new Date(Date.parse(firstFill.at) + owner.holdMinutes * 60_000).toISOString()
        const observedUntil = open ? session.asOf : lastExit?.at
        if (observedUntil !== undefined && before(dueAt, observedUntil))
          timedExitBreaches.push({
            entryId: owner.id,
            sleeve: owner.sleeve,
            symbol,
            dueAt,
            flatAt: open ? null : (lastExit?.at ?? null),
          })
      }
      if (!open) {
        const entryBps = slippage(entered, () => owner?.signalMicros ?? owner?.referenceMicros ?? null)
        const exitBps = slippage(exited, (fill) => {
          const order = boundOrder(fill)
          return order?.exitReferenceMicros ?? null
        })
        episodes.push({
          entryId: owner.id,
          symbol,
          sleeve: owner.sleeve,
          roundTripBps: entryBps === null || exitBps === null ? null : entryBps + exitBps,
        })
      }
    }
    let atClose = inventory
    for (const fill of rows) {
      const change = delta(fill)
      const next = inventory + change
      if (session.calendar !== null && before(fill.at, session.calendar.closeAt)) atClose += change
      const entry = entryFor(boundOrder(fill))
      if (inventory === 0n) {
        owner = entry
        entered = [fill]
        exited = []
      } else if (inventory > 0n === change > 0n) {
        if (entry !== owner || exited.length > 0) owner = undefined
        entered.push(fill)
      } else {
        if ((next !== 0n && inventory > 0n !== next > 0n) || entry !== undefined) owner = undefined
        exited.push(fill)
      }
      inventory = next
      if (inventory === 0n) finish(false)
    }
    if (inventory !== 0n) finish(true)
    closeQty.set(symbol, atClose)
    endQty.set(symbol, inventory)
  }

  const closeReached = session.calendar !== null && session.asOf >= session.calendar.closeAt
  const reconciliation = session.reconciliation
  const brokerPositions = new Map(
    (reconciliation?.positions ?? []).filter(({ symbol }) => !symbol.includes('/')).map((row) => [row.symbol, row]),
  )
  const positionEvidence =
    reconciliation !== null &&
    session.calendar !== null &&
    reconciliation.positionsAt !== null &&
    reconciliation.positionsAt >= session.calendar.openAt &&
    reconciliation.coversActivity
  const eodEvidence = positionEvidence && reconciliation.positionsAt >= session.calendar.closeAt
  const symbols = [
    ...new Set([
      ...openingQty.keys(),
      ...endQty.keys(),
      ...brokerPositions.keys(),
      ...entryReports.map(({ symbol }) => symbol),
      ...stopReports.map(({ symbol }) => symbol),
      ...session.orders.map(({ symbol }) => symbol),
    ]),
  ].sort()
  const positions = symbols.map((symbol) => {
    const broker = brokerPositions.get(symbol)
    const ending = endQty.get(symbol) ?? 0n
    const brokerQty = positionEvidence ? BigInt(broker?.quantityAtoms ?? '0') : null
    return {
      symbol,
      sleeve: openSleeves.get(symbol) ?? 'UNATTRIBUTED',
      regularCloseSleeve: closeSleeves.get(symbol) ?? 'UNATTRIBUTED',
      openingQuantity: quantityToDecimal(openingQty.get(symbol) ?? 0n),
      regularCloseQuantity: closeReached ? quantityToDecimal(closeQty.get(symbol) ?? 0n) : null,
      lastLedgerQuantity: quantityToDecimal(ending),
      lastBrokerQuantity: brokerQty === null ? null : quantityToDecimal(brokerQty),
      eodUnrealizedMicros: !eodEvidence || brokerQty !== ending ? null : (broker?.unrealizedMicros ?? '0'),
    }
  })
  const regularCloseBreaches = positions.filter(
    ({ regularCloseQuantity }) => regularCloseQuantity !== null && regularCloseQuantity !== '0',
  )
  const eodNonFlat = closeReached
    ? positions.filter(
        ({ lastLedgerQuantity, lastBrokerQuantity }) =>
          lastLedgerQuantity !== '0' || (eodEvidence && lastBrokerQuantity !== null && lastBrokerQuantity !== '0'),
      )
    : []
  const brokerInventoryMismatch =
    positionEvidence &&
    positions.some(({ lastBrokerQuantity, lastLedgerQuantity }) => lastBrokerQuantity !== lastLedgerQuantity)
  const noAdmissibleCut = session.controller.filter((row) => row.noAdmissibleCut).length
  const closeMarketDataUnavailable = session.controller.filter((row) => row.closeMarketDataUnavailable).length
  const closeWindowExpired = session.controller.filter((row) => row.closeWindowExpired).length
  const unresolvedOrders = session.orders.filter(working).length
  const unresolvedFills = fills.filter((fill) => boundOrder(fill) === undefined || fill.realizedMicros === null).length

  const metrics = (symbol?: string, sleeve?: string) => {
    const match = (s: string, e: string) =>
      (symbol === undefined || s === symbol) && (sleeve === undefined || e === sleeve)
    const executions = fills.filter((fill) => match(fill.symbol, sleevesByFill.get(fill.id) ?? 'UNATTRIBUTED'))
    const entries = entryReports.filter((entry) => match(entry.symbol, entry.sleeve))
    const stops = stopReports.filter((stop) => match(stop.symbol, stop.sleeve))
    const exposure = positions.filter((row) => match(row.symbol, row.sleeve))
    const trades = episodes.filter((row) => match(row.symbol, row.sleeve))
    const gross = add(executions.map((fill) => BigInt(fill.realizedMicros ?? '0')))
    const directFees = add(executions.map((fill) => BigInt(fill.feeMicros)))
    const sessionFees = symbol === undefined && sleeve === undefined ? BigInt(session.postedFeeDebitMicros) : 0n
    const notional = usdMicros(add(executions.map(fillNotional)))
    const complete = executions.every((fill) => fill.realizedMicros !== null) && session.missingFillEvents === 0
    const unrealized =
      exposure.some((row) => row.eodUnrealizedMicros === null) || !eodEvidence
        ? null
        : add(exposure.map((row) => BigInt(row.eodUnrealizedMicros ?? '0'))).toString()
    return {
      fills: executions.length,
      realizedMicros: complete ? gross.toString() : null,
      eodUnrealizedMicros: unrealized,
      directFeesMicros: directFees.toString(),
      unallocatedPostedFeesMicros: sessionFees.toString(),
      netRealizedMicros: complete ? (gross - directFees - sessionFees).toString() : null,
      tradedNotionalMicros: notional.toString(),
      annualizedTurnoverContribution:
        session.openingEquityMicros === null
          ? null
          : round((252 * Number(notional)) / Number(session.openingEquityMicros)),
      entries: entries.length,
      entryFillRate: ratio(
        entries.filter(({ filledQuantityAtoms }) => filledQuantityAtoms !== '0').length,
        entries.length,
      ),
      entryFullFillRate: ratio(entries.filter(({ fullyFilled }) => fullyFilled).length, entries.length),
      collarMissRate: ratio(entries.filter(({ collarMissed }) => collarMissed).length, entries.length),
      entryVsSignal: distribution(
        entries.flatMap(({ versusSignalBps }) => (versusSignalBps === null ? [] : [versusSignalBps])),
      ),
      entryVsReference: distribution(
        entries.flatMap(({ versusReferenceBps }) => (versusReferenceBps === null ? [] : [versusReferenceBps])),
      ),
      entryVsLimit: distribution(
        entries.flatMap(({ versusLimitBps }) => (versusLimitBps === null ? [] : [versusLimitBps])),
      ),
      protectiveStops: stops.length,
      observedStopCrosses: stops.filter(({ stopCrossed }) => stopCrossed).length,
      stopLimitFillRate: ratio(
        stops.filter(({ fullyFilled }) => fullyFilled).length,
        stops.filter(({ stopCrossed }) => stopCrossed).length,
      ),
      gapThroughIncidents: stops.filter(({ gapThrough }) => gapThrough !== null).length,
      timedExitBreaches: timedExitBreaches.filter((row) => match(row.symbol, row.sleeve)).length,
      regularCloseBreaches: regularCloseBreaches.filter((row) => match(row.symbol, row.regularCloseSleeve)).length,
      nonFlatEodPositions: eodNonFlat.filter((row) => match(row.symbol, row.sleeve)).length,
      roundTrip: distribution(trades.flatMap(({ roundTripBps }) => (roundTripBps === null ? [] : [roundTripBps]))),
      unmeasuredRoundTrips: trades.filter(({ roundTripBps }) => roundTripBps === null).length,
    }
  }
  const all = metrics()
  const inB0 = ({ sleeve, symbol }: { sleeve: string; symbol: string }) =>
    sleeve === IntradayAlphaPhase.NoiseAreaTrend &&
    intradayAlphaNoiseAreaSymbols.some((candidate) => candidate === symbol)
  const b0 = episodes.filter(inB0)
  const closedB0EntryIds = new Set(b0.map(({ entryId }) => entryId))
  const unmatchedB0Entries = entryReports.filter(
    (row) => inB0(row) && row.filledQuantityAtoms !== '0' && !closedB0EntryIds.has(row.id),
  ).length
  const roundTrips = b0.flatMap(({ roundTripBps }) => (roundTripBps === null ? [] : [roundTripBps]))
  const stats = summarizeBps(roundTrips)
  // Compare unrounded estimates so formatting cannot change the verdict.
  const compareBudget = (threshold: number) => {
    const { meanBps, medianBps, samples } = stats
    const exceeded = (meanBps !== null && meanBps >= threshold) || (medianBps !== null && medianBps >= threshold)
    return exceeded
      ? 'FAIL'
      : samples === 0 || b0.length !== samples || unmatchedB0Entries > 0
        ? 'INSUFFICIENT_EVIDENCE'
        : 'PASS'
  }
  const slippageGate = {
    cohort: 'B0 (QQQ+SMH 1.4x)',
    unmatchedFilledEntries: unmatchedB0Entries,
    ...presentBps(stats),
    unmeasuredRoundTrips: b0.length - stats.samples,
    promotionBps,
    promotion: compareBudget(promotionBps),
    fullPeriodBreakevenBps: breakevenBps,
    fullPeriodBreakeven: compareBudget(breakevenBps),
    recentBreakevenBps,
    recentBreakeven: compareBudget(recentBreakevenBps),
  }
  const alerts = [
    ...(noAdmissibleCut > 0 ? ['NO_ADMISSIBLE_CUT'] : []),
    ...(closeMarketDataUnavailable > 0 ? ['CLOSE_MARKET_DATA_UNAVAILABLE'] : []),
    ...(closeWindowExpired > 0 ? ['CLOSE_WINDOW_EXPIRED'] : []),
    ...(all.gapThroughIncidents > 0 ? ['STOP_LIMIT_GAP_THROUGH'] : []),
    ...(timedExitBreaches.length > 0 ? ['MISSED_TIMED_EXIT'] : []),
    ...(regularCloseBreaches.length > 0 ? ['REGULAR_CLOSE_BREACH'] : []),
    ...(postCloseOrders.length > 0 || postCloseFills.length > 0 ? ['POST_REGULAR_CLOSE_ACTIVITY'] : []),
    ...(eodNonFlat.length > 0 ? ['NON_FLAT_EOD'] : []),
    ...(brokerInventoryMismatch || reconciliation?.exact === false ? ['RECONCILIATION_DISCREPANCY'] : []),
    ...(closeReached && unresolvedOrders > 0 ? ['WORKING_ORDERS_AT_CUT'] : []),
  ]
  const priorSessionCarry = positions.filter(({ openingQuantity }) => openingQuantity !== '0')
  const incomplete =
    !eodEvidence ||
    !reconciliation.exact ||
    session.controller.length === 0 ||
    session.openingEquityMicros === null ||
    entryReports.some((row) => row.filledQuantityAtoms !== '0' && row.holdMinutes === null) ||
    unresolvedFills > 0 ||
    session.unverifiedDecisions > 0 ||
    session.missingFillEvents > 0 ||
    fills.some(({ id }) => !sleevesByFill.has(id)) ||
    priorSessionCarry.length > 0
  const losses = all.netRealizedMicros !== null && BigInt(all.netRealizedMicros) < 0n
  return {
    date: session.date,
    asOf: session.asOf,
    calendar: session.calendar,
    verdict:
      alerts.length > 0 || losses || slippageGate.promotion === 'FAIL'
        ? 'FAIL'
        : incomplete || session.pendingFees > 0 || slippageGate.promotion !== 'PASS' || all.netRealizedMicros === '0'
          ? 'INSUFFICIENT_EVIDENCE'
          : 'PASS',
    metrics: all,
    bySleeve: [
      ...new Set([
        ...entryReports.map(({ sleeve }) => sleeve),
        ...sleevesByFill.values(),
        ...stopReports.map(({ sleeve }) => sleeve),
        ...(fills.some(({ id }) => !sleevesByFill.has(id)) ||
        positions.some(
          ({ openingQuantity, lastLedgerQuantity, sleeve }) =>
            sleeve === 'UNATTRIBUTED' && (openingQuantity !== '0' || lastLedgerQuantity !== '0'),
        )
          ? ['UNATTRIBUTED']
          : []),
      ]),
    ]
      .sort()
      .map((sleeve) => ({ sleeve, ...metrics(undefined, sleeve) })),
    bySymbol: symbols.map((symbol) => ({ symbol, ...metrics(symbol) })),
    slippageGate,
    marketDrift: marketDrift(session),
    alerts,
    controller: { passes: session.controller.length, noAdmissibleCut, closeMarketDataUnavailable, closeWindowExpired },
    timedExitBreaches,
    regularCloseBreaches,
    eodNonFlat,
    postCloseOrderIds: postCloseOrders.map(({ id }) => id).sort(),
    postCloseFillIds: postCloseFills.map(({ id }) => id),
    evidence: {
      openingEquityMicros: session.openingEquityMicros,
      pendingFees: session.pendingFees,
      missingFillEvents: session.missingFillEvents,
      unresolvedFills,
      unverifiedDecisions: session.unverifiedDecisions,
      unresolvedOrders,
      eodEvidence,
      positionEvidence,
      brokerPositionCount: positionEvidence ? brokerPositions.size : null,
      reconciliationAt: reconciliation?.at ?? null,
      positionsAt: reconciliation?.positionsAt ?? null,
      reconciliationExact: reconciliation?.exact ?? null,
    },
    positions,
    entries: entryReports,
    protectiveStops: stopReports,
  }
}

export const analyzeProfitability = ({ sessions }: AuditInput) => ({
  schemaVersion: 'bayn.live-profitability-audit.v1' as const,
  sessions: sessions.toSorted((a, b) => byKey(a.date, b.date)).map(auditSession),
})
type Report = ReturnType<typeof analyzeProfitability>
export const renderAuditJson = (report: Report) => JSON.stringify(report, null, 2)
const money = (micros: string | null) => (micros === null ? '—' : (Number(micros) / 1_000_000).toFixed(2))
const bps = (value: number | null) => (value === null ? '—' : value.toFixed(2))
const pct = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)

export const renderAuditMarkdown = ({ sessions }: Report) =>
  [
    '# Bayn live profitability audit',
    ...sessions.flatMap((session) => {
      const { slippageGate: gate, evidence } = session
      const rows = [
        { name: 'Session', ...session.metrics },
        ...session.bySleeve.map((row) => ({ name: row.sleeve, ...row })),
        ...session.bySymbol.map((row) => ({ name: row.symbol, ...row })),
      ]
      return [
        '',
        `## ${session.date} — ${session.verdict}`,
        `Cut: ${session.asOf}; regular close: ${session.calendar?.closeAt ?? 'unknown'}.`,
        '',
        '| Scope | Gross $ | Net $ | EOD unreal. $ | Fees $ | Traded $ | Ann. turnover | Entry filled / collar missed | Entry bp signal / ref / limit (median) | Stop filled / observed triggers | Gaps |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | ---: |',
        ...rows.map(
          (row) =>
            `| ${row.name} | ${money(row.realizedMicros)} | ${money(row.netRealizedMicros)} | ${money(row.eodUnrealizedMicros)} | ${money((BigInt(row.directFeesMicros) + BigInt(row.unallocatedPostedFeesMicros)).toString())} | ${money(row.tradedNotionalMicros)} | ${pct(row.annualizedTurnoverContribution)} | ${pct(row.entryFillRate)} / ${pct(row.collarMissRate)} | ${bps(row.entryVsSignal.medianBps)} / ${bps(row.entryVsReference.medianBps)} / ${bps(row.entryVsLimit.medianBps)} | ${pct(row.stopLimitFillRate)} / ${row.observedStopCrosses} | ${row.gapThroughIncidents} |`,
        ),
        '',
        `- **${gate.cohort}** RT mean / median: ${bps(gate.meanBps)} / ${bps(gate.medianBps)} bp (${gate.samples} measured, ${gate.unmeasuredRoundTrips} unmeasured, ${gate.unmatchedFilledEntries} unmatched filled entries); < ${gate.promotionBps} bp: **${gate.promotion}**; ${gate.fullPeriodBreakevenBps} bp full-period breakeven: **${gate.fullPeriodBreakeven}**; ${gate.recentBreakevenBps} bp recent: **${gate.recentBreakeven}**.`,
        `- Controller: ${session.controller.passes} passes; NO_ADMISSIBLE_CUT: ${session.controller.noAdmissibleCut}; CLOSE_MARKET_DATA_UNAVAILABLE: ${session.controller.closeMarketDataUnavailable}; CLOSE_WINDOW_EXPIRED: ${session.controller.closeWindowExpired}.`,
        `- Alerts: ${session.alerts.join(', ') || 'none observed'}.`,
        `- Reconciliation: ${evidence.reconciliationExact === null ? 'unavailable' : evidence.reconciliationExact ? 'exact' : 'discrepancy'} at ${evidence.reconciliationAt ?? 'unknown'}; broker positions: ${evidence.brokerPositionCount ?? 'unknown'} at ${evidence.positionsAt ?? 'unknown'}; fresh EOD position evidence: ${evidence.eodEvidence ? 'yes' : 'no'}; pending fees: ${evidence.pendingFees}; working orders: ${evidence.unresolvedOrders}; unverified decisions / missing fill events / unresolved fills: ${evidence.unverifiedDecisions} / ${evidence.missingFillEvents} / ${evidence.unresolvedFills}.`,
        ...session.positions
          .filter(
            (row) =>
              row.openingQuantity !== '0' ||
              row.lastLedgerQuantity !== '0' ||
              (row.regularCloseQuantity !== null && row.regularCloseQuantity !== '0') ||
              (row.lastBrokerQuantity !== null && row.lastBrokerQuantity !== '0'),
          )
          .map(
            (row) =>
              `- **${row.symbol} inventory:** opening ${row.openingQuantity}; regular close ${row.regularCloseQuantity ?? 'unknown'}; last ledger / broker ${row.lastLedgerQuantity} / ${row.lastBrokerQuantity ?? 'unknown'}.`,
          ),
        ...session.timedExitBreaches.map(
          (row) => `- **${row.symbol} timed exit:** due ${row.dueAt}; flat ${row.flatAt ?? 'not observed'}.`,
        ),
        ...session.protectiveStops.flatMap((row) => {
          const gap = row.gapThrough
          if (gap === null) return []
          const price =
            gap.source === 'QUOTE'
              ? `${gap.feed.toUpperCase()} opposite quote $${money(gap.oppositePriceMicros)}`
              : `non-executable broker position mark $${money(gap.markPriceMicros)}`
          return [
            `- **${row.symbol} stop-limit gap-through:** stop $${money(row.stopMicros)} / limit $${money(row.limitMicros)}; ${price} at ${gap.at} with unfilled quantity.`,
          ]
        }),
        `- IEX − SIP matched minute close drift: ${
          session.marketDrift.some(({ samples }) => samples > 0)
            ? session.marketDrift
                .filter(({ samples }) => samples > 0)
                .map(
                  (row) =>
                    `${row.symbol} ${bps(row.medianBps)} bp signed / ${bps(row.absolute.medianBps)} bp absolute median (n=${row.samples})`,
                )
                .join('; ')
            : 'unavailable (no same-symbol, same-minute pairs)'
        }.`,
      ]
    }),
    ...(sessions.length === 0 ? ['', 'No sessions in the selected evidence.'] : []),
  ].join('\n')
