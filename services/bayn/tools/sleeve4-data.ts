import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { S3Client } from 'bun'
import { Config, Data, Effect, FileSystem, Redacted, Schema } from 'effect'

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

export class Sleeve4ResearchError extends Data.TaggedError('Sleeve4ResearchError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

export const researchStep = <A>(operation: string, run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new Sleeve4ResearchError({ operation, cause }) })

const artifactClient = Effect.gen(function* () {
  const config = yield* Config.all({
    endpoint: Config.String('AGENTS_ARTIFACTS_ENDPOINT').pipe(Config.withDefault('')),
    bucket: Config.String('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('')),
    accessKeyId: Config.Redacted('AWS_ACCESS_KEY_ID'),
    secretAccessKey: Config.Redacted('AWS_SECRET_ACCESS_KEY'),
  })
  const accessKeyId = Redacted.value(config.accessKeyId)
  const secretAccessKey = Redacted.value(config.secretAccessKey)
  return yield* researchStep('Configure the frozen artifact client', () => {
    if (accessKeyId === '' || secretAccessKey === '') throw new Error('Frozen artifact credentials are empty')
    return new S3Client({
      endpoint: config.endpoint === '' ? 'http://rook-ceph-rgw-objectstore.rook-ceph.svc:80' : config.endpoint,
      bucket: config.bucket === '' ? 'agents-artifacts' : config.bucket,
      accessKeyId,
      secretAccessKey,
      region: 'us-east-1',
    })
  })
})

// Bun's S3 body methods do not accept AbortSignal. Sign with S3Client and
// transport with abortable fetch, without including signed URLs in errors.
export const fetchFrozenArtifact = (
  client: Pick<S3Client, 'presign'>,
  name: string,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
) => {
  const operation = `Download frozen artifact ${name}`
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await request(client.presign(prefix + name, { expiresIn: 60 }), { signal, redirect: 'error' })
        if (!response.ok) {
          await response.body?.cancel()
          return { status: response.status, bytes: null }
        }
        return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }
      },
      catch: (cause) =>
        new Sleeve4ResearchError({ operation, cause: cause instanceof Error ? cause.name : 'Transport failure' }),
    })
    if (result.bytes === null) {
      return yield* new Sleeve4ResearchError({ operation, cause: `HTTP ${result.status}` })
    }
    return result.bytes
  })
}

const parseManifest = (manifest: Buffer) => {
  if (sha256(manifest) !== manifestSha256) throw new Error('Frozen manifest SHA-256 mismatch')
  return Schema.decodeUnknownSync(Manifest)(JSON.parse(manifest.toString()))
}

const unpack = (name: string, compressed: Buffer, receipt: (typeof Manifest.Type.files)[number]) => {
  if (compressed.length !== receipt.gzipBytes || sha256(compressed) !== receipt.gzipSha256) {
    throw new Error(`Frozen compressed bytes/SHA-256 mismatch: ${name}`)
  }
  const raw = name.endsWith('.gz') ? gunzipSync(compressed) : compressed
  if (raw.length !== receipt.rawBytes || sha256(raw) !== receipt.rawSha256) {
    throw new Error(`Frozen raw bytes/SHA-256 mismatch: ${name}`)
  }
  return { raw, rows: receipt.rows }
}

const reconcileCalendar = (calendarJson: unknown, sessionTsv: { readonly raw: Buffer; readonly rows: number }) => {
  const calendar = decodeRegularCalendar(calendarJson)
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
  return { expected, calendarHash: calendar.normalizedResponseHash }
}

export const loadDataset = (directory: string | undefined, includeHoldout: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const get = yield* directory === undefined
      ? Effect.map(artifactClient, (client) => (name: string) => fetchFrozenArtifact(client, name))
      : Effect.succeed((name: string) =>
          fs.readFile(join(directory, name)).pipe(Effect.map((bytes) => Buffer.from(bytes))),
        )
    const manifest = yield* get('MANIFEST.json')
    const all = yield* researchStep('Validate frozen manifest', () => parseManifest(manifest))
    const receipts: (typeof all.files)[number][] = []
    const read = (name: string) =>
      Effect.gen(function* () {
        const receipt = all.files.find(({ key }) => key === prefix + name)
        if (receipt === undefined)
          return yield* new Sleeve4ResearchError({ operation: name, cause: 'No frozen receipt' })
        const compressed = yield* get(name)
        const decoded = yield* researchStep(`Unpack frozen artifact ${name}`, () => unpack(name, compressed, receipt))
        receipts.push(receipt)
        return decoded
      })
    const calendarFile = yield* read(files.calendar)
    const calendarJson: unknown = yield* researchStep(
      'Parse frozen calendar JSON',
      () => JSON.parse(calendarFile.raw.toString()) as unknown,
    )
    const sessionTsv = yield* read(files.sessions)
    const { expected, calendarHash } = yield* researchStep('Reconcile the frozen exchange calendars', () =>
      reconcileCalendar(calendarJson, sessionTsv),
    )
    const end = includeHoldout ? holdoutEnd : validationEnd
    const longFile = yield* read(files.long)
    const long = yield* researchStep('Parse core minute bars', () =>
      minuteDays(longFile.raw, longFile.rows, expected, 'long', end),
    )
    const sipFile = yield* read(files.sip)
    const sip = yield* researchStep('Parse daily SIP bars', () => sipDays(sipFile.raw, sipFile.rows, end))
    const liveFile = includeHoldout ? yield* read(files.live) : undefined
    const live =
      liveFile === undefined
        ? undefined
        : yield* researchStep('Parse live minute bars', () =>
            minuteDays(
              liveFile.raw,
              liveFile.rows,
              expected.filter((d) => d.date >= '2026-07-16'),
              'live',
              end,
            ),
          )
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
        calendarHash,
        long: { symbols: long.symbols, regularRows: long.regularRows },
        live: live !== undefined ? { symbols: live.symbols, regularRows: live.regularRows } : null,
        sip: sip.symbols,
      },
    }
  })
