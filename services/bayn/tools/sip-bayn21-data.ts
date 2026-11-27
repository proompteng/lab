import { createHash } from 'node:crypto'
import { Result, Schema } from 'effect'

import { MarketCalendarQueryBase } from '../src/broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import { IsoDateSchema, type IsoDate } from '../src/schemas'
import { intradayAlphaBenchmarkSymbol, intradayAlphaCandidateSymbols } from '../src/strategy/intraday-alpha/policy'
import type { RawBar } from './verify-intraday-alpha-replay'

export const symbols = [...intradayAlphaCandidateSymbols, intradayAlphaBenchmarkSymbol].sort()
const symbolIndex = new Map(symbols.map((symbol, index) => [symbol, index]))
export const firstDate = '2024-01-02'
export const trainEnd = '2025-06-30'
export const validationEnd = '2026-03-31'
export const lastDate = '2026-11-25'
export const minuteMs = 60_000

const prefix = 'bayn-research-datasets/2026-11-27-sip-multiyear'
const manifestKey = `${prefix}/MANIFEST.json`
const calendarKey = 'bayn-research-datasets/2026-11-27/calendar_2024_2026.json'
const barsKey = `${prefix}/alpaca_sip_1m_rth_bayn21_20240102_20261125.tsv.gz`
const rawSha256 = '633184eed156a02dd0b97b0ce2ed1f0366312a33bde430eb83a99fbdd8bb3863'
const gzipSha256 = 'ab163eae8f0c3bc1433d2de31a3a1c6a2e404829408068b9e201f564df4ad4a2'

const calendarSchema = Schema.Struct({
  query: MarketCalendarQueryBase,
  response: Schema.Array(
    Schema.Struct({
      date: IsoDateSchema,
      open: Schema.Literal('09:30'),
      close: Schema.Literals(['13:00', '16:00']),
    }),
  ),
})

export const readRegularCalendar = (document: unknown) => {
  const source = Schema.decodeUnknownSync(calendarSchema)(document)
  // The frozen calendar only asserts RTH. Its synthetic full-session bounds
  // are set to RTH as well; they cannot admit extra prints into the replay.
  return Result.getOrThrow(
    normalizeMarketCalendarResult(
      source.response.map((row) => ({
        ...row,
        session_open: row.open.replace(':', ''),
        session_close: row.close.replace(':', ''),
      })),
      source.query,
    ),
  )
}
const manifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.sip-multiyear-dataset-manifest.v1'),
  source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=split)'),
  universes: Schema.Struct({ bayn21: Schema.Array(Schema.String) }),
  files: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      rows: Schema.Int,
      gzipBytes: Schema.Int,
      rawBytes: Schema.Int,
      gzipSha256: Schema.String,
      rawSha256: Schema.String,
    }),
  ),
})

export interface Session {
  readonly date: IsoDate
  readonly openMs: number
  readonly minutes: number
  readonly values: Float64Array
  readonly counts: Uint16Array
}

export const makeSession = (date: Session['date'], openMs: number, minutes: number): Session => ({
  date,
  openMs,
  minutes,
  // Symbol-major, followed by minute and OHLCVV. An open of zero identifies an absent bar.
  values: new Float64Array(symbols.length * minutes * 6),
  counts: new Uint16Array(symbols.length),
})

export const readBar = (session: Session, symbol: string, minute: number) => {
  const index = symbolIndex.get(symbol)
  if (index === undefined || minute < 0 || minute >= session.minutes) return undefined
  const i = (index * session.minutes + minute) * 6
  const open = session.values[i]
  return open === 0
    ? undefined
    : {
        open,
        high: session.values[i + 1],
        low: session.values[i + 2],
        close: session.values[i + 3],
        volume: session.values[i + 4],
        vwap: session.values[i + 5],
      }
}

export const sessionBars = (session: Session) =>
  new Map(
    symbols.map((symbol) => {
      const bars: RawBar[] = []
      for (let minute = 0; minute < session.minutes; minute++) {
        const values = readBar(session, symbol, minute)
        if (values === undefined) continue
        const eventMs = session.openMs + minute * minuteMs
        bars.push({ symbol, eventMs, eventAt: new Date(eventMs).toISOString(), ...values })
      }
      return [symbol, bars]
    }),
  )

export const admitRow = (line: string, sessions: ReadonlyMap<string, Session>, asOf: string) => {
  const endSymbol = line.indexOf('\t')
  const symbol = line.slice(0, endSymbol)
  const index = symbolIndex.get(symbol)
  const date = line.slice(endSymbol + 1, endSymbol + 11)
  if (index === undefined || date < firstDate || date > lastDate)
    throw new Error(`Unexpected bar identity: ${symbol} ${date}`)
  // Freeze verifies the whole object byte identity, but never decodes or retains holdout prices.
  if (date > asOf) return 'outsideStage'
  const session = sessions.get(date)
  const endTime = line.indexOf('\t', endSymbol + 1)
  const time = Date.parse(line.slice(endSymbol + 1, endTime))
  const minute = (time - (session?.openMs ?? 0)) / minuteMs
  if (session === undefined || !Number.isInteger(minute)) throw new Error(`Unexpected bar timestamp: ${symbol} ${date}`)
  if (minute < 0 || minute >= session.minutes) return 'outsideRegular'
  const cols = line
    .slice(endTime + 1)
    .split('\t')
    .map(Number)
  const [open, high, low, close] = cols
  if (
    cols.length !== 6 ||
    cols.some((value) => !Number.isFinite(value) || value <= 0) ||
    low > Math.min(open, close) ||
    high < Math.max(open, close)
  )
    throw new Error(`Invalid OHLCVV: ${symbol} ${new Date(time).toISOString()}`)
  const offset = (index * session.minutes + minute) * 6
  if (session.values[offset] !== 0) throw new Error(`Duplicate RTH bar: ${symbol} ${new Date(time).toISOString()}`)
  session.values.set(cols, offset)
  session.counts[index]++
  return 'regular'
}

export const summarizeCoverage = (sessions: readonly Session[]) => {
  const bySymbol = Object.fromEntries(
    symbols.map((symbol, index) => {
      const first = sessions.findIndex((session) => session.counts[index] > 0)
      if (first < 0) throw new Error(`No regular-session bars for ${symbol}`)
      let expectedMinutes = 0
      let observedMinutes = 0
      let sessionsWithGaps = 0
      let absentSessions = 0
      for (const session of sessions.slice(first)) {
        expectedMinutes += session.minutes
        observedMinutes += session.counts[index]
        if (session.counts[index] !== session.minutes) sessionsWithGaps++
        if (session.counts[index] === 0) absentSessions++
      }
      return [
        symbol,
        {
          firstAvailable: sessions[first].date,
          expectedMinutes,
          observedMinutes,
          missingMinutes: expectedMinutes - observedMinutes,
          sessionsWithGaps,
          absentSessions,
        },
      ]
    }),
  )
  return {
    sessions: sessions.length,
    earlyCloses: sessions.filter((session) => session.minutes < 390).map((session) => session.date),
    bySymbol,
    missingMinutes: Object.values(bySymbol).reduce((sum, row) => sum + row.missingMinutes, 0),
  }
}

const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

export const loadSip = async (s3: Bun.S3Client, asOf: string, signal: AbortSignal) => {
  const manifestBytes = await s3.file(manifestKey).bytes()
  const calendarBytes = await s3.file(calendarKey).bytes()
  const parse = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes))
  const manifest = Schema.decodeUnknownSync(manifestSchema)(parse(manifestBytes))
  const file = manifest.files.find(({ key }) => key === barsKey)
  if (
    manifest.universes.bayn21.join(',') !== symbols.join(',') ||
    file?.rawSha256 !== rawSha256 ||
    file.gzipSha256 !== gzipSha256 ||
    file.rows !== 6_491_892
  )
    throw new Error('Frozen manifest does not identify the exact SIP Bayn21 object')
  const calendar = readRegularCalendar(parse(calendarBytes))
  const sessions = new Map<string, Session>()
  for (const row of calendar.providerSessions) {
    if (row.date < firstDate || row.date > asOf) continue
    const open = Date.parse(row.regularOpenAt)
    const minutes = (Date.parse(row.regularCloseAt) - open) / minuteMs
    if (minutes !== 210 && minutes !== 390) throw new Error(`Unexpected session duration for ${row.date}`)
    sessions.set(row.date, makeSession(Schema.decodeUnknownSync(IsoDateSchema)(row.date), open, minutes))
  }
  if (!sessions.has(firstDate) || !sessions.has(asOf)) throw new Error('Calendar does not span the requested stage')
  const compressed = createHash('sha256')
  const raw = createHash('sha256')
  let compressedBytes = 0
  let rawBytes = 0
  const stream = s3
    .file(barsKey)
    .stream()
    .pipeThrough(
      new TransformStream<Uint8Array<ArrayBuffer>, BufferSource>({
        transform(chunk, controller) {
          compressed.update(chunk)
          compressedBytes += chunk.byteLength
          controller.enqueue(chunk)
        },
      }),
      { signal },
    )
    .pipeThrough(new DecompressionStream('gzip'), { signal })

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const rows = { regular: 0, outsideRegular: 0, outsideStage: 0 }
  let remainder = ''
  for await (const chunk of stream) {
    raw.update(chunk)
    rawBytes += chunk.byteLength
    // Only a chunk and its line fragments are strings; complete sessions use numeric slots.
    const lines = (remainder + decoder.decode(chunk, { stream: true })).split('\n')
    remainder = lines.pop() ?? ''
    for (const line of lines) rows[admitRow(line, sessions, asOf)]++
  }
  remainder += decoder.decode()
  if (remainder !== '') rows[admitRow(remainder, sessions, asOf)]++
  if (
    compressed.digest('hex') !== file.gzipSha256 ||
    raw.digest('hex') !== file.rawSha256 ||
    compressedBytes !== file.gzipBytes ||
    rawBytes !== file.rawBytes ||
    rows.regular + rows.outsideRegular + rows.outsideStage !== file.rows
  )
    throw new Error('Byte length, row count or SHA-256 failed frozen dataset verification')

  return {
    sessions: [...sessions.values()],
    calendar,
    rows,
    inputs: {
      bars: file,
      manifest: { key: manifestKey, sha256: sha256(manifestBytes) },
      calendar: { key: calendarKey, sha256: sha256(calendarBytes) },
    },
  }
}
