import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Result, Schema } from 'effect'

import { MarketCalendarQueryBase, MarketCalendarResponseSchema } from '../src/broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import { type PriorSessionDailySummary } from '../src/market-data/intraday/trailing-baseline'
import { IsoDateSchema, strictParseOptions } from '../src/schemas'
import { intradayAlphaBenchmarkSymbol, intradayAlphaEquitySymbols } from '../src/strategy/intraday-alpha/constants'
import { intradayAlphaDefinition } from '../src/strategy/intraday-alpha/policy'
import { resolveAlphaRegularSession } from '../src/strategy/intraday-alpha/signals'

export const minuteMs = 60_000
export const warmupStart = '2026-07-16'
export const evaluationStart = '2026-08-25'
export const evaluationEnd = '2026-11-25'
export const symbols = [...intradayAlphaEquitySymbols, intradayAlphaBenchmarkSymbol]
export const checkpoints = intradayAlphaDefinition.middayReversion

const prefix = 'bayn-research-datasets/2026-11-27/'
const manifestSha256 = '3954d5f0ff79bdd280f893cfa133e12e4fccad409ff3f8c907a80410ee19e5ca'
const barFile = 'bars_1m_live_20260716_20261125.tsv.gz'
const quoteFile = 'quotes_1m_spreads_20260824_20261125.tsv.gz'
const calendarFile = 'calendar_2024_2026.json'
const quoteHeader =
  'symbol\tminute_utc\tquote_count\tfirst_bid\tfirst_ask\tlast_bid\tlast_ask\tmedian_spread_bps\tp75_spread_bps'
const digest = (content: Uint8Array) => createHash('sha256').update(content).digest('hex')

const ManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.research-dataset-manifest.v1'),
  files: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      rows: Schema.Int,
      rawBytes: Schema.Int,
      gzipBytes: Schema.Int,
      rawSha256: Schema.String,
      gzipSha256: Schema.String,
    }),
  ),
})
const CalendarSchema = Schema.Struct({
  query: MarketCalendarQueryBase,
  response: Schema.Array(
    MarketCalendarResponseSchema.value.mapFields((fields) => ({
      date: fields.date,
      open: fields.open,
      close: fields.close,
    })),
  ),
})

export interface Bar {
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly vwap: number
}

export interface Quote {
  readonly firstBid: number
  readonly firstAsk: number
  readonly lastBid: number
  readonly lastAsk: number
  readonly medianBps: number
  readonly p75Bps: number
}

export interface Tape {
  readonly bars: ReadonlyMap<number, Bar>
  readonly quotes: ReadonlyMap<number, Quote>
}

interface MutableTape {
  readonly bars: Map<number, Bar>
  readonly quotes: Map<number, Quote>
}

export interface Session {
  readonly date: string
  readonly minutes: number
  readonly tapes: ReadonlyMap<string, Tape>
  readonly daily: readonly PriorSessionDailySummary[]
}

export const linesOf = (text: string) => {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

const parseFields = (line: string, count: number) => {
  const [symbol, timestamp, ...fields] = line.split('\t')
  const at = Date.parse(timestamp ?? '')
  if (
    symbol === undefined ||
    !/^[A-Z][A-Z0-9.-]*$/.test(symbol) ||
    !Number.isFinite(at) ||
    timestamp !== new Date(at).toISOString().replace('.000Z', 'Z') ||
    at % minuteMs !== 0 ||
    fields.length !== count ||
    fields.some((value) => value.trim() === '' || !Number.isFinite(Number(value)))
  ) {
    throw new Error(`Malformed minute row: ${line}`)
  }
  return { symbol, at, date: timestamp.slice(0, 10), fields }
}

export const parseBar = (line: string) => {
  const { fields, ...key } = parseFields(line, 6)
  const [open = 0, high = 0, low = 0, close = 0, volume = 0, vwap = 0] = fields.map(Number)
  if (
    Math.min(open, high, low, close, vwap, volume) <= 0 ||
    low > Math.min(open, close) ||
    high < Math.max(open, close)
  )
    throw new Error(`Invalid bar for ${key.symbol} at ${key.at}`)
  return { ...key, value: { open, high, low, close, volume, vwap } }
}

export const parseQuote = (line: string) => {
  const { fields, ...key } = parseFields(line, 7)
  const [count = 0, firstBid = 0, firstAsk = 0, lastBid = 0, lastAsk = 0, medianBps = -1, p75Bps = -1] =
    fields.map(Number)
  if (
    !Number.isSafeInteger(count) ||
    count <= 0 ||
    Math.min(firstBid, lastBid) <= 0 ||
    firstAsk < firstBid ||
    lastAsk < lastBid ||
    medianBps < 0 ||
    p75Bps < medianBps
  )
    throw new Error(`Invalid quote for ${key.symbol} at ${key.at}`)
  return { ...key, value: { firstBid, firstAsk, lastBid, lastAsk, medianBps, p75Bps } }
}

export const dailySummaries = (date: string, tapes: ReadonlyMap<string, Tape>) => {
  const sessionDate = Schema.decodeUnknownSync(IsoDateSchema)(date)
  const rows: PriorSessionDailySummary[] = []
  for (const [symbol, tape] of tapes) {
    if (tape.bars.size < 200) continue
    const ordered = [...tape.bars.entries()].sort(([left], [right]) => left - right).map(([, bar]) => bar)
    const first = ordered[0]
    const last = ordered.at(-1)
    if (first === undefined || last === undefined) throw new Error('Empty daily summary despite minimum bar count')
    rows.push({
      symbol,
      sessionDate,
      open: first.open,
      close: last.close,
      high: Math.max(...ordered.map((bar) => bar.high)),
      low: Math.min(...ordered.map((bar) => bar.low)),
    })
  }
  return rows
}

export const regularCalendarReplayInput = (input: unknown) => {
  const { query, response } = Schema.decodeUnknownSync(CalendarSchema, strictParseOptions)(input)
  // The frozen calendar retains regular hours only. Feed those same hours to the unused extended fields.
  return {
    query,
    response: response.map((day) => ({
      ...day,
      session_open: day.open.replace(':', ''),
      session_close: day.close.replace(':', ''),
    })),
  }
}

export const decodeRegularCalendar = (input: unknown) => {
  const { query, response } = regularCalendarReplayInput(input)
  return Result.getOrThrow(normalizeMarketCalendarResult(response, query))
}

export const openFrozenBaynDataset = (directory: string, files: readonly string[]) => {
  const manifestBytes = readFileSync(join(directory, 'MANIFEST.json'))
  if (digest(manifestBytes) !== manifestSha256) throw new Error('Unexpected frozen dataset MANIFEST.json SHA-256')
  const manifest = Schema.decodeUnknownSync(ManifestSchema)(JSON.parse(manifestBytes.toString('utf8')))
  const sources = files.map((name) => {
    const entry = manifest.files.find((file) => file.key === prefix + name)
    if (entry === undefined) throw new Error(`Missing manifest entry for ${name}`)
    return entry
  })
  const read = (name: string) => {
    const receipt = sources.find((source) => source.key === prefix + name)
    if (receipt === undefined) throw new Error(`No receipt for ${name}`)
    const compressed = readFileSync(join(directory, name))
    if (compressed.length !== receipt.gzipBytes || digest(compressed) !== receipt.gzipSha256)
      throw new Error(`Frozen input SHA-256 or byte count mismatch for ${name}`)
    const raw = name.endsWith('.gz') ? gunzipSync(compressed) : compressed
    if (raw.length !== receipt.rawBytes || digest(raw) !== receipt.rawSha256)
      throw new Error(`Decompressed input SHA-256 or byte count mismatch for ${name}`)
    return { text: raw.toString('utf8'), rows: receipt.rows }
  }
  return { manifestSha256, sources, read }
}

export const readFrozenMiddayTape = (directory: string, universe: readonly string[] = symbols) => {
  const { sources, read } = openFrozenBaynDataset(directory, [calendarFile, barFile, quoteFile])
  const calendar = decodeRegularCalendar(JSON.parse(read(calendarFile).text))
  const dates = new Map(
    calendar.providerSessions
      .filter(({ date }) => date >= warmupStart && date <= evaluationEnd)
      .map(({ date }) => [
        date,
        {
          ...Result.getOrThrow(resolveAlphaRegularSession(calendar, date)),
          tapes: new Map<string, MutableTape>(),
        },
      ]),
  )
  const put = <A>(
    { symbol, at, date, value }: { symbol: string; at: number; date: string; value: A },
    select: (tape: MutableTape) => Map<number, A>,
  ) => {
    if (!universe.includes(symbol)) return
    const day = dates.get(date)
    if (day === undefined) throw new Error(`Date outside frozen calendar: ${date}`)
    if (at < day.openMs || at >= day.closeMs) return
    const minute = (at - day.openMs) / minuteMs
    const tape = day.tapes.get(symbol) ?? { bars: new Map(), quotes: new Map() }
    const map = select(tape)
    if (map.has(minute)) throw new Error(`Duplicate record: ${date} ${symbol} minute ${minute}`)
    map.set(minute, value)
    day.tapes.set(symbol, tape)
  }

  const barInput = read(barFile)
  const barRows = linesOf(barInput.text)
  if (barRows.length !== barInput.rows) throw new Error('Frozen bar row count mismatch')
  const barSymbols = new Set<string>()
  for (const line of barRows) {
    const row = parseBar(line)
    barSymbols.add(row.symbol)
    put(row, (tape) => tape.bars)
  }
  const quoteInput = read(quoteFile)
  const [header, ...quoteRows] = linesOf(quoteInput.text)
  if (header !== quoteHeader || quoteRows.length + 1 !== quoteInput.rows)
    throw new Error('Frozen quote header or row count mismatch')
  const quoteSymbols = new Set<string>()
  for (const line of quoteRows) {
    const row = parseQuote(line)
    quoteSymbols.add(row.symbol)
    put(row, (tape) => tape.quotes)
  }
  const sessions: Session[] = [...dates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, day]) => ({
      date,
      minutes: (day.closeMs - day.openMs) / minuteMs,
      tapes: day.tapes,
      daily: dailySummaries(date, day.tapes),
    }))
  if (sessions.filter(({ date }) => date >= evaluationStart).length !== 66)
    throw new Error('Expected exactly 66 evaluation calendar sessions')
  return {
    calendar,
    sources: {
      manifestSha256,
      calendarHash: calendar.normalizedResponseHash,
      files: sources,
      barSymbols: [...barSymbols].sort(),
      quoteSymbols: [...quoteSymbols].sort(),
    },
    sessions,
  }
}
