import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { intradayAlphaEquitySymbols } from '../src/strategy/intraday-alpha/constants'

export const objectKey =
  'bayn-research-datasets/2026-11-27-sip-multiyear/alpaca_sip_daily_62sym_20210104_20261125.tsv.gz'
export const tapeHash = 'e8023075922737f98d9a792267bb02940246971918387a877be92c2ad443b247'
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export const splits = {
  train: ['2021-01-04', '2024-06-30'],
  validation: ['2024-07-01', '2025-08-31'],
  holdout: ['2025-09-01', '2026-11-25'],
} as const
export type Split = keyof typeof splits

const liveEtfs = ['IWM', 'QQQ', 'SMH', 'SPY']
const etfs = [...liveEtfs, 'ARKK', 'GLD', 'IEF', 'TLT', 'USO', 'XBI', 'XLE', 'XLF', 'XLI', 'XLK', 'XLV', 'XLY']
const additional = [
  'ALAB',
  'AMAT',
  'ANET',
  'APP',
  'ARM',
  'ASML',
  'CEG',
  'COIN',
  'CRDO',
  'CRWD',
  'GEV',
  'HOOD',
  'KLAC',
  'LRCX',
  'MSTR',
  'NET',
  'NOW',
  'ORCL',
  'PANW',
  'PLTR',
  'SHOP',
  'SMCI',
  'SNOW',
  'SOFI',
  'SPOT',
  'TSM',
  'UBER',
  'VRT',
  'VST',
]
const liveStocks = intradayAlphaEquitySymbols.filter((symbol) => !liveEtfs.includes(symbol))
const expandedStocks = [...liveStocks, ...additional]
export const universes = {
  expanded: [...expandedStocks, ...liveEtfs].sort(),
  live: [...intradayAlphaEquitySymbols].sort(),
  'expanded-stocks': expandedStocks.sort(),
  'live-stocks': liveStocks.sort(),
  etfs: etfs.sort(),
  'live-etfs': liveEtfs.sort(),
}
export type Universe = keyof typeof universes

export const symbols = [...new Set([...expandedStocks, ...etfs])].sort()
const firstRegularTrading = new Map([
  ['COIN', '2021-04-14'],
  ['APP', '2021-04-15'],
  ['SOFI', '2021-06-01'],
  ['HOOD', '2021-07-29'],
  ['CRDO', '2022-01-27'],
  ['CEG', '2022-02-02'],
  ['COHR', '2022-09-08'],
  ['ARM', '2023-09-14'],
  ['ALAB', '2024-03-20'],
  ['GEV', '2024-04-02'],
  ['SNDK', '2025-02-24'],
])
export const wdcExit = '2025-02-21'
export const wdcReset = '2025-02-24'
const isoDayMs = 86_400_000

export interface Bar {
  open: number
  close: number
  volume: number
}
export interface Series {
  bars: readonly (Bar | undefined)[]
  daily: Float64Array
  overnight: Float64Array
}
export interface Tape {
  dates: readonly string[]
  calendarDays: readonly number[]
  prices: ReadonlyMap<string, Series>
  excluded: Readonly<Record<string, number>>
  rowsRead: number
}

export function parseTape(input: string, cutoff: string, expectedSymbols: readonly string[] = symbols): Tape {
  const bySymbol = new Map(expectedSymbols.map((symbol) => [symbol, new Map<string, Bar>()]))
  const excluded: Record<string, number> = {}
  const seen = new Set<string>()
  let rowsRead = 0
  for (const row of input.trimEnd().split('\n')) {
    const [symbol, event, ...fields] = row.split('\t')
    const date = event?.slice(0, 10)
    if (date !== undefined && date > cutoff) continue
    const prices = bySymbol.get(symbol)
    const time = Date.parse(event)
    if (
      prices === undefined ||
      date === undefined ||
      !/^\d{4}-\d{2}-\d{2}T0[45]:00:00Z$/.test(event) ||
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== date ||
      date < splits.train[0] ||
      fields.length !== 6 ||
      seen.has(`${symbol}/${date}`) ||
      fields.some((field) => field.trim() === '' || !(Number(field) > 0) || !Number.isFinite(Number(field)))
    )
      throw new Error(`Invalid or duplicate SIP bar for ${symbol} at ${event}`)
    seen.add(`${symbol}/${date}`)
    rowsRead++
    const [open, high, low, close, volume, vwap] = fields.map(Number)
    if (Math.max(open, close, vwap) > high + 0.01 || Math.min(open, close, vwap) < low - 0.01) {
      throw new Error(`Invalid SIP OHLCV range for ${symbol} at ${event}`)
    }
    const listing = firstRegularTrading.get(symbol)
    if (listing !== undefined && date < listing) {
      excluded[symbol] = (excluded[symbol] ?? 0) + 1
      continue
    }
    prices.set(date, { open, close, volume })
  }
  const spy = bySymbol.get('SPY')
  if (spy === undefined || spy.size === 0) throw new Error('Missing SPY session index')
  const dates = [...spy.keys()].sort()
  const prices = new Map<string, Series>()
  for (const [symbol, rows] of bySymbol) {
    if (rows.size === 0 || [...rows.keys()].some((date) => !spy.has(date))) {
      throw new Error(`Missing ${symbol} coverage or session absent from SPY`)
    }
    const bars = dates.map((date) => rows.get(date))
    const daily = new Float64Array(dates.length).fill(NaN)
    const overnight = new Float64Array(dates.length).fill(NaN)
    for (let i = 1; i < dates.length; i++) {
      const current = bars[i]
      const previous = bars[i - 1]
      if (current === undefined || previous === undefined || (symbol === 'WDC' && dates[i] === wdcReset)) continue
      daily[i] = Math.log(current.close / previous.close)
      overnight[i] = Math.log(current.open / previous.close)
    }
    prices.set(symbol, { bars, daily, overnight })
  }
  return { dates, calendarDays: dates.map((date) => Date.parse(date) / isoDayMs), prices, excluded, rowsRead }
}

export function readTape(bytes: Uint8Array, stage: 'freeze' | 'score') {
  if (sha256(bytes) !== tapeHash) throw new Error('Frozen SIP gzip SHA-256 does not match protocol')
  const tape = parseTape(gunzipSync(bytes).toString('utf8'), splits[stage === 'freeze' ? 'validation' : 'holdout'][1])
  const train = splitBounds(tape, 'train')
  const validation = splitBounds(tape, 'validation')
  if (
    train.end !== 877 ||
    validation.end !== 1170 ||
    (stage === 'score' && (tape.dates.length !== 1482 || tape.rowsRead !== 87727))
  ) {
    throw new Error('Frozen SIP session/row counts do not match protocol')
  }
  return tape
}

export function splitBounds(tape: Tape, split: Split) {
  const [first, last] = splits[split]
  const start = tape.dates.findIndex((date) => date >= first && date <= last)
  if (start < 0) throw new Error(`No sessions in ${split}`)
  return { start, end: tape.dates.findLastIndex((date) => date <= last) + 1 }
}

export function seriesFor(tape: Tape, symbol: string) {
  const series = tape.prices.get(symbol)
  if (series === undefined) throw new Error(`Missing symbol in tape: ${symbol}`)
  return series
}
