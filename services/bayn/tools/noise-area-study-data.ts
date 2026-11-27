import { S3Client } from 'bun'
import { Config, Data, Effect, Redacted, Schema } from 'effect'

import { normalizeResearchCalendar, sha256, type Session } from './research-orb-zab-data'
import { splits, symbols, type Bar, type Day, type Symbol } from './noise-area-study-replay'

const dataset = 'bayn-research-datasets/'
const devPrefix = dataset + '2026-11-27-sip-8yr-5m-unseen-v2/'
const holdPrefix = dataset + '2026-11-27-sip-multiyear/'
const shyPrefix = dataset + '2026-11-27-sip-10yr-sp100/'
export const sources = {
  development: {
    manifest: devPrefix + 'MANIFEST.json',
    manifestSha256: 'c18d9c4d537ae17a6322dc8a2d5a9338b8851706d58c5ea62f02a31b37ea0eb0',
    calendar: devPrefix + 'calendar_2016_2023.json',
    calendarSha256: '0165400d9544973b0971a2397969e65bd2543beff5d8bd47510f09b015ef7f86',
    bars: devPrefix + 'alpaca_sip_5m_rth_exact62_20160104_20231229.tsv.gz',
    rows: 8_641_719,
    memberBytes: 174_597_176,
  },
  holdout: {
    manifest: holdPrefix + 'MANIFEST.json',
    manifestSha256: '5df0cfe213c69e9a6489dde46553db610edb2632b5e54fb76a6347740abcdead',
    calendar: dataset + '2026-11-27/calendar_2024_2026.json',
    calendarSha256: 'b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71',
    bars: holdPrefix + 'alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz',
    rows: 3_923_737,
  },
  shy: {
    manifest: shyPrefix + 'MANIFEST.json',
    manifestSha256: 'ffaa9d30d69d38307f69ec77f07c12cdd82c7407131a110bc3b88421b0f1676e',
    bars: shyPrefix + 'alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz',
    rows: 450_712,
  },
} as const

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const blob = Schema.Struct({ key: Schema.String, bytes: count, sha256: digest })
const file = Schema.Struct({
  key: Schema.String,
  rows: count,
  rawBytes: count,
  rawSha256: digest,
  gzipBytes: count,
  gzipSha256: digest,
})
const decodeDevelopment = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-8yr-unseen-manifest.v2'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=split, timeframe=5Min)'),
    matchesWave3BUniverse: Schema.Literal(true),
    dateRange: Schema.Struct({ start: Schema.String, end: Schema.String }),
    calendarSessions: count,
    symbolCount: count,
    totalRows: count,
    symbols: Schema.Array(Schema.String),
    symbolRowCounts: Schema.Record(Schema.String, count),
    files: Schema.Struct({ bars_5m: blob, calendar: blob }),
  }),
)
const decodeHoldout = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-multiyear-dataset-manifest.v1'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=split)'),
    universes: Schema.Struct({ all62: Schema.Array(Schema.String) }),
    files: Schema.Array(file),
  }),
)
const decodeShy = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-10yr-sp100-manifest.v1'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])'),
    etfs: Schema.Array(Schema.String),
    files: Schema.Array(file),
  }),
)

class ArchiveError extends Data.TaggedError('NoiseAreaArchiveError')<{ readonly message: string }> {}
type Open = (key: string) => Promise<Response>
interface Archive {
  readonly open: Open
  readonly json: (key: string, sha: string) => Promise<unknown>
}

export const withArchive = <A>(run: (archive: Archive) => Promise<A>) =>
  Effect.gen(function* () {
    const endpoint = yield* Config.NonEmptyString('AGENTS_ARTIFACTS_ENDPOINT').pipe(
      Config.withDefault('http://rook-ceph-rgw-objectstore.rook-ceph.svc:80'),
    )
    const bucket = yield* Config.NonEmptyString('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('agents-artifacts'))
    const accessKeyId = yield* Config.Redacted('AWS_ACCESS_KEY_ID')
    const secretAccessKey = yield* Config.Redacted('AWS_SECRET_ACCESS_KEY')
    const s3 = new S3Client({
      endpoint,
      bucket,
      region: 'us-east-1',
      accessKeyId: Redacted.value(accessKeyId),
      secretAccessKey: Redacted.value(secretAccessKey),
    })
    return yield* Effect.tryPromise({
      try: (signal) => {
        const open: Open = async (key) => {
          const response = await fetch(s3.presign(key, { expiresIn: 300 }), {
            signal,
            redirect: 'error',
            decompress: false,
          }).catch(() => {
            throw new Error(`S3 transport failed: ${key}`)
          })
          if (!response.ok) {
            await response.body?.cancel()
            throw new Error(`S3 read failed (${response.status}): ${key}`)
          }
          return response
        }
        return run({
          open,
          json: async (key, sha) => {
            const value = await (await open(key)).bytes()
            if (sha256(value) !== sha) throw new Error(`S3 SHA-256 mismatch: ${key}`)
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value))
          },
        })
      },
      catch: (cause) => new ArchiveError({ message: cause instanceof Error ? cause.message : String(cause) }),
    })
  })

interface Receipt {
  readonly key: string
  readonly bytes: number
  readonly sha256: string
}

const verified = (receipt: Receipt, prefix = receipt.bytes) => {
  if (prefix <= 0 || prefix > receipt.bytes) throw new Error(`Invalid byte boundary: ${receipt.key}`)
  const hash = new Bun.CryptoHasher('sha256')
  let bytes = 0
  return new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      hash.update(chunk)
      const remaining = prefix - bytes
      if (remaining > 0) controller.enqueue(chunk.subarray(0, remaining))
      bytes += chunk.length
    },
    flush() {
      if (bytes !== receipt.bytes || hash.digest('hex') !== receipt.sha256)
        throw new Error(`Byte receipt mismatch: ${receipt.key}`)
    },
  })
}

export const unpack = (
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  receipt: Receipt,
  memberBytes?: number,
  rawReceipt?: Receipt,
) => {
  const decoded = stream.pipeThrough(verified(receipt, memberBytes)).pipeThrough(new DecompressionStream('gzip'))
  return rawReceipt === undefined ? decoded : decoded.pipeThrough(verified(rawReceipt))
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const parts = (pending + decoder.decode(value, { stream: true })).split('\n')
      pending = parts.pop() ?? ''
      yield* parts
    }
    pending += decoder.decode()
    if (pending.length > 0) yield pending
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

const tapeLines = async (archive: Archive, receipt: Receipt, memberBytes?: number, rawReceipt?: Receipt) => {
  const response = await archive.open(receipt.key)
  if (response.body === null) throw new Error(`Missing tape body: ${receipt.key}`)
  return lines(unpack(response.body, receipt, memberBytes, rawReceipt))
}

const getFile = (files: readonly (typeof file.Type)[], source: { bars: string; rows: number }) => {
  const matching = files.filter(({ key }) => key === source.bars)
  const [entry] = matching
  if (matching.length !== 1 || entry.rows !== source.rows) throw new Error(`Manifest does not bind ${source.bars}`)
  return {
    compressed: { key: entry.key, bytes: entry.gzipBytes, sha256: entry.gzipSha256 },
    raw: { key: entry.key + ' (raw)', bytes: entry.rawBytes, sha256: entry.rawSha256 },
  }
}

const assertCalendar = (calendar: readonly Session[], window: { first: string; last: string; count: number }) => {
  if (
    calendar.length !== window.count ||
    calendar[0]?.date !== window.first ||
    calendar.at(-1)?.date !== window.last ||
    new Set(calendar.map(({ date }) => date)).size !== window.count
  )
    throw new Error(`Calendar must cover ${window.count} sessions from ${window.first} through ${window.last}`)
}

const etfs = new Map<string, Symbol>(symbols.map((ticker) => [ticker, ticker]))
const timestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00(?:\.0+)?(?:Z|\+00:00)$/
const decodeBar = (open: number, high: number, low: number, close: number, volume: number, vwap: number): Bar => {
  if (
    ![open, high, low, close, volume, vwap].every((value) => Number.isFinite(value) && value > 0) ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    !Number.isSafeInteger(volume)
  )
    throw new Error('Invalid bar prices or volume')
  return { open, high, low, close, volume, vwap }
}

export const readTape = async (
  rows: AsyncIterable<string> | Iterable<string>,
  calendar: readonly Session[],
  roster: readonly string[],
  expectedRows: number,
  bySymbol?: Readonly<Record<string, number>>,
) => {
  if (new Set(roster).size !== 62 || roster.length !== 62 || symbols.some((symbol) => !roster.includes(symbol)))
    throw new Error('Exact-62 roster must contain every registered ETF')
  const days = new Map(
    calendar.map(({ date, openMs, minutes }) => [
      date,
      { date, openMs, slots: minutes / 5, bars: new Map<Symbol, (Bar | undefined)[]>() },
    ]),
  )
  const seen = new Map(roster.map((name) => [name, { count: 0, time: -Infinity }]))
  const counts = Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      {
        rthBars: 0,
        missingRthBars: 0,
        missingFlatOpen: 0,
        emptySessions: [] as string[],
        firstRthDate: null as string | null,
        lastRthDate: null as string | null,
      },
    ]),
  )
  let physical = 0
  let outsideRth = 0
  let header = bySymbol === undefined // The continuity TSV starts directly with a physical row.
  for await (const line of rows) {
    if (!header) {
      if (line !== 'symbol\tt\to\th\tl\tc\tv\tn\tvw') throw new Error('Missing development SIP header')
      header = true
      continue
    }
    physical++
    const fields = line.split('\t')
    const [name, stamp] = fields
    const row = seen.get(name)
    const day = days.get(stamp?.slice(0, 10))
    const time = Date.parse(stamp)
    if (
      fields.length !== (bySymbol === undefined ? 8 : 9) ||
      row === undefined ||
      day === undefined ||
      !timestamp.test(stamp) ||
      !Number.isFinite(time) ||
      time <= row.time
    )
      throw new Error(`Invalid, duplicate or unordered SIP row ${physical}: ${name} ${stamp}`)
    row.count++
    row.time = time
    const slot = (time - day.openMs) / 300_000
    if (!Number.isInteger(slot)) throw new Error(`Off-grid timestamp on SIP row ${physical}`)
    if (slot < 0 || slot >= day.slots) {
      outsideRth++
      continue
    }
    const symbol = etfs.get(name)
    if (symbol === undefined) continue
    const [open, high, low, close, volume] = fields.slice(2, 7).map(Number)
    const vwap = Number(fields.at(-1))
    let series = day.bars.get(symbol)
    if (series === undefined) {
      series = Array.from({ length: day.slots })
      day.bars.set(symbol, series)
    }
    series[slot] = decodeBar(open, high, low, close, volume, vwap)
  }
  if (
    physical !== expectedRows ||
    (bySymbol !== undefined && [...seen].some(([name, row]) => row.count !== bySymbol[name]))
  )
    throw new Error(`SIP row receipt mismatch: ${physical} vs ${expectedRows} or per-symbol count`)
  for (const day of days.values()) {
    for (const symbol of symbols) {
      const bars = day.bars.get(symbol)
      const present = bars?.filter((bar) => bar !== undefined).length ?? 0
      counts[symbol].rthBars += present
      counts[symbol].missingRthBars += day.slots - present
      counts[symbol].missingFlatOpen += Number(bars?.[day.slots - 1] === undefined)
      if (present === 0) counts[symbol].emptySessions.push(day.date)
      else {
        counts[symbol].firstRthDate ??= day.date
        counts[symbol].lastRthDate = day.date
      }
    }
  }
  if (symbols.some((symbol) => counts[symbol].rthBars === 0)) throw new Error('Missing entire ETF history')
  return {
    days: [...days.values()] satisfies Day[],
    coverage: {
      physical,
      outsideRth,
      counts,
      halfDays: calendar.filter(({ minutes }) => minutes !== 390).map(({ date }) => date),
    },
  }
}

export const loadDevelopment = async (archive: Archive) => {
  const src = sources.development
  const manifest = decodeDevelopment(await archive.json(src.manifest, src.manifestSha256))
  const { files, symbols: roster } = manifest
  const { train, validation } = splits
  if (
    manifest.symbolCount !== 62 ||
    manifest.dateRange.start !== train.first ||
    manifest.dateRange.end !== validation.last ||
    manifest.calendarSessions !== train.count + validation.count ||
    manifest.totalRows !== src.rows ||
    files.calendar.key !== src.calendar ||
    files.calendar.sha256 !== src.calendarSha256 ||
    files.bars_5m.key !== src.bars
  )
    throw new Error('Development manifest does not match registered receipt')
  const calendar = normalizeResearchCalendar({
    query: { start: train.first, end: validation.last },
    response: await archive.json(src.calendar, src.calendarSha256),
  })
  assertCalendar(
    calendar.filter(({ date }) => date <= train.last),
    train,
  )
  assertCalendar(
    calendar.filter(({ date }) => date > train.last),
    validation,
  )
  const rows = await tapeLines(archive, files.bars_5m, src.memberBytes)
  return readTape(rows, calendar, roster, src.rows, manifest.symbolRowCounts)
}

export const loadHoldout = async (archive: Archive) => {
  const src = sources.holdout
  const manifest = decodeHoldout(await archive.json(src.manifest, src.manifestSha256))
  const { compressed, raw } = getFile(manifest.files, src)
  const calendar = normalizeResearchCalendar(await archive.json(src.calendar, src.calendarSha256))
  assertCalendar(calendar, splits.holdout)
  return readTape(await tapeLines(archive, compressed, undefined, raw), calendar, manifest.universes.all62, src.rows)
}

export const loadShy = async (archive: Archive, dates: readonly string[]) => {
  const src = sources.shy
  const manifest = decodeShy(await archive.json(src.manifest, src.manifestSha256))
  if (!manifest.etfs.includes('SHY')) throw new Error('Missing SHY from registered total-return tape')
  const { compressed, raw } = getFile(manifest.files, src)
  const wanted = new Set(dates)
  const prices = new Map<string, number>()
  let n = 0
  for await (const line of await tapeLines(archive, compressed, undefined, raw)) {
    n++
    if (!line.startsWith('SHY\t')) continue
    const fields = line.split('\t')
    const [, stamp, , , , close] = fields
    const date = stamp?.slice(0, 10)
    const price = Number(close)
    if (
      fields.length !== 8 ||
      !timestamp.test(stamp) ||
      !wanted.has(date) ||
      !(price > 0) ||
      !Number.isFinite(price) ||
      prices.has(date)
    )
      throw new Error(`Invalid SHY observation: ${stamp}`)
    prices.set(date, price)
  }
  if (n !== src.rows || prices.size !== dates.length)
    throw new Error(`SHY row receipt mismatch: ${n} rows and ${prices.size} dates`)
  return dates.map((date) => {
    const price = prices.get(date)
    if (price === undefined) throw new Error(`Missing SHY close for ${date}`)
    return price
  })
}
