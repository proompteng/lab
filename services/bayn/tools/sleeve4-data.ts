import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { S3Client } from 'bun'
import { Schema } from 'effect'

import { decodeRegularCalendar, minuteMs } from './midday-research-data'

export const validationEnd = '2026-03-31'
export const liveStart = '2026-08-25'
export const holdoutEnd = '2026-11-25'
export const split = (date: string) => {
  if (date < '2024-01-02') return 'legacy'
  if (date < '2025-07-01') return 'train'
  if (date <= validationEnd) return 'validation'
  return 'holdout'
}

const prefix = 'bayn-research-datasets/2026-11-27/'
export const manifestSha256 = '3954d5f0ff79bdd280f893cfa133e12e4fccad409ff3f8c907a80410ee19e5ca'
const files = {
  long: 'bars_1m_3yr_7sym_20240102_20260911.tsv.gz',
  live: 'bars_1m_live_20260716_20261125.tsv.gz',
  sip: 'daily_sip_17sym_20160104_20261125.tsv.gz',
  calendar: 'calendar_2024_2026.json',
  sessions: 'exchange_sessions_2024_2026.tsv.gz',
}
const Manifest = Schema.Struct({
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
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

export interface Candle {
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}
export type Tape = readonly (Candle | undefined)[]
export interface Day {
  readonly date: string
  readonly minutes: number
  readonly tapes: ReadonlyMap<string, Tape>
}
type CalendarDay = { date: string; openMs: number; minutes: number }
type Daily = ReadonlyMap<string, Candle>

export const adjustSplit = (bar: Candle, symbol: string, date: string): Candle =>
  symbol === 'NVDA' && date < '2024-06-10'
    ? { open: bar.open / 10, high: bar.high / 10, low: bar.low / 10, close: bar.close / 10, volume: bar.volume * 10 }
    : bar

const parseBar = (fields: string[], context: string): Candle => {
  const [open, high, low, close, volume, vwap] = fields.map(Number)
  if (
    fields.some((x) => x.trim() === '' || !Number.isFinite(Number(x))) ||
    open === undefined ||
    high === undefined ||
    low === undefined ||
    close === undefined ||
    volume === undefined ||
    vwap === undefined ||
    low <= 0 ||
    low > Math.min(open, close) ||
    high < Math.max(open, close) ||
    volume <= 0 ||
    vwap <= 0
  ) {
    throw new Error(`Invalid OHLCV at ${context}`)
  }
  return { open, high, low, close, volume }
}

function* lines(raw: Buffer) {
  const content = raw.toString('utf8')
  let start = 0
  while (start < content.length) {
    const newline = content.indexOf('\n', start)
    if (newline < 0) {
      yield content.slice(start)
      return
    }
    yield content.slice(start, newline)
    start = newline + 1
  }
}

export const chooseMinuteSource = (date: string) => (date < liveStart ? 'long' : 'live')

const minuteDays = (raw: Buffer, rows: number, dates: readonly CalendarDay[], kind: 'long' | 'live', end: string) => {
  const sessions = new Map(
    dates.filter((d) => d.date <= end).map((d) => [d.date, { ...d, tapes: new Map<string, (Candle | undefined)[]>() }]),
  )
  const symbols = new Set<string>()
  let count = 0
  let regularRows = 0
  for (const line of lines(raw)) {
    count++
    const [symbol, timestamp, ...fields] = line.split('\t')
    if (symbol === undefined || timestamp === undefined || !/^[A-Z]+$/.test(symbol) || fields.length !== 6) {
      throw new Error(`Malformed ${kind} row ${count}`)
    }
    const date = timestamp.slice(0, 10)
    if (date > end) continue
    const session = sessions.get(date)
    const time = Date.parse(timestamp)
    if (session === undefined || !Number.isFinite(time) || time % minuteMs !== 0)
      throw new Error(`Invalid ${kind} timestamp ${timestamp}`)
    symbols.add(symbol)
    const minute = (time - session.openMs) / minuteMs
    if (minute < 0 || minute >= session.minutes) continue
    const tape = session.tapes.get(symbol) ?? Array.from<Candle | undefined>({ length: session.minutes })
    if (tape[minute] !== undefined) throw new Error(`Duplicate regular minute: ${date} ${symbol} ${minute}`)
    const bar = parseBar(fields, `${kind} row ${count}`)
    tape[minute] = kind === 'long' ? adjustSplit(bar, symbol, date) : bar
    session.tapes.set(symbol, tape)
    regularRows++
  }
  if (count !== rows) throw new Error(`Incorrect ${kind} row count: ${count}`)
  return { days: sessions, symbols: [...symbols].sort(), regularRows }
}

const sipDays = (raw: Buffer, rows: number, end: string) => {
  const days = new Map<string, Map<string, Candle>>()
  const symbols = new Set<string>()
  let count = 0
  for (const line of lines(raw)) {
    count++
    if (count === 1) {
      if (line !== 'symbol\tsession_date\topen\thigh\tlow\tclose\tvolume\tvwap\ttrade_count') {
        throw new Error('Unexpected SIP header')
      }
      continue
    }
    const [symbol, date, ...fields] = line.split('\t')
    if (
      symbol === undefined ||
      date === undefined ||
      !/^[A-Z]+$/.test(symbol) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      fields.length !== 7
    ) {
      throw new Error(`Malformed SIP row ${count}`)
    }
    if (date > end) continue
    const day = days.get(date) ?? new Map()
    if (day.has(symbol)) throw new Error(`Duplicate SIP date: ${symbol} ${date}`)
    day.set(symbol, parseBar(fields.slice(0, 6), `SIP row ${count}`))
    days.set(date, day)
    symbols.add(symbol)
  }
  if (count !== rows) throw new Error(`Incorrect SIP line count: ${count}`)
  return {
    days: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bars]) => ({ date, bars: bars as Daily })),
    symbols: [...symbols].sort(),
  }
}

const artifactClient = () => {
  const accessKeyId = process.env['AWS_ACCESS_KEY_ID']
  const secretAccessKey = process.env['AWS_SECRET_ACCESS_KEY']
  if (accessKeyId === undefined || secretAccessKey === undefined || accessKeyId === '' || secretAccessKey === '') {
    throw new Error('Frozen artifact download requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY')
  }
  return new S3Client({
    endpoint: process.env['AGENTS_ARTIFACTS_ENDPOINT'] || 'http://rook-ceph-rgw-objectstore.rook-ceph.svc:80',
    bucket: process.env['AGENTS_ARTIFACTS_BUCKET'] || 'agents-artifacts',
    accessKeyId,
    secretAccessKey,
    region: 'us-east-1',
  })
}

export const loadDataset = async (directory: string | undefined, includeHoldout: boolean) => {
  const client = directory === undefined ? artifactClient() : undefined
  const get = async (name: string) => {
    if (directory !== undefined) return readFileSync(join(directory, name))
    if (client === undefined) throw new Error('S3 client unavailable')
    return Buffer.from(await client.file(prefix + name).arrayBuffer())
  }
  const manifest = await get('MANIFEST.json')
  if (sha256(manifest) !== manifestSha256) throw new Error('Frozen manifest SHA-256 mismatch')
  const all = Schema.decodeUnknownSync(Manifest)(JSON.parse(manifest.toString()))
  const receipts: (typeof all.files)[number][] = []
  const read = async (name: string) => {
    const receipt = all.files.find(({ key }) => key === prefix + name)
    if (receipt === undefined) throw new Error(`Missing frozen receipt: ${name}`)
    const compressed = await get(name)
    if (compressed.length !== receipt.gzipBytes || sha256(compressed) !== receipt.gzipSha256) {
      throw new Error(`Frozen compressed bytes/SHA-256 mismatch: ${name}`)
    }
    const raw = name.endsWith('.gz') ? gunzipSync(compressed) : compressed
    if (raw.length !== receipt.rawBytes || sha256(raw) !== receipt.rawSha256) {
      throw new Error(`Frozen raw bytes/SHA-256 mismatch: ${name}`)
    }
    receipts.push(receipt)
    return { raw, rows: receipt.rows }
  }
  const calendarJson: unknown = JSON.parse((await read(files.calendar)).raw.toString())
  const calendar = decodeRegularCalendar(calendarJson)
  const sessionTsv = await read(files.sessions)
  const expected = calendar.providerSessions.map(({ date, regularOpenAt, regularCloseAt }) => {
    const openMs = Date.parse(regularOpenAt)
    const minutes = (Date.parse(regularCloseAt) - openMs) / minuteMs
    return { date, openMs, minutes }
  })
  const tsv = [...lines(sessionTsv.raw)]
  const calendarRows = tsv.slice(1)
  if (
    tsv[0] !== 'session_date\topen_time\tclose_time\ttimezone' ||
    tsv.length !== sessionTsv.rows ||
    calendarRows.length !== expected.length ||
    !calendarRows.every((line, i) => {
      const day = expected[i]
      return (
        day !== undefined &&
        line === `${day.date}\t09:30\t${day.minutes === 390 ? '16:00' : '13:00'}\tAmerica/New_York` &&
        [210, 390].includes(day.minutes)
      )
    })
  )
    throw new Error('Frozen exchange calendars disagree')
  const end = includeHoldout ? holdoutEnd : validationEnd
  const longFile = await read(files.long)
  const long = minuteDays(longFile.raw, longFile.rows, expected, 'long', end)
  const sipFile = await read(files.sip)
  const sip = sipDays(sipFile.raw, sipFile.rows, end)
  const liveFile = includeHoldout ? await read(files.live) : undefined
  const live =
    liveFile !== undefined
      ? minuteDays(
          liveFile.raw,
          liveFile.rows,
          expected.filter((d) => d.date >= '2026-07-16'),
          'live',
          end,
        )
      : undefined
  const core = [...long.days.values()].map((day) =>
    chooseMinuteSource(day.date) === 'long' ? day : (live?.days.get(day.date) ?? day),
  )
  return {
    core,
    live: live !== undefined ? [...live.days.values()] : [],
    sip: sip.days,
    calendarJson,
    liveRaw: liveFile?.raw,
    sources: {
      manifestSha256,
      receipts,
      calendarHash: calendar.normalizedResponseHash,
      long: { symbols: long.symbols, regularRows: long.regularRows },
      live: live !== undefined ? { symbols: live.symbols, regularRows: live.regularRows } : null,
      sip: sip.symbols,
    },
  }
}
