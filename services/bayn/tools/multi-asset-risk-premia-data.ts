import { createHash } from 'node:crypto'

import { S3Client } from 'bun'
import { Config, Data, Effect, Redacted, Schema } from 'effect'

import { etfs, indexOf, splits } from './multi-asset-risk-premia-protocol'
import type { Split } from './multi-asset-risk-premia-protocol'
import type { Bar, Session } from './multi-asset-risk-premia-signals'

const prefix = 'bayn-research-datasets/2026-11-27-sip-10yr-sp100/'
const key = `${prefix}alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz`
const rawSha256 = 'e5331bb57e6f6427449d0cd3ab59291f56e508cb8c3961557bfd1374a635c9a8'
const gzipSha256 = 'fdda4017ee662fae548d8111a970ea90d83b3e8ee6f61abd6153be0fe83547d2'
const rowCount = 450_712
export const calendarTail = ['2026-11-27', '2026-11-30'] as const

const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-10yr-sp100-manifest.v1'),
    source: Schema.String,
    totalSymbols: Schema.Literal(165),
    etfs: Schema.Array(Schema.Literals(etfs)),
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

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

const symbols = new Map<string, number>(etfs.map((symbol, i) => [symbol, i]))
const knownGap = (i: number, date: string) =>
  (i === indexOf('XLC') && date < '2018-06-19') ||
  (i === indexOf('XLRE') && (date === '2016-01-25' || date === '2016-02-16'))

const timestampPattern = /^\d{4}-\d{2}-\d{2}T0[45]:00:00Z$/
export const splitRange = (sessions: readonly Session[], split: Split) => {
  const [start, end, count] = splits[split]
  const first = sessions.findIndex(({ date }) => date === start)
  const last = sessions.findIndex(({ date }) => date === end)
  if (first < 0 || last - first + 1 !== count) throw new Error(`Unexpected ${split} calendar: ${first}..${last}`)
  return { first, last }
}

/** Development rows are discarded by timestamp before accessing any Holdout OHLC fields. */
export const parseDailyBars = (raw: Uint8Array, through: string, expectedRows: number): Session[] => {
  const rows = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  const byDate = new Map<string, (Bar | undefined)[]>()
  const lastSeen = new Map<number, string>()
  let lineCount = 0
  for (let start = 0; start < rows.length; ) {
    const newline = rows.indexOf('\n', start)
    const end = newline === -1 ? rows.length : newline
    const symbolEnd = rows.indexOf('\t', start)
    const timestampEnd = rows.indexOf('\t', symbolEnd + 1)
    if (symbolEnd < start || timestampEnd >= end || timestampEnd < 0)
      throw new Error(`Malformed TSV row ${lineCount + 1}`)
    const symbol = symbols.get(rows.slice(start, symbolEnd))
    const timestamp = rows.slice(symbolEnd + 1, timestampEnd)
    lineCount++
    start = end + 1
    if (symbol === undefined) continue
    const date = timestamp.slice(0, 10)
    if (date > through) continue
    const [open, high, low, close, volume, vwap, ...extra] = rows
      .slice(timestampEnd + 1, end)
      .split('\t')
      .map(Number)
    if (
      !timestampPattern.test(timestamp) ||
      new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date ||
      !(date >= splits.train[0]) ||
      date <= (lastSeen.get(symbol) ?? '') ||
      extra.length > 0 ||
      ![open, high, low, close, volume, vwap].every((value) => Number.isFinite(value) && value > 0) ||
      low > Math.min(open, close) ||
      high < Math.max(open, close)
    )
      throw new Error(`Invalid daily bar ${etfs[symbol]} ${timestamp} (row ${lineCount})`)
    const bars = byDate.get(date) ?? Array.from<Bar | undefined>({ length: etfs.length })
    bars[symbol] = { open, high, low, close }
    byDate.set(date, bars)
    lastSeen.set(symbol, date)
  }
  if (lineCount !== expectedRows) throw new Error(`Expected ${expectedRows} rows, observed ${lineCount}`)
  return [...byDate]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bars]) => {
      for (let i = 0; i < etfs.length; i++) {
        if (bars[i] === undefined && !knownGap(i, date)) {
          throw new Error(`Missing daily bar ${etfs[i]} ${date}`)
        }
      }
      return { date, bars }
    })
}

class DatasetError extends Data.TaggedError('MultiAssetDatasetError')<{ readonly cause: unknown }> {}

export const loadDataset = (stage: 'freeze' | 'score') =>
  Effect.gen(function* () {
    const endpoint = yield* Config.String('AGENTS_ARTIFACTS_ENDPOINT').pipe(
      Config.withDefault('http://rook-ceph-rgw-objectstore.rook-ceph.svc:80'),
    )
    const bucket = yield* Config.String('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('agents-artifacts'))
    const accessKeyId = yield* Config.Redacted('AWS_ACCESS_KEY_ID')
    const secretAccessKey = yield* Config.Redacted('AWS_SECRET_ACCESS_KEY')
    const client = new S3Client({
      endpoint,
      bucket,
      region: 'us-east-1',
      accessKeyId: Redacted.value(accessKeyId),
      secretAccessKey: Redacted.value(secretAccessKey),
    })
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const transfer = async (name: string) => {
          const reader = client.file(name).stream().getReader()
          const stop = () => void reader.cancel().catch(() => undefined)
          signal.addEventListener('abort', stop, { once: true })
          try {
            const chunks: Uint8Array[] = []
            let bytes = 0
            for (;;) {
              const chunk = await reader.read()
              signal.throwIfAborted()
              if (chunk.done) break
              chunks.push(chunk.value)
              bytes += chunk.value.length
              if (bytes > 10_000_000) throw new Error(`Oversized input: ${name}`)
            }
            return Buffer.concat(chunks, bytes)
          } finally {
            signal.removeEventListener('abort', stop)
            await reader.cancel()
            reader.releaseLock()
          }
        }
        const manifestBytes = await transfer(`${prefix}MANIFEST.json`)
        const manifest = decodeManifest(JSON.parse(new TextDecoder().decode(manifestBytes)))
        const file = manifest.files.find((entry) => entry.key === key)
        if (
          file === undefined ||
          manifest.files.length !== 1 ||
          !manifest.source.includes('feed=sip, adjustment=all') ||
          new Set(manifest.etfs).size !== etfs.length ||
          manifest.etfs.length !== etfs.length ||
          file.rows !== rowCount ||
          file.rawSha256 !== rawSha256 ||
          file.gzipSha256 !== gzipSha256 ||
          file.rawBytes !== 29_435_892 ||
          file.gzipBytes !== 9_338_659
        )
          throw new Error('Unexpected SIP manifest')
        const compressed = await transfer(key)
        if (compressed.byteLength !== file.gzipBytes || sha256(compressed) !== gzipSha256)
          throw new Error('SIP gzip identity mismatch')
        const raw = Bun.gunzipSync(compressed)
        if (raw.byteLength !== file.rawBytes || sha256(raw) !== rawSha256) throw new Error('SIP TSV identity mismatch')
        const sessions = parseDailyBars(raw, stage === 'freeze' ? splits.validation[1] : splits.holdout[1], rowCount)
        splitRange(sessions, 'train')
        splitRange(sessions, 'validation')
        if (stage === 'score') splitRange(sessions, 'holdout')
        return { sessions, data: { key, manifestSha256: sha256(manifestBytes), gzipSha256, rawSha256, rows: rowCount } }
      },
      catch: (cause) => new DatasetError({ cause }),
    })
  })
