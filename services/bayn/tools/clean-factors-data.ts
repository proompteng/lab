import { createHash } from 'node:crypto'
import { Schema } from 'effect'

export const manifestSha256 = 'ffaa9d30d69d38307f69ec77f07c12cdd82c7407131a110bc3b88421b0f1676e'
export const gzipSha256 = 'fdda4017ee662fae548d8111a970ea90d83b3e8ee6f61abd6153be0fe83547d2'
export const filename = 'alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz'
export const splits = {
  train: ['2016-01-04', '2021-12-31', 1511],
  validation: ['2022-01-03', '2023-12-29', 501],
  holdout: ['2024-01-02', '2026-11-25', 729],
} as const
export type Split = keyof typeof splits
export const sectors = ['XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY'] as const
export type Sector = (typeof sectors)[number]
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

const Manifest = Schema.Struct({
  totalSymbols: Schema.Finite,
  sectorMap: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  etfs: Schema.Array(Schema.String),
})

export function decodeUniverse(manifest: string) {
  if (sha256(manifest) !== manifestSha256) throw new Error('Unregistered manifest checksum')
  const { totalSymbols, sectorMap, etfs } = Schema.decodeUnknownSync(Manifest)(JSON.parse(manifest))
  const sectorByStock = new Map<string, Sector>()
  for (const sector of sectors) {
    for (const symbol of sectorMap[sector]) {
      if (sectorByStock.has(symbol)) throw new Error(`Duplicate equity: ${symbol}`)
      sectorByStock.set(symbol, sector)
    }
  }
  if (
    !sectorByStock.delete('MMC') ||
    sectorByStock.has('MRSH') ||
    sectorByStock.size !== 137 ||
    etfs.length !== 27 ||
    new Set([...sectorByStock.keys(), ...etfs]).size !== 164 ||
    totalSymbols !== 165
  ) {
    throw new Error('Unexpected dataset universe')
  }
  return { sectorByStock, etfs }
}

export type Universe = ReturnType<typeof decodeUniverse>
export type Bar = { open: number; high: number; close: number }
export type Tape = {
  dates: string[]
  bars: ReadonlyMap<string, readonly (Bar | undefined)[]>
  universe: Universe
}

export const rtxExit = '2020-03-31'
export const rtxResume = '2020-04-06'
const rtxBlocked = (symbol: string, date: string) => symbol === 'RTX' && date >= rtxExit && date < rtxResume

export function readTape(raw: string, universe: Universe, through: string) {
  const symbols = [...universe.sectorByStock.keys(), ...universe.etfs]
  const bySymbol = new Map(symbols.map((symbol) => [symbol, new Map<string, Bar>()]))
  let sourceRows = 0
  let mmcRows = 0
  for (const line of raw.trimEnd().split('\n')) {
    const [symbol, timestamp, o, h, l, c, volume, vwap, extra] = line.split('\t')
    if (timestamp === undefined) throw new Error(`Missing session timestamp: ${symbol}`)
    const date = timestamp.slice(0, 10)
    if (date > through) continue
    sourceRows++
    if (symbol === 'MMC') {
      mmcRows++
      continue
    }
    const rows = bySymbol.get(symbol)
    const [open, high, low, close, shares, weighted] = [o, h, l, c, volume, vwap].map(Number)
    if (
      rows === undefined ||
      extra !== undefined ||
      !/^\d{4}-\d{2}-\d{2}T0[45]:00:00Z$/.test(timestamp) ||
      rows.has(date) ||
      ![open, high, low, close, shares, weighted].every(Number.isFinite) ||
      Math.min(open, high, low, close, weighted) <= 0 ||
      shares < 0 ||
      high < low
    ) {
      throw new Error(`Invalid or duplicate daily bar: ${symbol} ${timestamp}`)
    }
    rows.set(date, { open, high, close })
  }
  const dates = [...(bySymbol.get('SPY')?.keys() ?? [])].sort()
  const sessionSet = new Set(dates)
  const bars = new Map<string, (Bar | undefined)[]>()
  const coverage = Object.fromEntries(
    [...bySymbol].map(([symbol, rows]) => {
      const observed = [...rows.keys()].sort()
      if (observed.length === 0 || observed.some((date) => !sessionSet.has(date))) {
        throw new Error(`Invalid SPY calendar alignment: ${symbol}`)
      }
      bars.set(
        symbol,
        dates.map((date) => rows.get(date)),
      )
      return [symbol, { first: observed[0], last: observed[observed.length - 1], sessions: observed.length }]
    }),
  )
  if (bars.get('SHY')?.some((bar) => bar === undefined) !== false)
    throw new Error('SHY benchmark must cover every session')
  return { tape: { dates, bars, universe } satisfies Tape, sourceRows, mmcRows, coverage }
}

export function splitBounds(tape: Tape, split: Split) {
  const [start, end, sessions] = splits[split]
  const first = tape.dates.indexOf(start)
  const last = tape.dates.indexOf(end)
  if (first < 0 || last - first + 1 !== sessions) throw new Error(`Invalid ${split} session count or boundaries`)
  return { first, last }
}

export function requiredBar(tape: Tape, symbol: string, day: number) {
  const bar = tape.bars.get(symbol)?.[day]
  if (bar === undefined) throw new Error(`Missing required ${symbol} bar: ${tape.dates[day]}`)
  return bar
}

export const jump = (previous: number, current: number) => current / previous < 0.5 || current / previous > 2

// Start of the latest contiguous, unbroken signal history, using only the observed prefix.
export function historyStarts(tape: Tape, symbol: string) {
  let start = 0
  const bars = tape.bars.get(symbol) ?? []
  return tape.dates.map((date, day) => {
    const bar = bars[day]
    const previous = bars[day - 1]
    if (bar === undefined || rtxBlocked(symbol, date)) {
      start = day + 1
    } else if (previous !== undefined && jump(previous.close, bar.open)) {
      start = day
    }
    return start
  })
}
