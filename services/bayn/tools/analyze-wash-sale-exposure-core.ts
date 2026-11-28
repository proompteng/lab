import { Data, Redacted, Result, Schema } from 'effect'

import { OrderSide } from '../src/execution/contracts'
import { intradayInstantNanos } from '../src/market-data/intraday/time'
import {
  IsoDateSchema,
  PositiveMicrosSchema,
  SymbolSchema,
  UnsignedMicrosSchema,
  UtcSourceTimestampSchema,
  strictParseOptions,
} from '../src/schemas'
import { accountTradingDate } from '../src/time'

export enum Sleeve {
  B0 = 'B0',
  F4 = 'F4',
  O1 = 'O1',
}

enum HoldingTerm {
  Short = 'short-term',
  Long = 'long-term',
}

class WashSaleAnalysisError extends Data.TaggedError('WashSaleAnalysisError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
  readonly fillNumber?: number
}> {}

export const washSaleError = (message: string, cause: unknown, fillNumber?: number) =>
  new WashSaleAnalysisError({
    message,
    cause: Redacted.make(cause),
    ...(fillNumber === undefined ? {} : { fillNumber }),
  })

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/))
const Positive = PositiveMicrosSchema.check(Schema.isMaxLength(39))
const RateBps = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))
const Fill = Schema.Struct({
  id: Id,
  accountId: Id,
  sleeve: Schema.Enum(Sleeve),
  symbol: SymbolSchema.check(Schema.makeFilter((symbol) => !symbol.includes('/'), { expected: 'an equity symbol' })),
  side: Schema.Enum(OrderSide),
  at: UtcSourceTimestampSchema.check(
    Schema.makeFilter((at) => at >= '1900', { expected: 'a UTC source timestamp in 1900 or later' }),
  ),
  quantityAtoms: Positive,
  priceAtoms: Positive,
  feeMicros: UnsignedMicrosSchema.check(Schema.isMaxLength(39)),
  specificLots: Schema.optionalKey(Schema.NonEmptyArray(Schema.Struct({ buyFillId: Id, quantityAtoms: Positive }))),
})
const Ledger = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.wash-sale-fill-ledger.v1'),
  taxYear: Schema.Int.check(Schema.isBetween({ minimum: 1900, maximum: 9999 })),
  observedThrough: IsoDateSchema,
  shortTermRateBps: RateBps,
  longTermRateBps: RateBps,
  fills: Schema.Array(Fill),
})

type Ledger = typeof Ledger.Type
type Fill = typeof Fill.Type
type TimedFill = Fill & {
  readonly number: number
  readonly instant: bigint
  readonly date: string
  readonly day: number
  readonly quantity: bigint
  readonly notional: bigint
}

// priceAtoms * quantityAtoms is USD at 18 decimal places; keep that precision in replay.
const attoPerMicro = 1_000_000_000_000n
const micros = (value: bigint) => (value / attoPerMicro).toString()
const dayMs = 86_400_000
const calendarDay = (date: string) => Date.parse(date) / dayMs
const dateOf = (day: number) => new Date(day * dayMs).toISOString().split('T')[0]
const washDays = 30
const monthUnits = 377_580 // Common denominator of 28-, 29-, 30-, and 31-day month fractions.
const monthLength = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

// Add actual holding periods, not the elapsed dates between a sale and its replacement.
// I.T. 3985 and Rev. Rul. 66-7 use calendar months and fractions, with a month-end rule.
const holdingUnits = (bought: number, sold: number) => {
  if (bought === sold) return 0
  const buy = new Date(bought * dayMs)
  const sale = new Date(sold * dayMs)
  const year = sale.getUTCFullYear()
  const month = sale.getUTCMonth()
  const length = monthLength(year, month)
  const buyDate = buy.getUTCDate()
  const atMonthEnd = buyDate === monthLength(buy.getUTCFullYear(), buy.getUTCMonth())
  const wholeMonths = (year - buy.getUTCFullYear()) * 12 + month - buy.getUTCMonth()
  const residual = sale.getUTCDate() - (atMonthEnd ? length : Math.min(buyDate, length))
  const priorLength = monthLength(year, month - 1)
  const denominator = residual < 0 && !atMonthEnd && buyDate < priorLength ? priorLength : length
  return wholeMonths * monthUnits + residual * (monthUnits / denominator)
}

type Amount = { quantity: bigint; cash: bigint }
type Part = Amount & { washBasis: bigint; carriedTerm: number }
type Lot = {
  readonly buy: TimedFill
  readonly raw: Part
  // Washed shares are distinct parts of the acquisition, consumed before the unmatched remainder.
  readonly adjusted: Part[]
  nextPart: number
}
type Match = {
  readonly replacement: TimedFill
  readonly quantity: bigint
  readonly deferred: bigint
}
type Disposition = {
  readonly buy: TimedFill
  readonly sell: TimedFill
  readonly part: Part
  readonly proceeds: bigint
  readonly termUnits: number
  readonly loss: Amount
  readonly matches: Match[]
}
type Book = {
  readonly accounts: Map<string, Map<string, Lot>>
  readonly replacements: Map<string, Lot>
  readonly pending: Set<Disposition>
}

const min = (left: bigint, right: bigint) => (left < right ? left : right)
const maxZero = (amount: bigint) => (amount > 0n ? amount : 0n)
const compareKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const compareTime = (a: TimedFill, b: TimedFill) =>
  a.instant < b.instant ? -1 : a.instant > b.instant ? 1 : compareKey(a.symbol, b.symbol)
const share = (cash: bigint, quantity: bigint, total: bigint) => (cash * quantity) / total

// Subtract the allocated value so the final slice receives any rounding remainder.
const take = (amount: Amount, quantity: bigint): Amount => {
  const cash = share(amount.cash, quantity, amount.quantity)
  amount.cash -= cash
  amount.quantity -= quantity
  return { quantity, cash }
}

const matchLoss = (sale: Disposition, lot: Lot) => {
  const quantity = min(sale.loss.quantity, lot.raw.quantity)
  const { cash: deferred } = take(sale.loss, quantity)
  lot.adjusted.push({ ...take(lot.raw, quantity), washBasis: deferred, carriedTerm: sale.termUnits })
  sale.matches.push({ replacement: lot.buy, quantity, deferred })
}

const acquire = (book: Book, buy: TimedFill) => {
  const lot: Lot = {
    buy,
    raw: {
      quantity: buy.quantity,
      cash: buy.notional + BigInt(buy.feeMicros) * attoPerMicro,
      washBasis: 0n,
      carriedTerm: 0,
    },
    adjusted: [],
    nextPart: 0,
  }
  for (const sale of book.pending) {
    if (lot.raw.quantity === 0n) break
    matchLoss(sale, lot)
    if (sale.loss.quantity === 0n) book.pending.delete(sale)
  }
  if (lot.raw.quantity > 0n) book.replacements.set(buy.id, lot)
  const inventory = book.accounts.get(buy.accountId) ?? new Map<string, Lot>()
  inventory.set(buy.id, lot)
  book.accounts.set(buy.accountId, inventory)
}

const sellLots = (book: Book, sell: TimedFill) =>
  Result.gen(function* () {
    const inventory = book.accounts.get(sell.accountId)
    const fail = (message: string, reason: string) => Result.fail(washSaleError(message, { reason }, sell.number))
    if (inventory === undefined)
      return yield* fail('Sale exceeds held quantity for its account and symbol', 'NoInventory')
    const remaining = { quantity: sell.quantity, cash: sell.notional - BigInt(sell.feeMicros) * attoPerMicro }
    const sold: Disposition[] = []
    const dispose = (lot: Lot, requested: bigint) => {
      let quantityLeft = requested
      while (quantityLeft > 0n) {
        const part = lot.adjusted[lot.nextPart] ?? lot.raw
        if (part.quantity === 0n) break
        const quantity = min(part.quantity, quantityLeft)
        const washBasis = share(part.washBasis, quantity, part.quantity)
        const slice = { ...take(part, quantity), washBasis, carriedTerm: part.carriedTerm }
        part.washBasis -= washBasis
        if (part !== lot.raw && part.quantity === 0n) lot.nextPart++
        const { cash: proceeds } = take(remaining, quantity)
        const loss = maxZero(slice.cash + washBasis - proceeds)
        sold.push({
          buy: lot.buy,
          sell,
          part: slice,
          proceeds,
          termUnits: slice.carriedTerm + holdingUnits(lot.buy.day, sell.day),
          loss: { cash: loss, quantity: loss > 0n ? quantity : 0n },
          matches: [],
        })
        quantityLeft -= quantity
      }
      if (lot.raw.quantity === 0n) {
        book.replacements.delete(lot.buy.id)
        if (lot.nextPart === lot.adjusted.length) inventory.delete(lot.buy.id)
      }
      return quantityLeft
    }

    if (sell.specificLots === undefined) {
      for (const lot of inventory.values()) {
        if (remaining.quantity === 0n) break
        dispose(lot, remaining.quantity)
      }
    } else {
      const selected = []
      const seen = new Set<string>()
      let allocated = 0n
      for (const { buyFillId, quantityAtoms } of sell.specificLots) {
        const lot = inventory.get(buyFillId)
        if (lot === undefined || seen.has(buyFillId))
          return yield* fail('Specific lot is duplicate or unavailable for this sale', 'SpecificLotUnavailable')
        const quantity = BigInt(quantityAtoms)
        selected.push({ lot, quantity })
        allocated += quantity
        seen.add(buyFillId)
      }
      if (allocated !== sell.quantity)
        return yield* fail('Specific lot quantities must cover the whole sale', 'SpecificLotQuantityMismatch')
      // Dispositions within this fill have the same time; match them in original acquisition order.
      for (const { lot, quantity } of selected.sort((a, b) => compareTime(a.lot.buy, b.lot.buy))) {
        if (dispose(lot, quantity) !== 0n)
          return yield* fail('Specific lot has insufficient remaining shares', 'SpecificLotOversold')
      }
    }
    if (remaining.quantity > 0n)
      return yield* fail('Sale exceeds held quantity for its account and symbol', 'InventoryOversold')
    return sold
  })

const applySaleLosses = (book: Book, sold: readonly Disposition[]) => {
  // Remove every disposed share first, including other lots sold in the same fill.
  for (const sale of sold) {
    for (const lot of book.replacements.values()) {
      if (sale.loss.quantity === 0n) break
      // Keeping part of the original purchase is not acquiring a replacement (Rev. Rul. 56-602).
      if (lot.buy.id === sale.buy.id) continue
      matchLoss(sale, lot)
      if (lot.raw.quantity === 0n) book.replacements.delete(lot.buy.id)
    }
    if (sale.loss.quantity > 0n) book.pending.add(sale)
  }
}

const collect = (ledger: Ledger) =>
  Result.gen(function* () {
    const observedDay = calendarDay(ledger.observedThrough)
    const fromDay = calendarDay(`${ledger.taxYear}-01-01`)
    const throughDay = Math.min(observedDay, calendarDay(`${ledger.taxYear}-12-31`))
    if (throughDay < fromDay)
      return yield* Result.fail(
        washSaleError('Fixture ends before the requested tax year', { reason: 'NoYearCoverage' }),
      )
    const fills = ledger.fills
      .map((fill, i): TimedFill => {
        const date = accountTradingDate(fill.at)
        const quantity = BigInt(fill.quantityAtoms)
        return {
          ...fill,
          number: i + 1,
          instant: intradayInstantNanos(fill.at),
          date,
          day: calendarDay(date),
          quantity,
          notional: BigInt(fill.priceAtoms) * quantity,
        }
      })
      .sort(compareTime)
    const books = new Map<string, Book>()
    const ids = new Set<string>()
    const periodFills: TimedFill[] = []
    const dispositions: Disposition[] = []
    let previous: TimedFill | undefined
    for (const fill of fills) {
      const fail = (message: string, reason: string) => Result.fail(washSaleError(message, { reason }, fill.number))
      if (ids.has(fill.id)) return yield* fail('Duplicate fill ID', 'DuplicateFill')
      if (previous?.symbol === fill.symbol && previous.instant === fill.instant)
        return yield* fail('Same-symbol fills have ambiguous execution order', 'AmbiguousOrder')
      if (fill.day > observedDay) return yield* fail('Fill is after observedThrough', 'FillAfterCoverage')
      if (fill.side === OrderSide.Buy && fill.specificLots !== undefined)
        return yield* fail('Specific lots are only valid on sales', 'SpecificLotsOnBuy')
      previous = fill
      ids.add(fill.id)
      const inPeriod = fromDay <= fill.day && fill.day <= throughDay
      if (inPeriod) periodFills.push(fill)
      const book = books.get(fill.symbol) ?? {
        accounts: new Map<string, Map<string, Lot>>(),
        replacements: new Map<string, Lot>(),
        pending: new Set<Disposition>(),
      }
      books.set(fill.symbol, book)
      // These two collections retain only unmatched candidates, in chronological order.
      for (const lot of book.replacements.values()) {
        if (fill.day - lot.buy.day <= washDays) break
        book.replacements.delete(lot.buy.id)
      }
      for (const sale of book.pending) {
        if (fill.day - sale.sell.day <= washDays) break
        book.pending.delete(sale)
      }
      if (fill.side === OrderSide.Buy) acquire(book, fill)
      else {
        const sold = yield* sellLots(book, fill)
        applySaleLosses(book, sold)
        if (inPeriod) for (const sale of sold) dispositions.push(sale)
      }
    }
    const open = [...books.values()]
      .flatMap((book) => [...book.accounts.values()].flatMap((inventory) => [...inventory.values()]))
      .sort((a, b) => compareTime(a.buy, b.buy))
    return { periodFills, dispositions, open, observedDay, throughDay }
  })

const realized = (sale: Disposition, observedDay: number) => {
  const preTax = sale.proceeds - sale.part.cash
  const beforeDeferral = preTax - sale.part.washBasis
  const deferred = maxZero(-beforeDeferral) - sale.loss.cash
  const windowEnd = sale.sell.day + washDays
  return {
    preTax,
    deferred,
    taxPnl: beforeDeferral + deferred,
    term: sale.termUnits > 12 * monthUnits ? HoldingTerm.Long : HoldingTerm.Short,
    pending: sale.loss.quantity > 0n && observedDay < windowEnd ? { ...sale.loss, windowEnd } : null,
  }
}

const summary = () => ({
  notional: 0n,
  preTax: 0n,
  deferred: 0n,
  washBasisUsed: 0n,
  pendingLoss: 0n,
  windowsComplete: true,
  shortTerm: 0n,
  longTerm: 0n,
})
type Summary = ReturnType<typeof summary>
const bucket = <Key>(map: Map<Key, Summary>, key: Key) => {
  const value = map.get(key) ?? summary()
  map.set(key, value)
  return value
}

const bpsScale = 10_000n
const reportSummary = (row: Summary, rates: Pick<Ledger, 'shortTermRateBps' | 'longTermRateBps'>) => {
  // Opposite-sign annual results offset; any remaining net loss has no modeled tax credit.
  const shortTermGain = maxZero(row.shortTerm - maxZero(-row.longTerm))
  const longTermGain = maxZero(row.longTerm - maxZero(-row.shortTerm))
  const shortTax = (shortTermGain * BigInt(rates.shortTermRateBps)) / bpsScale
  const tax = shortTax + (longTermGain * BigInt(rates.longTermRateBps)) / bpsScale
  const drag = row.notional === 0n ? null : (shortTax * bpsScale * 100n) / row.notional
  return {
    tradedNotionalMicros: micros(row.notional),
    preTaxRealizedPnlMicros: micros(row.preTax),
    washSaleDeferredMicros: micros(row.deferred),
    washSaleBasisUsedMicros: micros(row.washBasisUsed),
    pendingWashSaleLossMicros: micros(row.pendingLoss),
    washSaleWindowsComplete: row.windowsComplete,
    observedShortTermPnlMicros: micros(row.shortTerm),
    observedLongTermPnlMicros: micros(row.longTerm),
    estimatedShortTermTaxMicros: row.windowsComplete ? micros(shortTax) : null,
    estimatedTaxMicros: row.windowsComplete ? micros(tax) : null,
    postTaxRealizedPnlMicros: row.windowsComplete ? micros(row.preTax - tax) : null,
    shortTermTaxDragBps:
      row.windowsComplete && drag !== null ? `${drag / 100n}.${(drag % 100n).toString().padStart(2, '0')}` : null,
  }
}

export const analyzeWashSaleExposure = (input: unknown) =>
  Result.gen(function* () {
    const ledger = yield* Schema.decodeUnknownResult(
      Ledger,
      strictParseOptions,
    )(input).pipe(
      Result.mapError((cause) => washSaleError('Invalid fixture schema; see the wash-sale analysis runbook', cause)),
    )
    const { periodFills, dispositions, open, observedDay, throughDay } = yield* collect(ledger)
    const rates = { shortTermRateBps: ledger.shortTermRateBps, longTermRateBps: ledger.longTermRateBps }
    const total = summary()
    const sleeves = new Map<Sleeve, Summary>()
    const symbols = new Map<string, Summary>()
    const pairs = new Map<string, { sleeve: Sleeve; symbol: string; row: Summary }>()
    const summaries = ({ sleeve, symbol }: TimedFill) => {
      const key = `${sleeve}/${symbol}`
      const pair = pairs.get(key) ?? { sleeve, symbol, row: summary() }
      pairs.set(key, pair)
      return [total, bucket(sleeves, sleeve), bucket(symbols, symbol), pair.row]
    }
    for (const fill of periodFills) for (const row of summaries(fill)) row.notional += fill.notional
    const saleReports = dispositions.map((sale) => {
      const { preTax, deferred, taxPnl, term, pending } = realized(sale, observedDay)
      for (const row of summaries(sale.sell)) {
        row.preTax += preTax
        row.deferred += deferred
        row.washBasisUsed += sale.part.washBasis
        if (term === HoldingTerm.Short) row.shortTerm += taxPnl
        else row.longTerm += taxPnl
        if (pending !== null) {
          row.pendingLoss += pending.cash
          row.windowsComplete = false
        }
      }
      return {
        saleFillId: sale.sell.id,
        buyFillId: sale.buy.id,
        sleeve: sale.sell.sleeve,
        symbol: sale.sell.symbol,
        tradeDate: sale.sell.date,
        term,
        quantityAtoms: sale.part.quantity.toString(),
        netProceedsMicros: micros(sale.proceeds),
        unadjustedBasisMicros: micros(sale.part.cash),
        adjustedBasisMicros: micros(sale.part.cash + sale.part.washBasis),
        preTaxRealizedPnlMicros: micros(preTax),
        washSaleDeferredMicros: micros(deferred),
        observedTaxPnlMicros: micros(taxPnl),
        pendingReplacement:
          pending === null
            ? null
            : {
                quantityAtoms: pending.quantity.toString(),
                lossMicros: micros(pending.cash),
                windowEndsOn: dateOf(pending.windowEnd),
              },
        washMatches: sale.matches.map(({ replacement, quantity, deferred }) => ({
          replacementFillId: replacement.id,
          replacementSleeve: replacement.sleeve,
          replacementTradeDate: replacement.date,
          replacementBeforeSale: replacement.instant < sale.sell.instant,
          quantityAtoms: quantity.toString(),
          deferredLossMicros: micros(deferred),
        })),
      }
    })
    return {
      schemaVersion: 'bayn.wash-sale-exposure-report.v1',
      taxYear: ledger.taxYear,
      reportedThrough: dateOf(throughDay),
      observedThrough: ledger.observedThrough,
      ...rates,
      totals: reportSummary(total, rates),
      bySleeve: [...sleeves]
        .sort(([a], [b]) => compareKey(a, b))
        .map(([sleeve, row]) => ({ sleeve, ...reportSummary(row, rates) })),
      bySymbol: [...symbols]
        .sort(([a], [b]) => compareKey(a, b))
        .map(([symbol, row]) => ({ symbol, ...reportSummary(row, rates) })),
      bySleeveSymbol: [...pairs]
        .sort(([a], [b]) => compareKey(a, b))
        .map(([, { sleeve, symbol, row }]) => ({
          sleeve,
          symbol,
          ...reportSummary(row, rates),
        })),
      dispositions: saleReports,
      openLots: open.flatMap(({ buy, raw, adjusted, nextPart }) =>
        [...adjusted.slice(nextPart), raw]
          .filter((part) => part.quantity > 0n)
          .map((part) => ({
            buyFillId: buy.id,
            sleeve: buy.sleeve,
            symbol: buy.symbol,
            tradeDate: buy.date,
            quantityAtoms: part.quantity.toString(),
            unadjustedBasisMicros: micros(part.cash),
            adjustedBasisMicros: micros(part.cash + part.washBasis),
            deferredLossMicros: micros(part.washBasis),
          })),
      ),
    } as const
  })

type WashSaleReport = Result.Result.Success<ReturnType<typeof analyzeWashSaleExposure>>
export const renderWashSaleJson = (report: WashSaleReport) => JSON.stringify(report, null, 2)

const dollars = (value: string | null) => {
  if (value === null) return 'pending'
  const amount = BigInt(value)
  const absolute = amount < 0n ? -amount : amount
  return `${amount < 0n ? '-' : ''}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, '0')}`
}

export const renderWashSaleMarkdown = (report: WashSaleReport) => {
  const row = (cells: readonly string[]) => `| ${cells.join(' | ')} |`
  const table = (header: readonly string[], rows: readonly (readonly string[])[]) =>
    rows.length === 0 ? ['None.'] : [row(header), row(header.map(() => '---')), ...rows.map(row)]
  const summaryRow = (label: string, value: WashSaleReport['totals']) => [
    label,
    dollars(value.tradedNotionalMicros),
    dollars(value.preTaxRealizedPnlMicros),
    dollars(value.washSaleDeferredMicros),
    dollars(value.washSaleBasisUsedMicros),
    dollars(value.pendingWashSaleLossMicros),
    dollars(value.observedShortTermPnlMicros),
    dollars(value.observedLongTermPnlMicros),
    dollars(value.estimatedShortTermTaxMicros),
    dollars(value.estimatedTaxMicros),
    dollars(value.postTaxRealizedPnlMicros),
    value.shortTermTaxDragBps ?? '—',
  ]
  return [
    '# Bayn wash-sale exposure',
    '',
    `Tax year ${report.taxYear}, reported through ${report.reportedThrough}; fixture observed through ${report.observedThrough} (New York dates).`,
    `Scenario rates: ${report.shortTermRateBps} bps short-term and ${report.longTermRateBps} bps long-term. Amounts in USD.`,
    '',
    'Same-symbol taxable ledger scenario; not a filing calculation.',
    'Observed tax P&L includes matched deferrals only. Tax estimates are withheld for unresolved shares in open windows.',
    'Sleeve and symbol tax estimates are standalone; do not sum them to get the ledger estimate.',
    '',
    ...table(
      [
        'Scope',
        'Traded notional',
        'Pre-tax P&L',
        'Loss deferred',
        'Prior deferral used',
        'Loss at risk',
        'Observed ST P&L',
        'Observed LT P&L',
        'Est. ST tax',
        'Est. total tax',
        'Post-tax P&L',
        'ST drag (bps)',
      ],
      [
        summaryRow('Total', report.totals),
        ...report.bySleeve.map((value) => summaryRow(value.sleeve, value)),
        ...report.bySymbol.map((value) => summaryRow(value.symbol, value)),
        ...report.bySleeveSymbol.map((value) => summaryRow(`${value.sleeve} / ${value.symbol}`, value)),
      ],
    ),
    '',
    '## Matched replacement purchases',
    '',
    ...table(
      [
        'Sale fill',
        'Sold lot',
        'Symbol',
        'Sale sleeve',
        'Replacement fill',
        'Replacement sleeve',
        'Replacement date',
        'Timing',
        'Quantity atoms',
        'Deferred loss',
      ],
      report.dispositions.flatMap((sale) =>
        sale.washMatches.map((match) => [
          sale.saleFillId,
          sale.buyFillId,
          sale.symbol,
          sale.sleeve,
          match.replacementFillId,
          match.replacementSleeve,
          match.replacementTradeDate,
          match.replacementBeforeSale ? 'Pre-sale' : 'Post-sale',
          match.quantityAtoms,
          dollars(match.deferredLossMicros),
        ]),
      ),
    ),
    '',
    '## Unmatched loss shares inside open windows',
    '',
    ...table(
      ['Sale fill', 'Sold lot', 'Symbol', 'Sale sleeve', 'Window ends (inclusive)', 'Quantity atoms', 'Loss at risk'],
      report.dispositions.flatMap((sale) =>
        sale.pendingReplacement === null
          ? []
          : [
              [
                sale.saleFillId,
                sale.buyFillId,
                sale.symbol,
                sale.sleeve,
                sale.pendingReplacement.windowEndsOn,
                sale.pendingReplacement.quantityAtoms,
                dollars(sale.pendingReplacement.lossMicros),
              ],
            ],
      ),
    ),
    '',
    '## Open lots at the fixture cut',
    '',
    ...table(
      [
        'Buy fill',
        'Symbol',
        'Buy sleeve',
        'Buy date',
        'Quantity atoms',
        'Unadjusted basis',
        'Adjusted basis',
        'Deferred loss',
      ],
      report.openLots.map((lot) => [
        lot.buyFillId,
        lot.symbol,
        lot.sleeve,
        lot.tradeDate,
        lot.quantityAtoms,
        dollars(lot.unadjustedBasisMicros),
        dollars(lot.adjustedBasisMicros),
        dollars(lot.deferredLossMicros),
      ]),
    ),
  ].join('\n')
}
