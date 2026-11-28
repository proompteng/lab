import { blind, listingDates, parameters, universe } from './8yr-unseen-intraday-protocol'
import type { Session } from './research-lib/calendar'

const minutes = parameters.barMinutes
const stride = 6
export const enum Field {
  Open,
  High,
  Low,
  Close,
  Volume,
  Vwap,
}
export const price = (series: Float64Array, slot: number, field: Field) => series[slot * stride + field] ?? 0
export const makeSeries = (slots: number) => new Float64Array(slots * stride)

export interface Day {
  readonly date: string
  readonly slots: number
  readonly bars: ReadonlyMap<string, Float64Array>
}

export const isListed = (symbol: string, date: string) => {
  const [suspended, resumed] = parameters.listingSuspensions.SMCI
  return date >= (listingDates[symbol] ?? blind.first) && !(symbol === 'SMCI' && date >= suspended && date < resumed)
}

const registered = new Set(universe)
const blindHeader = 'symbol\tt\to\th\tl\tc\tv\tn\tvw'
const priorHeader = 'symbol\tt\to\th\tl\tc\tv\tvw'
const timestampPattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00(?:\.0+)?(?:Z|\+00:00)$/

export const readTape = async (
  calendar: readonly Session[],
  lines: AsyncIterable<string> | Iterable<string>,
  columns: 'blind' | 'prior',
  expectedRows: number,
  expectedBySymbol?: Readonly<Record<string, number>>,
) => {
  const index = new Map(calendar.map((session) => [session.date, { session, bars: new Map<string, Float64Array>() }]))
  const last = new Map<string, number>()
  const coverage = { rows: 0, regular: 0, outsideRth: 0, outsideListing: 0 }
  const counts = new Map<string, number>()
  const supported = new Set<string>()
  let row = 0
  for await (const line of lines) {
    row++
    if (row === 1 && line === (columns === 'blind' ? blindHeader : priorHeader)) continue
    const fields = line.split('\t')
    const [symbol, stamp, o, h, l, c, v] = fields
    const date = stamp?.slice(0, 10)
    const frame = index.get(date)
    if (
      fields.length !== (columns === 'blind' ? 9 : 8) ||
      !registered.has(symbol) ||
      !timestampPattern.test(stamp) ||
      frame === undefined
    ) {
      throw new Error(`Invalid ${columns} SIP bar shape, symbol or calendar date at row ${row}`)
    }
    const instant = Date.parse(stamp)
    if (!Number.isFinite(instant) || instant <= (last.get(symbol) ?? -Infinity)) {
      throw new Error(`Duplicate or out-of-order ${columns} SIP bar at row ${row} (${symbol}, ${stamp})`)
    }
    last.set(symbol, instant)
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1)
    coverage.rows++
    const slot = (instant - frame.session.openMs) / (minutes * 60_000)
    if (!Number.isInteger(slot)) throw new Error(`Off-grid ${columns} SIP bar at row ${row}`)
    if (slot < 0 || slot >= frame.session.minutes / minutes) {
      coverage.outsideRth++
      continue
    }
    if (!isListed(symbol, date)) {
      coverage.outsideListing++
      continue
    }

    const values = [o, h, l, c, v, fields.at(-1)].map(Number)
    const [open, high, low, close, volume] = values
    const trades = columns === 'blind' ? Number(fields[7]) : 1
    if (
      !values.every((value) => Number.isFinite(value) && value > 0) ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      !Number.isSafeInteger(volume) ||
      !Number.isSafeInteger(trades) ||
      trades <= 0
    ) {
      throw new Error(`Invalid ${columns} SIP OHLCV at row ${row} (${symbol}, ${stamp})`)
    }
    let series = frame.bars.get(symbol)
    if (series === undefined) {
      series = makeSeries(frame.session.minutes / minutes)
      frame.bars.set(symbol, series)
    }
    series.set(values, slot * stride)
    coverage.regular++
    supported.add(symbol)
  }

  if (coverage.rows !== expectedRows) throw new Error(`Unexpected ${columns} SIP row count: ${coverage.rows}`)
  if (expectedBySymbol !== undefined) {
    for (const symbol of registered) {
      if ((counts.get(symbol) ?? 0) !== (expectedBySymbol[symbol] ?? 0)) {
        throw new Error(`Unexpected ${columns} SIP row count for ${symbol}`)
      }
    }
  }
  return {
    days: Array.from(
      index.values(),
      ({ session, bars }): Day => ({
        date: session.date,
        slots: session.minutes / minutes,
        bars,
      }),
    ),
    coverage,
    supported,
  }
}
