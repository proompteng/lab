import { gunzipSync } from 'node:zlib'
import type { S3Client } from 'bun'
import { Schema } from 'effect'
import { readTape as readWave2Tape, objectKey, symbols } from './daily-alpha-data'
import { etfs } from './master-portfolio-etf'
import { normalizeResearchCalendar, sha256, type Session } from './research-orb-zab-data'

const prefix = 'bayn-research-datasets/2026-11-27'
const longManifest = `${prefix}-sip-10yr-sp100/MANIFEST.json`
const longDaily = `${prefix}-sip-10yr-sp100/alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz`
const multiManifest = `${prefix}-sip-multiyear/MANIFEST.json`
const fiveMinute = `${prefix}-sip-multiyear/alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz`
const calendarKey = `${prefix}/calendar_2024_2026.json`
const manifestHashes = {
  [longManifest]: 'ffaa9d30d69d38307f69ec77f07c12cdd82c7407131a110bc3b88421b0f1676e',
  [multiManifest]: '5df0cfe213c69e9a6489dde46553db610edb2632b5e54fb76a6347740abcdead',
  [calendarKey]: 'b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71',
}
const firstDay = '2024-01-02'
export const lastDay = '2026-11-25'
const listings: Readonly<Record<string, string>> = { ALAB: '2024-03-20', GEV: '2024-04-02', SNDK: '2025-02-24' }
const sectors = ['XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB']
const fileSchema = Schema.Struct({
  key: Schema.String,
  rows: Schema.Int,
  gzipBytes: Schema.Int,
  rawBytes: Schema.Int,
  gzipSha256: Schema.String,
  rawSha256: Schema.String,
})
const longSchema = Schema.Struct({
  files: Schema.Array(fileSchema),
  sectorMap: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  etfs: Schema.Array(Schema.String),
  totalSymbols: Schema.Literal(165),
})
const multiSchema = Schema.Struct({
  files: Schema.Array(fileSchema),
  universes: Schema.Struct({ all62: Schema.Array(Schema.String) }),
})
const decoder = new TextDecoder('utf-8', { fatal: true })

function verify(bytes: Uint8Array, hash: string, key: string, size = bytes.length) {
  if (size !== bytes.length || sha256(bytes) !== hash) throw new Error(`Frozen object mismatch: ${key}`)
}

async function fetchBytes(s3: S3Client, key: string, signal: AbortSignal) {
  try {
    const response = await fetch(s3.presign(key, { expiresIn: 300 }), { signal, redirect: 'error', decompress: false })
    if (response.ok) return new Uint8Array(await response.arrayBuffer())
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status}`)
  } catch (error) {
    // Never propagate a transport exception containing a signed URL.
    const status = error instanceof Error && /^HTTP [0-9]{3}$/.test(error.message) ? `: ${error.message}` : ''
    throw new Error(`S3 read failed for ${key}${status}`)
  }
}

export async function loadResearchData(s3: S3Client, signal: AbortSignal) {
  const json = async (key: keyof typeof manifestHashes): Promise<unknown> => {
    const bytes = await fetchBytes(s3, key, signal)
    verify(bytes, manifestHashes[key], key)
    return JSON.parse(decoder.decode(bytes))
  }
  const [long, multi, calendar] = await Promise.all([
    json(longManifest).then(Schema.decodeUnknownSync(longSchema)),
    json(multiManifest).then(Schema.decodeUnknownSync(multiSchema)),
    json(calendarKey).then(normalizeResearchCalendar),
  ])
  const stockGroups = sectors.map((sector) => long.sectorMap[sector])
  if (
    Object.keys(long.sectorMap).length !== sectors.length ||
    stockGroups.flat().length !== 138 ||
    long.etfs.toSorted().join('/') !== [...etfs].sort().join('/') ||
    multi.universes.all62.toSorted().join('/') !== symbols.join('/') ||
    calendar.length !== 729 ||
    calendar[0]?.date !== firstDay ||
    calendar.at(-1)?.date !== lastDay
  )
    throw new Error('Unexpected frozen universe or calendar')

  const unpack = async (files: readonly (typeof fileSchema.Type)[], key: string) => {
    const receipt = files.find((file) => file.key === key)
    if (receipt === undefined) throw new Error(`Missing frozen receipt for ${key}`)
    const bytes = await fetchBytes(s3, key, signal)
    verify(bytes, receipt.gzipSha256, key, receipt.gzipBytes)
    const raw = gunzipSync(bytes)
    verify(raw, receipt.rawSha256, key, receipt.rawBytes)
    return { receipt, bytes, raw }
  }
  const daily = await unpack(long.files, longDaily)
  const longTape = parseSp100(decoder.decode(daily.raw), stockGroups)
  const wave2 = await unpack(multi.files, objectKey)
  const stockTape = readWave2Tape(wave2.bytes, 'score')
  const minute = await unpack(multi.files, fiveMinute)
  const intraday = parseFiveMinute(calendar, lines(decoder.decode(minute.raw)))
  if (
    longTape.rows !== daily.receipt.rows ||
    longTape.dates.length !== 2741 ||
    longTape.dates[0] !== '2016-01-04' ||
    longTape.dates.at(-1) !== lastDay ||
    stockTape.rowsRead !== wave2.receipt.rows ||
    intraday.row !== minute.receipt.rows ||
    longTape.dates.filter((date) => date >= firstDay).join('/') !== calendar.map(({ date }) => date).join('/') ||
    longTape.dates.filter((date) => date >= '2021-01-04').join('/') !== stockTape.dates.join('/')
  )
    throw new Error('Frozen tapes do not match their row and date receipts')
  return {
    longTape,
    stockTape,
    intraday,
    calendar,
    provenance: {
      manifests: manifestHashes,
      daily: [daily.receipt, wave2.receipt],
      intraday5m: minute.receipt,
    },
  }
}

type Series = {
  symbol: string
  open: Float64Array
  close: Float64Array
}
export type Sp100Tape = {
  dates: string[]
  series: Series[]
  spy: number
  stockSectors: number[][]
  sectorEtfs: number[]
  rows: number
}

function* lines(content: string) {
  let start = 0
  while (start < content.length) {
    const end = content.indexOf('\n', start)
    if (end === -1) {
      yield content.slice(start)
      return
    }
    yield content.slice(start, end)
    start = end + 1
  }
}

function parseSp100(content: string, stockGroups: readonly (readonly string[])[]): Sp100Tape {
  const symbols = [...stockGroups.flat(), ...etfs]
  const ids = new Map(symbols.map((symbol, i) => [symbol, i]))
  const index = (symbol: string) => {
    const id = ids.get(symbol)
    if (id === undefined) throw new Error(`Missing universe symbol: ${symbol}`)
    return id
  }
  if (ids.size !== symbols.length) throw new Error('Duplicate universe symbol')
  const spy = index('SPY')
  const dates: string[] = []
  let previous = ''
  for (const line of lines(content)) {
    if (!line.startsWith('SPY\t')) continue
    const date = line.slice(4, 14)
    if (date <= previous) throw new Error(`SPY calendar not strictly increasing: ${date}`)
    dates.push(date)
    previous = date
  }
  const sessions = new Map(dates.map((date, i) => [date, i]))
  const series: Series[] = symbols.map((symbol) => ({
    symbol,
    open: new Float64Array(dates.length),
    close: new Float64Array(dates.length),
  }))
  let rows = 0
  const latest: number[] = []
  for (const line of lines(content)) {
    const tab = line.indexOf('\t')
    const date = line.slice(tab + 1, tab + 11)
    const [symbol, time, ...fields] = line.split('\t')
    const id = index(symbol)
    const i = sessions.get(date)
    const [open, high, low, close, volume, vwap] = fields.map(Number)
    if (
      i === undefined ||
      !/^\d{4}-\d\d-\d\dT0[45]:00:00Z$/.test(time) ||
      !Number.isFinite(Date.parse(time)) ||
      fields.length !== 6 ||
      fields.some((field) => field.trim() === '') ||
      [open, high, low, close, volume, vwap].some((n) => !Number.isFinite(n) || n <= 0) ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close) ||
      i <= (latest[id] ?? -1)
    ) {
      throw new Error(`Invalid or unordered bar: ${symbol} ${time}`)
    }
    latest[id] = i
    const bar = series[id]
    bar.open[i] = open
    bar.close[i] = close
    rows++
  }
  return {
    dates,
    series,
    spy,
    stockSectors: stockGroups.map((group) => group.map(index)),
    sectorEtfs: stockGroups.map((_, i) => index(sectors[i])),
    rows,
  }
}

export const stride = 6
export interface TapeDay {
  readonly date: string
  readonly slots: number
  readonly bars: ReadonlyMap<string, Float64Array>
}

const slotAt = (session: Session, utcMinute: number) => (utcMinute - (session.openMs % 86_400_000) / 60_000) / 5

function parseFiveMinute(sessions: readonly Session[], rows: Iterable<string>) {
  const dates = new Map(sessions.map((session) => [session.date, session]))
  const perDay = new Map(sessions.map((session) => [session.date, new Map<string, Float64Array>()]))
  const seen = new Map<string, string>()
  const counts = { rows: 0, regular: 0, nonRegular: 0, preListing: 0 }
  const bySymbol = Object.fromEntries(symbols.map((symbol) => [symbol, { received: 0, expected: 0, missing: 0 }]))
  let row = 0
  for (const line of rows) {
    row++
    const date = line.slice(line.indexOf('\t') + 1, line.indexOf('\t') + 11)
    const [symbol, timestamp, o, h, l, c, v, w, extra] = line.split('\t')
    const session = dates.get(date)
    const bars = perDay.get(date)
    if (
      session === undefined ||
      bars === undefined ||
      !Object.hasOwn(bySymbol, symbol) ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00Z$/.test(timestamp) ||
      extra !== undefined ||
      w === undefined ||
      timestamp <= (seen.get(symbol) ?? '')
    ) {
      throw new Error(`Invalid symbol/time/order/shape at row ${row}`)
    }
    seen.set(symbol, timestamp)
    counts.rows++
    const slot = slotAt(session, Number(timestamp.slice(11, 13)) * 60 + Number(timestamp.slice(14, 16)))
    if (!Number.isInteger(slot)) throw new Error(`Off-grid SIP 5m bar at row ${row}`)
    if (slot < 0 || slot >= session.minutes / 5) {
      counts.nonRegular++
      continue
    }
    if (date < (listings[symbol] ?? firstDay)) {
      counts.preListing++
      continue
    }
    const open = Number(o)
    const high = Number(h)
    const low = Number(l)
    const close = Number(c)
    const volume = Number(v)
    const vwap = Number(w)
    if (
      !(
        low > 0 &&
        open >= low &&
        close >= low &&
        high >= open &&
        high >= close &&
        Number.isFinite(high) &&
        Number.isSafeInteger(volume) &&
        volume > 0 &&
        vwap > 0 &&
        Number.isFinite(vwap)
      )
    ) {
      throw new Error(`Invalid OHLCV at row ${row} (${symbol} ${timestamp})`)
    }
    let series = bars.get(symbol)
    if (series === undefined) bars.set(symbol, (series = new Float64Array((session.minutes / 5) * stride)))
    const offset = slot * stride
    series[offset] = open
    series[offset + 1] = high
    series[offset + 2] = low
    series[offset + 3] = close
    series[offset + 4] = volume
    series[offset + 5] = vwap
    counts.regular++
    bySymbol[symbol].received++
  }
  for (const symbol of symbols) {
    const symbolCounts = bySymbol[symbol]
    symbolCounts.expected = sessions.reduce(
      (total, session) => total + (session.date >= (listings[symbol] ?? firstDay) ? session.minutes / 5 : 0),
      0,
    )
    symbolCounts.missing = symbolCounts.expected - symbolCounts.received
  }
  const days = sessions.map(
    (session): TapeDay => ({
      date: session.date,
      slots: session.minutes / 5,
      bars: perDay.get(session.date) ?? new Map(),
    }),
  )
  return { days, row, coverage: { ...counts, bySymbol } }
}
