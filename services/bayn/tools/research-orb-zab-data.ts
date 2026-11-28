import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { S3Client } from 'bun'
import { Config, Data, Effect, FileSystem, Redacted, Result, Schema } from 'effect'

import { MarketCalendarQueryBase } from '../src/broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import { IsoDateSchema } from '../src/schemas'
import { intradayAlphaEquitySymbols } from '../src/strategy/intraday-alpha/constants'
import { openingRangeRelativeVolume } from '../src/strategy/intraday-alpha/stock-in-play'

export const horizons = [5, 15, 30] as const
export type Horizon = (typeof horizons)[number]
export const noiseSymbols = ['SMH', 'QQQ', 'IWM', 'SPY'] as const
export const multiSymbols = ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH', 'SPY'] as const
export const liveSymbols = intradayAlphaEquitySymbols
export const liveStart = '2026-08-25'
export const end = '2026-11-25'
const splice = '2026-09-11'
const prefix = 'bayn-research-datasets/2026-11-27/'
const longName = 'bars_1m_3yr_7sym_20240102_20260911.tsv.gz'
const liveName = 'bars_1m_live_20260716_20261125.tsv.gz'
const quotesName = 'quotes_1m_spreads_20260824_20261125.tsv.gz'
const calendarName = 'calendar_2024_2026.json'

export const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({
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
  }),
)
const decodeCalendar = Schema.decodeUnknownSync(
  Schema.Struct({
    query: MarketCalendarQueryBase,
    response: Schema.Array(
      Schema.Struct({ date: IsoDateSchema, open: Schema.Literal('09:30'), close: Schema.Literals(['13:00', '16:00']) }),
    ),
  }),
)

export interface Session {
  readonly date: string
  readonly openMs: number
  readonly minutes: number
}

export const normalizeResearchCalendar = (input: unknown): readonly Session[] => {
  const calendar = decodeCalendar(input)
  const { providerSessions } = Result.getOrThrow(
    normalizeMarketCalendarResult(
      calendar.response.map((session) => ({
        ...session,
        session_open: '0930',
        session_close: session.close.replace(':', ''),
      })),
      calendar.query,
    ),
  )
  const sessions = providerSessions.map((s) => {
    const openMs = Date.parse(s.regularOpenAt)
    const minutes = (Date.parse(s.regularCloseAt) - openMs) / 60_000
    if (minutes !== 390 && minutes !== 210) throw new Error(`Unexpected hours: ${s.date}`)
    return { date: s.date, openMs, minutes }
  })
  return sessions.toSorted((a, b) => a.date.localeCompare(b.date))
}

export interface Bar {
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly vwap: number
}
type Bars = (Bar | undefined)[]
type Raw = Map<string, Map<string, Bars>>

export const adjustSplit = (symbol: string, date: string, bar: Bar): Bar =>
  symbol === 'NVDA' && date < '2024-06-10'
    ? {
        open: bar.open / 10,
        high: bar.high / 10,
        low: bar.low / 10,
        close: bar.close / 10,
        vwap: bar.vwap / 10,
        volume: bar.volume * 10,
      }
    : bar

function* lines(text: string) {
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    if (newline < 0) {
      yield text.slice(start)
      return
    }
    yield text.slice(start, newline)
    start = newline + 1
  }
}

const parseBars = (name: string, content: string, sessions: ReadonlyMap<string, Session>, rows: number) => {
  const raw: Raw = new Map()
  let lineNo = 0
  let regular = 0
  for (const line of lines(content)) {
    lineNo++
    const [symbol, timestamp, ...fields] = line.split('\t')
    const date = timestamp?.slice(0, 10)
    const event = Date.parse(timestamp ?? '')
    const [open, high, low, close, volume, vwap] = fields.map(Number)
    if (
      fields.length !== 6 ||
      symbol.length === 0 ||
      date === undefined ||
      !Number.isFinite(event) ||
      event % 60_000 !== 0 ||
      !fields.every((field) => field.length > 0) ||
      ![open, high, low, close, volume, vwap].every((value) => Number.isFinite(value) && value > 0) ||
      high < Math.max(open, low, close) ||
      low > Math.min(open, close)
    )
      throw new Error(`Invalid bar: ${name}:${lineNo}`)
    const session = sessions.get(date)
    if (session === undefined) throw new Error(`Bar on non-session ${date}: ${name}:${lineNo}`)
    const minute = (event - session.openMs) / 60_000
    if (minute < 0 || minute >= session.minutes) continue
    let symbols = raw.get(date)
    if (symbols === undefined) raw.set(date, (symbols = new Map()))
    let bars = symbols.get(symbol)
    if (bars === undefined) symbols.set(symbol, (bars = Array.from({ length: session.minutes })))
    if (bars[minute] !== undefined) throw new Error(`Duplicate bar: ${name}:${lineNo}`)
    bars[minute] = adjustSplit(symbol, date, { open, high, low, close, volume, vwap })
    regular++
  }
  if (lineNo !== rows) throw new Error(`Unexpected row count for ${name}: ${lineNo}`)
  return { raw, regular }
}

interface Range {
  readonly open: number
  readonly close: number
  readonly high: number
  readonly low: number
  readonly volume: number | null
}
interface Features {
  readonly bars: readonly (Bar | undefined)[]
  readonly vwap: Float64Array
  readonly count: Uint16Array
  readonly ranges: ReadonlyMap<Horizon, Range>
  readonly high: number
  readonly low: number
}

export const sessionFeatures = (bars: readonly (Bar | undefined)[]): Features => {
  const vwap = new Float64Array(bars.length).fill(NaN)
  const count = new Uint16Array(bars.length + 1)
  const ranges = new Map<Horizon, Range>()
  let high = -Infinity
  let low = Infinity
  let close = NaN
  let volume = 0
  let turnover = 0
  const first = bars[0]
  for (let t = 0; t < bars.length; t++) {
    const bar = bars[t]
    count[t + 1] = count[t] + (bar === undefined ? 0 : 1)
    if (bar !== undefined) {
      high = Math.max(high, bar.high)
      low = Math.min(low, bar.low)
      close = bar.close
      turnover += bar.volume * bar.vwap
      volume += bar.volume
      vwap[t] = turnover / volume
    }
    for (const horizon of horizons) {
      if (t + 1 === horizon && first !== undefined && bar !== undefined && count[t + 1] >= Math.ceil(0.9 * horizon)) {
        ranges.set(horizon, { open: first.open, close, high, low, volume: count[t + 1] === horizon ? volume : null })
      }
    }
  }
  return { bars, vwap, count, ranges, high, low }
}

export interface SymbolDay extends Features {
  readonly atrRatio: number | null
  readonly previousClose: number | null
  readonly relativeVolumes: ReadonlyMap<Horizon, number | null>
  readonly averageSwing: Float64Array
}
export interface ResearchDay extends Session {
  readonly symbols: ReadonlyMap<string, SymbolDay>
}

export const withPriorSessions = (today: Features, prior: readonly (Features | undefined)[]): SymbolDay => {
  // Daily ATR and noise swings tolerate sparse minutes, but require actual regular opens and closes.
  let sumTr = 0
  let dailyCount = 0
  let previousClose: number | null = null
  const lastFourteen = prior.slice(-14)
  const lastFifteen = prior.slice(-15)
  for (const [index, day] of lastFifteen.entries()) {
    const open = day?.bars[0]?.open
    const close = day?.bars.at(-1)?.close
    if (day === undefined || open === undefined || close === undefined) {
      previousClose = null
      continue
    }
    const tr =
      previousClose === null
        ? day.high - day.low
        : Math.max(day.high - day.low, Math.abs(day.high - previousClose), Math.abs(day.low - previousClose))
    if ((lastFifteen.length < 15 || index > 0) && tr > 0) {
      sumTr += tr / (previousClose ?? open)
      dailyCount++
    }
    previousClose = close
  }
  const averageSwing = new Float64Array(today.bars.length).fill(NaN)
  for (let t = 0; t < averageSwing.length; t++) {
    let total = 0
    let n = 0
    for (const day of lastFourteen) {
      const open = day?.bars[0]?.open
      const close = day?.bars[t]?.close
      if (open === undefined || close === undefined) continue
      total += Math.abs(close / open - 1)
      n++
    }
    if (n >= 5) averageSwing[t] = total / n
  }
  const relativeVolumes = new Map(
    horizons.map((horizon) => [
      horizon,
      openingRangeRelativeVolume(
        today.ranges.get(horizon)?.volume ?? null,
        lastFourteen.map((day) => day?.ranges.get(horizon)?.volume ?? null),
      ),
    ]),
  )
  return {
    ...today,
    atrRatio: dailyCount >= 5 ? sumTr / dailyCount : null,
    previousClose,
    averageSwing,
    relativeVolumes,
  }
}

const panel = (
  sessions: readonly Session[],
  symbols: readonly string[],
  source: (date: string) => ReadonlyMap<string, Bars> | undefined,
): readonly ResearchDay[] => {
  const history = new Map<string, (Features | undefined)[]>(symbols.map((symbol) => [symbol, []]))
  return sessions.map((session) => {
    const result = new Map<string, SymbolDay>()
    const raw = source(session.date)
    for (const [symbol, days] of history) {
      const bars = raw?.get(symbol)
      const today = sessionFeatures(bars ?? Array.from({ length: session.minutes }))
      result.set(symbol, withPriorSessions(today, days))
      days.push(today)
      if (days.length > 15) days.shift()
    }
    return { ...session, symbols: result }
  })
}

const quoteDiagnostic = (content: string, rows: number, sessions: ReadonlyMap<string, Session>) => {
  let count = 0
  const bySymbol = new Map<string, number[]>()
  for (const line of lines(content)) {
    count++
    if (count === 1) {
      if (
        line !==
        'symbol\tminute_utc\tquote_count\tfirst_bid\tfirst_ask\tlast_bid\tlast_ask\tmedian_spread_bps\tp75_spread_bps'
      ) {
        throw new Error('Unexpected IEX spread header')
      }
      continue
    }
    const [symbol, timestamp, quotes, , , , , spread, , ...extra] = line.split('\t')
    const date = timestamp?.slice(0, 10)
    const value = Number(spread)
    const event = Date.parse(timestamp ?? '')
    if (
      date === undefined ||
      !Number.isFinite(event) ||
      !Number.isFinite(value) ||
      spread === '' ||
      value < 0 ||
      !Number.isInteger(Number(quotes)) ||
      Number(quotes) < 1 ||
      extra.length !== 0
    ) {
      throw new Error(`Invalid IEX spread on line ${count}`)
    }
    const session = sessions.get(date)
    if (
      session === undefined ||
      date < liveStart ||
      event < session.openMs ||
      event >= session.openMs + session.minutes * 60_000
    )
      continue
    let pool = bySymbol.get(symbol)
    if (pool === undefined) bySymbol.set(symbol, (pool = []))
    pool.push(value)
  }
  if (count !== rows) throw new Error(`Unexpected IEX spread row count: ${count}`)
  return Object.fromEntries(
    [...bySymbol]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([symbol, pool]) => {
        pool.sort((a, b) => a - b)
        const at = (q: number) => pool[Math.floor(q * (pool.length - 1))]
        return [symbol, { minutes: pool.length, medianBps: at(0.5), p75Bps: at(0.75), p90Bps: at(0.9) }]
      }),
  )
}

export class ResearchEvidenceError extends Data.TaggedError('ResearchEvidenceError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const objectReader = (directory: string) =>
  Effect.gen(function* () {
    if (directory !== '--s3') {
      const fs = yield* FileSystem.FileSystem
      return (name: string) => fs.readFile(join(directory, name))
    }
    const endpoint = yield* Config.NonEmptyString('AGENTS_ARTIFACTS_ENDPOINT').pipe(
      Config.withDefault('http://rook-ceph-rgw-objectstore.rook-ceph.svc:80'),
    )
    const bucket = yield* Config.NonEmptyString('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('agents-artifacts'))
    const accessKeyId = yield* Config.Redacted('AWS_ACCESS_KEY_ID')
    const secretAccessKey = yield* Config.Redacted('AWS_SECRET_ACCESS_KEY')
    const s3 = new S3Client({
      endpoint,
      bucket,
      accessKeyId: Redacted.value(accessKeyId),
      secretAccessKey: Redacted.value(secretAccessKey),
      region: 'us-east-1',
    })
    return (name: string) =>
      Effect.tryPromise({
        try: async (signal) => {
          const url = s3.presign(prefix + name, { expiresIn: 300 })
          const response = await fetch(url, { signal, redirect: 'error', decompress: false })
          if (!response.ok) {
            await response.body?.cancel()
            throw new ResearchEvidenceError({ message: `S3 read failed for ${name}: HTTP ${response.status}` })
          }
          return new Uint8Array(await response.arrayBuffer())
        },
        // A transport error may embed the signed URL. Keep the object and error class, not the URL.
        catch: (error) =>
          error instanceof ResearchEvidenceError
            ? error
            : new ResearchEvidenceError({
                message: `S3 transport failed for ${name}`,
                cause: error instanceof Error ? error.name : 'Unknown transport failure',
              }),
      })
  })

export const readResearchData = (directory: string, includeHoldout: boolean) =>
  Effect.gen(function* () {
    const get = yield* objectReader(directory)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const manifestBytes = yield* get('MANIFEST.json')
    const manifestHash = sha256(manifestBytes)
    if (manifestHash !== '3954d5f0ff79bdd280f893cfa133e12e4fccad409ff3f8c907a80410ee19e5ca')
      return yield* new ResearchEvidenceError({ message: 'Frozen manifest SHA-256 mismatch' })
    const manifest = decodeManifest(JSON.parse(decoder.decode(manifestBytes)))
    const receipts = [calendarName, longName, liveName, quotesName].map((name) => {
      const receipt = manifest.files.find((file) => file.key === prefix + name)
      if (receipt === undefined) throw new Error(`Missing receipt: ${name}`)
      return receipt
    })
    const read = (name: string) =>
      Effect.gen(function* () {
        const receipt = receipts.find((entry) => entry.key === prefix + name)
        if (receipt === undefined) throw new Error(`Missing receipt: ${name}`)
        const bytes = yield* get(name)
        if (bytes.length !== receipt.gzipBytes || sha256(bytes) !== receipt.gzipSha256) {
          return yield* new ResearchEvidenceError({ message: `Frozen object mismatch: ${name}` })
        }
        const decoded = name.endsWith('.gz') ? gunzipSync(bytes) : bytes
        if (decoded.length !== receipt.rawBytes || sha256(decoded) !== receipt.rawSha256) {
          return yield* new ResearchEvidenceError({ message: `Decompressed object mismatch: ${name}` })
        }
        return { text: decoder.decode(decoded), rows: receipt.rows }
      })
    const calendar = yield* read(calendarName)
    const sessions = normalizeResearchCalendar(JSON.parse(calendar.text)).filter((s) => s.date <= end)
    const byDate = new Map(sessions.map((s) => [s.date, s]))
    if (sessions.length !== 729 || byDate.size !== sessions.length) throw new Error('Unexpected calendar coverage')
    const readBars = (name: string) =>
      read(name).pipe(Effect.map(({ text, rows }) => parseBars(name, text, byDate, rows)))
    const long = yield* readBars(longName)
    const live = includeHoldout ? yield* readBars(liveName) : undefined
    const quotes = includeHoldout ? yield* read(quotesName) : undefined
    const multiDays = panel(
      sessions.filter((day) => includeHoldout || day.date <= '2026-03-31'),
      multiSymbols,
      (date) => (date <= splice ? long.raw.get(date) : live?.raw.get(date)),
    )
    const liveDays =
      live === undefined
        ? []
        : panel(
            sessions.filter((day) => day.date >= '2026-07-16'),
            [...liveSymbols, ...noiseSymbols],
            (date) => live.raw.get(date),
          ).filter((day) => day.date >= liveStart)
    if (includeHoldout && liveDays.length !== 66) throw new Error('Unexpected live session count')
    return {
      provenance: {
        manifestHash,
        receipts,
        spliceThrough: splice,
        longRegularRows: long.regular,
        liveRegularRows: live?.regular,
      },
      multiDays,
      liveDays,
      iexDiagnostic: quotes === undefined ? null : quoteDiagnostic(quotes.text, quotes.rows, byDate),
    }
  })
