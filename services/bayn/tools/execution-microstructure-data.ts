import { Result } from 'effect'
import { utcInstantFromEpochMillis } from '../src/time'
import { intradayAlphaBenchmarkSymbol, intradayAlphaCandidateSymbols } from '../src/strategy/intraday-alpha/constants'
import { resolveAlphaRegularSession } from '../src/strategy/intraday-alpha/signals'
import {
  decodeRegularCalendar,
  linesOf,
  minuteMs,
  openFrozenBaynDataset,
  parseBar,
  type Bar,
} from './midday-research-data'
import type { RawBar } from './verify-intraday-alpha-replay'

const historicalFile = 'bars_1m_3yr_7sym_20240102_20260911.tsv.gz'
const calendarFile = 'calendar_2024_2026.json'
const universe = new Set([...intradayAlphaCandidateSymbols, intradayAlphaBenchmarkSymbol])

export const splitAdjustedBar = (symbol: string, date: string, bar: RawBar): RawBar =>
  symbol === 'NVDA' && date < '2024-06-10'
    ? {
        ...bar,
        open: bar.open / 10,
        high: bar.high / 10,
        low: bar.low / 10,
        close: bar.close / 10,
        vwap: bar.vwap / 10,
        volume: bar.volume * 10,
      }
    : bar

export const readHistoricalMicrostructureBars = (directory: string) => {
  const { read, sources } = openFrozenBaynDataset(directory, [calendarFile, historicalFile])
  const calendar = decodeRegularCalendar(JSON.parse(read(calendarFile).text))
  const bounds = new Map<string, ReturnType<typeof resolveAlphaRegularSession>>()
  for (const { date } of calendar.providerSessions) bounds.set(date, resolveAlphaRegularSession(calendar, date))

  const byDate = new Map<string, Map<string, RawBar[]>>()
  const symbols = new Set<string>()
  let splitAdjustedRows = 0
  const source = read(historicalFile)
  const lines = linesOf(source.text)
  if (lines.length !== source.rows) throw new Error('Frozen historical bar row count mismatch')
  for (const line of lines) {
    const { symbol, date, at, value } = parseBar(line)
    const day = bounds.get(date)
    if (day === undefined) throw new Error(`Historical bar is outside the exchange calendar: ${date}`)
    const { openMs, closeMs } = Result.getOrThrow(day)
    if (at < openMs || at >= closeMs || !universe.has(symbol)) continue
    symbols.add(symbol)
    const symMap = byDate.get(date) ?? new Map<string, RawBar[]>()
    const bars = symMap.get(symbol) ?? []
    const rawBar = { symbol, eventAt: utcInstantFromEpochMillis(at), eventMs: at, ...value }
    const bar = splitAdjustedBar(symbol, date, rawBar)
    if (bar !== rawBar) splitAdjustedRows++
    if (at <= (bars.at(-1)?.eventMs ?? 0)) throw new Error(`Duplicate or unordered historical bar: ${symbol} ${date}`)
    bars.push(bar)
    symMap.set(symbol, bars)
    byDate.set(date, symMap)
  }
  return { calendar, byDate, splitAdjustedRows, symbols: [...symbols].sort(), sources }
}

export const asReplayBar = (symbol: string, start: number, minute: number, value: Bar): RawBar => {
  const eventMs = start + minute * minuteMs
  return { ...value, symbol, eventMs, eventAt: utcInstantFromEpochMillis(eventMs) }
}
