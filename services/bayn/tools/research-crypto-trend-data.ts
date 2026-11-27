import { createHash } from 'node:crypto'
import { S3Client } from 'bun'
import { Config, Effect, Redacted, Schema } from 'effect'
import { date, dayMs, end, frames, symbols, venues, type Frame } from './research-crypto-trend-protocol'

const prefix = 'bayn-research-datasets/2026-11-27-crypto-3yr/'
const SafeCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const FileSchema = Schema.Struct({
  key: Schema.String,
  rows: SafeCount,
  rawBytes: SafeCount,
  gzipBytes: SafeCount,
  rawSha256: Hex,
  gzipSha256: Hex,
})
const ManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.crypto-multiyear-dataset-manifest.v1'),
  symbols: Schema.Array(Schema.String),
  files: Schema.Array(FileSchema),
})
type FileSpec = typeof FileSchema.Type
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export type Coin = {
  open: Float64Array
  high: Float64Array
  low: Float64Array
  close: Float64Array
}
export type Market = {
  start: number
  barsPerDay: number
  count: number
  coins: ReadonlyMap<string, Coin>
}

export const parseBars = (raw: string, frame: Frame, until: string, totalRows: number): Market => {
  const { start: first, barsPerDay } = venues[frame]
  const start = Date.parse(first)
  const stop = Date.parse(until)
  const step = dayMs / barsPerDay
  const count = (stop - start) / step
  const market = new Map(
    symbols.map((name) => [
      name,
      {
        open: new Float64Array(count),
        high: new Float64Array(count),
        low: new Float64Array(count),
        close: new Float64Array(count),
      },
    ]),
  )
  let rows = 0
  for (const line of raw.trimEnd().split('\n')) {
    rows++
    const [name, time, ...fields] = line.split('\t')
    // Partition by timestamp before decoding prices; freeze has no access to holdout bars.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(time) || time.slice(0, 10) >= end) {
      throw new Error(`Invalid bar timestamp on row ${rows}: ${time}`)
    }
    if (time.slice(0, 10) >= until) continue
    const ms = Date.parse(time)
    const i = (ms - start) / step
    const coin = market.get(name as (typeof symbols)[number])
    const [open, high, low, close, volume, vwap] = fields.map(Number)
    if (
      !coin ||
      !Number.isInteger(i) ||
      i < 0 ||
      i >= count ||
      new Date(ms).toISOString() !== time.replace('Z', '.000Z') ||
      fields.length !== 6 ||
      fields.some((field) => field.trim() === '') ||
      ![open, high, low, close, volume, vwap].every(Number.isFinite) ||
      low <= 0 ||
      low > Math.min(open, close) ||
      high < Math.max(open, close) ||
      volume < 0 ||
      vwap < 0 ||
      coin.open[i] !== 0
    )
      throw new Error(`Invalid or duplicate ${frame} bar on row ${rows}: ${name} ${time}`)
    coin.open[i] = open
    coin.high[i] = high
    coin.low[i] = low
    coin.close[i] = close
  }
  if (rows !== totalRows) throw new Error(`Expected ${totalRows} ${frame} rows; received ${rows}`)
  return { start, barsPerDay, count, coins: market }
}

export const coverage = (market: Market, from: string, until: string) => {
  const step = dayMs / market.barsPerDay
  const lo = (Date.parse(from) - market.start) / step
  const hi = (Date.parse(until) - market.start) / step
  return Object.fromEntries(
    [...market.coins].map(([name, coin]) => {
      let present = 0
      let first: number | null = null
      let last: number | null = null
      for (let i = lo; i < hi; i++) {
        if (coin.open[i] === 0) continue
        present++
        first ??= i
        last = i
      }
      const timestamp = (i: number) => new Date(market.start + i * step).toISOString()
      return [
        name,
        {
          present,
          missing: hi - lo - present,
          first: first === null ? null : timestamp(first),
          last: last === null ? null : timestamp(last),
          interiorMissing: first === null || last === null ? 0 : last - first + 1 - present,
        },
      ]
    }),
  )
}

const verifyFile = (spec: FileSpec, gzip: Uint8Array, frame: Frame, until: string) => {
  if (gzip.length !== spec.gzipBytes || sha256(gzip) !== spec.gzipSha256) {
    throw new Error(`Compressed size/hash mismatch: ${spec.key}`)
  }
  const raw = Bun.gunzipSync(gzip)
  if (raw.length !== spec.rawBytes || sha256(raw) !== spec.rawSha256) {
    throw new Error(`Uncompressed size/hash mismatch: ${spec.key}`)
  }
  return parseBars(new TextDecoder('utf8', { fatal: true }).decode(raw), frame, until, spec.rows)
}

export const loadMarkets = Effect.fn('researchCryptoTrend.loadMarkets')(function* (includeHoldout: boolean) {
  const endpoint = yield* Config.string('AGENTS_ARTIFACTS_ENDPOINT').pipe(
    Config.withDefault('http://rook-ceph-rgw-objectstore.rook-ceph.svc:80'),
  )
  const bucket = yield* Config.string('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('agents-artifacts'))
  const key = yield* Config.redacted('AWS_ACCESS_KEY_ID')
  const secret = yield* Config.redacted('AWS_SECRET_ACCESS_KEY')
  const s3 = new S3Client({
    endpoint,
    bucket,
    region: 'us-east-1',
    accessKeyId: Redacted.value(key),
    secretAccessKey: Redacted.value(secret),
  })
  const download = (key: string) =>
    Effect.tryPromise({
      try: async (signal) =>
        new Uint8Array(
          await Bun.readableStreamToArrayBuffer(
            s3.file(key).stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }),
          ),
        ),
      catch: (cause) => new Error(`S3 download failed: ${key}`, { cause }),
    })
  const manifestBytes = yield* download(prefix + 'MANIFEST.json')
  const manifestText = new TextDecoder('utf8', { fatal: true }).decode(manifestBytes)
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestSchema))(manifestText)
  if (manifest.symbols.join(',') !== symbols.join(',') || manifest.files.length !== frames.length) {
    return yield* Effect.fail(new Error('Unexpected frozen manifest universe or file count'))
  }
  const markets = new Map<Frame, Market>()
  for (const frame of frames) {
    const spec = manifest.files.find(({ key }) => key === prefix + venues[frame].key)
    if (!spec || spec.rows !== venues[frame].rows) {
      return yield* Effect.fail(new Error(`Missing or unexpected frozen manifest file: ${frame}`))
    }
    const bytes = yield* download(spec.key)
    const market = yield* Effect.try({
      try: () => verifyFile(spec, bytes, frame, includeHoldout ? end : venues[frame].holdout),
      catch: (cause) => new Error(`Frozen dataset rejected: ${spec.key}`, { cause }),
    })
    markets.set(frame, market)
  }
  return {
    identity: { manifestSha256: sha256(manifestBytes), files: manifest.files },
    market(frame: Frame) {
      const market = markets.get(frame)
      if (!market) throw new Error(`Missing loaded market: ${frame}`)
      return market
    },
  }
})
export const barIndex = (market: Market, day: string) => ((Date.parse(day) - market.start) / dayMs) * market.barsPerDay
export const barDay = (market: Market, i: number) => date(market.start + (i * dayMs) / market.barsPerDay)
