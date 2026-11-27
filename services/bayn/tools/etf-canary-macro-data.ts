import { createHash } from 'node:crypto'

import { S3Client } from 'bun'
import { Config, Data, Effect, Redacted, Schema } from 'effect'

import { asset, etfs, splits } from './etf-canary-macro-protocol'

const prefix = 'bayn-research-datasets/2026-11-27-sip-10yr-sp100/'
const manifestKey = prefix + 'MANIFEST.json'
const key = prefix + 'alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz'
const manifestSha256 = 'ffaa9d30d69d38307f69ec77f07c12cdd82c7407131a110bc3b88421b0f1676e'
const gzipSha256 = 'fdda4017ee662fae548d8111a970ea90d83b3e8ee6f61abd6153be0fe83547d2'
const rawSha256 = 'e5331bb57e6f6427449d0cd3ab59291f56e508cb8c3961557bfd1374a635c9a8'
const rowCount = 450_712
const gap = (i: number, date: string) =>
  (i === asset('XLC') && date < '2018-06-19') ||
  (i === asset('XLRE') && (date === '2016-01-25' || date === '2016-02-16'))

const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-10yr-sp100-manifest.v1'),
    source: Schema.String,
    etfs: Schema.Array(Schema.String),
    files: Schema.Array(
      Schema.Struct({
        key: Schema.Literal(key),
        rows: Schema.Literal(rowCount),
        rawBytes: Schema.Literal(29_435_892),
        gzipBytes: Schema.Literal(9_338_659),
        rawSha256: Schema.Literal(rawSha256),
        gzipSha256: Schema.Literal(gzipSha256),
      }),
    ),
  }),
)

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export type Session = { date: string; open: Float64Array; close: Float64Array }
const indices = new Map<string, number>(etfs.map((symbol, i) => [symbol, i]))
const timestampPattern = /^\d{4}-\d{2}-\d{2}T0[45]:00:00Z$/

type Allowed = ReadonlySet<string>

export const collectBars = (
  raw: Uint8Array,
  through: string,
  onDate: Map<string, Session>,
  allowed: Allowed,
  expectedRows: number,
) => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  const last = new Map<number, string>()
  let count = 0
  for (let cursor = 0; cursor < text.length; ) {
    const newline = text.indexOf('\n', cursor)
    const end = newline === -1 ? text.length : newline
    const a = text.indexOf('\t', cursor)
    const b = text.indexOf('\t', a + 1)
    if (a < cursor || b < a || b >= end) throw new Error('Invalid TSV row ' + (count + 1))
    const symbol = text.slice(cursor, a)
    const stamp = text.slice(a + 1, b)
    count++
    cursor = end + 1
    if (!allowed.has(symbol)) continue
    const i = indices.get(symbol)
    if (i === undefined) throw new Error('Unknown ETF ' + symbol)
    const date = stamp.slice(0, 10)
    // Do not decode Holdout prices in development, even when shipped in a combined object.
    if (date > through) continue
    const [open, high, low, close, volume, vwap, ...extra] = text
      .slice(b + 1, end)
      .split('\t')
      .map(Number)
    if (
      !timestampPattern.test(stamp) ||
      date < splits.train[0] ||
      date <= (last.get(i) ?? '') ||
      extra.length !== 0 ||
      ![open, high, low, close, volume, vwap].every((v) => Number.isFinite(v) && v > 0) ||
      low > Math.min(open, close) ||
      high < Math.max(open, close)
    ) {
      throw new Error(`Invalid daily bar: ${symbol} ${stamp}`)
    }
    let session = onDate.get(date)
    if (session === undefined) {
      session = { date, open: new Float64Array(etfs.length), close: new Float64Array(etfs.length) }
      onDate.set(date, session)
    }
    if (session.open[i] !== 0) throw new Error(`Duplicate ETF bar: ${symbol} ${date}`)
    session.open[i] = open
    session.close[i] = close
    last.set(i, date)
  }
  if (count !== expectedRows) throw new Error(`Expected ${expectedRows} TSV rows, found ${count}`)
}

export const verifyCalendar = (onDate: ReadonlyMap<string, Session>, score: boolean) => {
  const sessions = [...onDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  let offset = 0
  for (const [from, through, count] of [splits.train, splits.validation, ...(score ? [splits.holdout] : [])]) {
    if (sessions[offset]?.date !== from || sessions[offset + count - 1]?.date !== through) {
      throw new Error(`Unexpected SIP calendar: ${from}..${through}, expected ${count} sessions`)
    }
    offset += count
  }
  if (offset !== sessions.length) throw new Error('Unexpected trailing sessions')
  const coverage = Object.fromEntries(
    etfs.map((symbol, i) => {
      let bars = 0
      for (const day of sessions) {
        if (day.open[i] > 0) bars++
        else if (!gap(i, day.date)) throw new Error(`Missing required ETF ${symbol} on ${day.date}`)
      }
      return [symbol, bars]
    }),
  )
  return { sessions, coverage }
}

class DatasetError extends Data.TaggedError('CanaryMacroDatasetError')<{
  readonly message: string
  readonly cause: unknown
}> {}

// A supplement must be supplied as an explicitly identified, already-frozen SIP export.
// Its exact bytes are bound to the pre-Holdout receipt; no vendor or proxy substitution.
export type Supplement = { source: string; bytes: Uint8Array<ArrayBuffer> }

export const load = (score: boolean, supplement: Supplement | null) =>
  Effect.gen(function* () {
    const endpoint = yield* Config.String('AGENTS_ARTIFACTS_ENDPOINT').pipe(
      Config.withDefault('http://rook-ceph-rgw-objectstore.rook-ceph.svc:80'),
    )
    const bucket = yield* Config.String('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('agents-artifacts'))
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
      try: async (signal) => {
        const get = async (object: string) => {
          let response: Response
          try {
            response = await fetch(s3.presign(object, { expiresIn: 300 }), { signal, redirect: 'error' })
          } catch (error) {
            // Fetch errors can include the signed request URL. Keep the object and error class, not the query.
            const code = error instanceof Error ? error.name : 'unknown transport error'
            throw new Error(`Cannot read SIP object ${object}: ${code}`)
          }
          if (!response.ok) throw new Error(`SIP object ${object}: HTTP ${response.status}`)
          return response.bytes()
        }
        const manifestBytes = await get(manifestKey)
        if (sha256(manifestBytes) !== manifestSha256) throw new Error('Frozen SIP manifest identity mismatch')
        const manifest = decodeManifest(JSON.parse(new TextDecoder().decode(manifestBytes)))
        const receipt = manifest.files[0]
        if (manifest.files.length !== 1 || !manifest.source.includes('feed=sip, adjustment=all'))
          throw new Error('Unexpected frozen SIP manifest contract')
        const present = new Set(etfs.filter((symbol) => manifest.etfs.includes(symbol)))
        const missing = etfs.filter((symbol) => !present.has(symbol))
        if (supplement === null)
          throw new Error(`Frozen SIP object lacks ${missing.join(', ')}; supply the approved total-return supplement`)
        if (missing.join(',') !== 'DIA,UUP') throw new Error('Unexpected SIP supplement scope')
        const compressed = await get(key)
        if (compressed.length !== receipt.gzipBytes || sha256(compressed) !== gzipSha256)
          throw new Error('Frozen SIP gzip identity mismatch')
        const raw = Bun.gunzipSync(compressed)
        if (raw.length !== receipt.rawBytes || sha256(raw) !== rawSha256)
          throw new Error('Frozen SIP TSV identity mismatch')
        const through = score ? splits.holdout[1] : splits.validation[1]
        const onDate = new Map<string, Session>()
        collectBars(raw, through, onDate, present, rowCount)
        collectBars(Bun.gunzipSync(supplement.bytes), through, onDate, new Set(missing), 2741 * missing.length)
        return {
          ...verifyCalendar(onDate, score),
          provenance: {
            key,
            manifestSha256,
            gzipSha256,
            rawSha256,
            rowCount,
            supplement: { source: supplement.source, gzipSha256: sha256(supplement.bytes), symbols: missing },
          },
        }
      },
      catch: (cause) => new DatasetError({ message: 'Cannot verify frozen Wave 4D SIP inputs', cause }),
    })
  })
