import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import { Config, Effect, Redacted, Schema } from 'effect'
import { S3Client } from 'bun'

import { normalizeResearchCalendar } from './research-orb-zab-data'
import { firstDay, lastDay, listingStarts, sectorGroups, type Universe } from './sip-statarb-protocol'

const prefix = 'bayn-research-datasets/2026-11-27-sip-multiyear'
const barsName = 'alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz'
const calendarName = 'calendar_2024_2026.json'
export const sourceIdentity = {
  manifestSha256: '5df0cfe213c69e9a6489dde46553db610edb2632b5e54fb76a6347740abcdead',
  calendarSha256: 'b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71',
  gzipSha256: '105972d7825b4deb14a30295fab153b1e734929e1c321642964ec8d35bbbc697',
  rawSha256: 'c053ede2875ad791c99aae517db9efa9a4587b08c9907d55e0960dade59d567e',
  rows: 3_923_737,
  sessions: 729,
}

export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-multiyear-dataset-manifest.v1'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=split)'),
    universes: Schema.Struct({
      bayn21: Schema.Array(Schema.String),
      expanded29: Schema.Array(Schema.String),
      sectorMacro12: Schema.Array(Schema.String),
      all62: Schema.Array(Schema.String),
    }),
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

export const loadSources = (inputDir: string | undefined) =>
  Effect.gen(function* () {
    if (inputDir !== undefined) {
      return {
        manifest: Bun.file(join(inputDir, 'MANIFEST.json')),
        calendar: Bun.file(join(inputDir, calendarName)),
        bars: Bun.file(join(inputDir, barsName)),
      }
    }
    const options = yield* Config.all({
      endpoint: Config.String('AGENTS_ARTIFACTS_ENDPOINT').pipe(
        Config.withDefault('http://rook-ceph-rgw-objectstore.rook-ceph.svc:80'),
      ),
      bucket: Config.String('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('agents-artifacts')),
      accessKeyId: Config.Redacted('AWS_ACCESS_KEY_ID'),
      secretAccessKey: Config.Redacted('AWS_SECRET_ACCESS_KEY'),
    })
    const source = new S3Client({
      ...options,
      region: 'us-east-1',
      accessKeyId: Redacted.value(options.accessKeyId),
      secretAccessKey: Redacted.value(options.secretAccessKey),
    })
    return {
      manifest: source.file(`${prefix}/MANIFEST.json`),
      calendar: source.file(`bayn-research-datasets/2026-11-27/${calendarName}`),
      bars: source.file(`${prefix}/${barsName}`),
    }
  })

type Sources = Effect.Success<ReturnType<typeof loadSources>>
const maxSlots = 78
export const stride = 6
export enum Field {
  Open,
  High,
  Low,
  Close,
  Volume,
  Vwap,
}
export interface Day {
  readonly date: string
  readonly openMs: number
  readonly slots: number
  readonly tape: Float64Array
}
export interface Panel {
  readonly days: readonly Day[]
  readonly symbols: readonly string[]
  readonly universes: Readonly<Record<Universe, readonly number[]>>
  readonly sector: readonly number[]
  readonly spy: number
  readonly coverage: ReturnType<typeof makeCoverage>[]
}

const makeCoverage = (symbol: string) => ({
  symbol,
  regularBars: 0,
  outsideRth: 0,
  beforeListing: 0,
  invalidRth: 0,
  completeSessions: 0,
})
export const barOffset = (symbol: number, slot: number) => (symbol * maxSlots + slot) * stride
export const makeDay = (date: string, openMs: number, slots: number, symbolCount: number): Day => ({
  date,
  openMs,
  slots,
  tape: new Float64Array(symbolCount * maxSlots * stride),
})

const verifyIdentity = (actual: string, expected: string, description: string) => {
  if (actual !== expected) throw new Error(`Unexpected ${description}: ${actual} (expected ${expected})`)
}

function* splitLines(chunk: string) {
  let offset = 0
  for (let newline = chunk.indexOf('\n'); newline !== -1; newline = chunk.indexOf('\n', offset)) {
    yield chunk.slice(offset, newline)
    offset = newline + 1
  }
  return chunk.slice(offset)
}

/** Stream one price panel; the development pass does not decode any frozen-holdout numeric fields. */
export const readPanel = async (sources: Sources, through: string, signal: AbortSignal): Promise<Panel> => {
  const [manifestText, calendarText] = await Promise.all([
    new Response(sources.manifest.stream().pipeThrough(new TransformStream(), { signal })).text(),
    new Response(sources.calendar.stream().pipeThrough(new TransformStream(), { signal })).text(),
  ])
  verifyIdentity(hash(manifestText), sourceIdentity.manifestSha256, 'manifest SHA-256')
  verifyIdentity(hash(calendarText), sourceIdentity.calendarSha256, 'calendar SHA-256')
  const manifest = decodeManifest(JSON.parse(manifestText))
  const descriptor = manifest.files.find((file) => file.key === `${prefix}/${barsName}`)
  if (
    descriptor === undefined ||
    descriptor.rows !== sourceIdentity.rows ||
    descriptor.gzipSha256 !== sourceIdentity.gzipSha256 ||
    descriptor.rawSha256 !== sourceIdentity.rawSha256
  ) {
    throw new Error('Manifest lacks the pinned SIP tape descriptor')
  }
  const calendar = normalizeResearchCalendar(JSON.parse(calendarText))
  if (
    calendar.length !== sourceIdentity.sessions ||
    calendar[0]?.date !== firstDay ||
    calendar.at(-1)?.date !== lastDay
  )
    throw new Error('Unexpected SIP calendar coverage')
  const { bayn21, expanded29, sectorMacro12, all62 } = manifest.universes
  const symbols = all62.toSorted()
  const ids = new Map(symbols.map((symbol, index) => [symbol, index]))
  const id = (symbol: string) => {
    const index = ids.get(symbol)
    if (index === undefined) throw new Error(`Missing manifest symbol: ${symbol}`)
    return index
  }
  const bayn = bayn21.filter((symbol) => !['SPY', 'SMH', 'QQQ'].includes(symbol))
  const mixed = [...bayn21, ...expanded29]
  const stocks = mixed.filter((symbol) => !['SPY', 'SMH', 'QQQ', 'IWM'].includes(symbol))
  const names = {
    'bayn17-stocks': bayn.filter((symbol) => symbol !== 'IWM'),
    'bayn18-mixed': bayn,
    'expanded46-stocks': stocks,
    'expanded50-mixed': mixed,
  }
  const grouped = Object.entries(sectorGroups).flatMap(([etf, group]) =>
    group.split(' ').map((symbol) => [symbol, id(etf)] as const),
  )
  const sectorIds = new Map(grouped)
  if (
    ids.size !== 62 ||
    new Set([...mixed, ...sectorMacro12]).size !== 62 ||
    names['bayn17-stocks'].length !== 17 ||
    bayn.length !== 18 ||
    mixed.length !== 50 ||
    stocks.length !== 46 ||
    grouped.length !== stocks.length ||
    !stocks.every((symbol) => sectorIds.has(symbol))
  ) {
    throw new Error('Unexpected SIP universe or missing sector mapping')
  }
  const universes = {
    'bayn17-stocks': names['bayn17-stocks'].toSorted().map(id),
    'bayn18-mixed': names['bayn18-mixed'].toSorted().map(id),
    'expanded46-stocks': stocks.toSorted().map(id),
    'expanded50-mixed': mixed.toSorted().map(id),
  }
  const sector = symbols.map((symbol) => sectorIds.get(symbol) ?? -1)
  const days = calendar
    .filter((day) => day.date <= through)
    .map((day) => makeDay(day.date, day.openMs, day.minutes / 5, symbols.length))
  const byDate = new Map(days.map((day) => [day.date, day]))
  const coverage = symbols.map(makeCoverage)
  const lastEvent = new Float64Array(symbols.length)
  const gzip = createHash('sha256')
  const raw = createHash('sha256')
  let gzipBytes = 0
  let rawBytes = 0
  let rowCount = 0

  const readRow = (line: string) => {
    rowCount++
    const split = line.indexOf('\t')
    const date = line.slice(split + 1, split + 11)
    if (date > through) return
    const symbol = line.slice(0, split)
    const timestamp = line.slice(split + 1, split + 21)
    const hour = Number(timestamp.slice(11, 13))
    const minute = Number(timestamp.slice(14, 16))
    const day = byDate.get(date)
    if (
      split <= 0 ||
      day === undefined ||
      timestamp !== `${date}T${timestamp.slice(11, 13)}:${timestamp.slice(14, 16)}:00Z` ||
      line[split + 21] !== '\t' ||
      !/^\d\d:\d\d$/.test(timestamp.slice(11, 16)) ||
      hour > 23 ||
      minute > 59 ||
      minute % 5 !== 0
    ) {
      throw new Error(`Invalid SIP bar clock at row ${rowCount}`)
    }
    const idx = id(symbol)
    const counts = coverage[idx]
    const utcMinutes = hour * 60 + minute
    const sessionAnchor = day.openMs - (day.openMs % 86_400_000)
    const event = sessionAnchor + utcMinutes * 60_000
    if (lastEvent[idx] >= event) throw new Error(`Duplicate or unordered ${symbol} bar at ${timestamp}`)
    lastEvent[idx] = event
    const slot = (event - day.openMs) / 300_000
    if (slot < 0 || slot >= day.slots) {
      counts.outsideRth++
      return
    }
    if (date < (listingStarts[symbol] ?? firstDay)) {
      counts.beforeListing++
      return
    }
    const fields = line.slice(split + 22).split('\t')
    const [open, high, low, close, volume, vwap] = fields.map(Number)
    if (
      fields.length !== stride ||
      ![open, high, low, close, volume, vwap].every((v) => Number.isFinite(v) && v > 0) ||
      high < Math.max(open, low, close) ||
      low > Math.min(open, close)
    ) {
      counts.invalidRth++
      return
    }
    day.tape.set([open, high, low, close, volume, vwap], barOffset(idx, slot))
    counts.regularBars++
  }

  let pending = ''
  const accept = (chunk: string) => {
    const lines = splitLines(pending + chunk)
    let result = lines.next()
    while (result.done !== true) {
      readRow(result.value)
      result = lines.next()
    }
    pending = result.value
    if (pending.length > 512) throw new Error('SIP row exceeds permitted length')
  }
  await pipeline(
    sources.bars.stream(),
    async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        gzip.update(chunk)
        gzipBytes += chunk.byteLength
        yield chunk
      }
    },
    createGunzip(),
    async (chunks: AsyncIterable<Buffer>) => {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      for await (const chunk of chunks) {
        raw.update(chunk)
        rawBytes += chunk.byteLength
        accept(decoder.decode(chunk, { stream: true }))
      }
      accept(decoder.decode())
    },
    { signal },
  )
  if (pending !== '') readRow(pending)
  for (const day of days) {
    for (const [id, count] of coverage.entries()) {
      let complete = true
      for (let slot = 0; slot < day.slots && complete; slot++)
        complete = day.tape[barOffset(id, slot) + Field.Volume] > 0
      if (complete) count.completeSessions++
    }
  }
  verifyIdentity(gzip.digest('hex'), descriptor.gzipSha256, 'gzip SHA-256')
  verifyIdentity(raw.digest('hex'), descriptor.rawSha256, 'raw SHA-256')
  if (gzipBytes !== descriptor.gzipBytes || rawBytes !== descriptor.rawBytes || rowCount !== descriptor.rows)
    throw new Error(`SIP archive size/count mismatch: ${gzipBytes} gzip, ${rawBytes} raw, ${rowCount} rows`)
  return { days, symbols, universes, sector, spy: id('SPY'), coverage }
}
