import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'

import { S3Client } from 'bun'
import { Config, Redacted, Schema } from 'effect'

import { end, listing, splits, type Frequency } from './pairs-pead-protocol'

const prefix = 'bayn-research-datasets/2026-11-27-sip-multiyear/'
const calendarKey = 'bayn-research-datasets/2026-11-27/calendar_2024_2026.json'
const barNames = {
  intraday: 'alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz',
  daily: 'alpaca_sip_daily_62sym_20210104_20261125.tsv.gz',
} as const
const receipts = {
  daily: { rows: 87727, rawSha256: 'f8aa513adb97988a86190e94f837e5a1097fa7f40481665a2dd55210498dd075' },
  intraday: { rows: 3923737, rawSha256: 'c053ede2875ad791c99aae517db9efa9a4587b08c9907d55e0960dade59d567e' },
}
const calendarHash = 'b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71'
export const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
export const clientConfig = Config.all({
  endpoint: Config.String('AGENTS_ARTIFACTS_ENDPOINT').pipe(
    Config.withDefault('http://rook-ceph-rgw-objectstore.rook-ceph.svc:80'),
  ),
  bucket: Config.String('AGENTS_ARTIFACTS_BUCKET').pipe(Config.withDefault('agents-artifacts')),
  accessKeyId: Config.Redacted('AWS_ACCESS_KEY_ID'),
  secretAccessKey: Config.Redacted('AWS_SECRET_ACCESS_KEY'),
})

const manifestSchema = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-multiyear-dataset-manifest.v1'),
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
const calendarSchema = Schema.decodeUnknownSync(
  Schema.Struct({
    response: Schema.Array(
      Schema.Struct({
        date: Schema.String,
        open: Schema.Literal('09:30'),
        close: Schema.Literals(['13:00', '16:00']),
      }),
    ),
  }),
)
export const minute = 60_000
export const dayMs = 86_400_000
const slots = 78

export type Session = { date: string; epoch: number; open: number; slots: number }
export type Bars = Record<'open' | 'high' | 'low' | 'close' | 'volume' | 'vwap', Float64Array>
export type Market = {
  sessions: readonly Session[]
  series: ReadonlyMap<string, Bars>
  stride: number
  observed: Record<string, number>
  outsideRth: number
}
type FileReceipt = ReturnType<typeof manifestSchema>['files'][number]

export const calendarSessions = (text: string): readonly Session[] => {
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' })
  let previous = ''
  return calendarSchema(JSON.parse(text)).response.map(({ date, close }) => {
    const epoch = Date.parse(date)
    if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date || date <= previous)
      throw new Error('Invalid calendar date: ' + date)
    previous = date
    const offset = 12 - Number(zone.format(epoch + 12 * 60 * minute))
    return { date, epoch, open: epoch + (9 * 60 + 30 + offset * 60) * minute, slots: close === '13:00' ? 42 : slots }
  })
}

export const makeBars = (length: number): Bars => ({
  open: new Float64Array(length),
  high: new Float64Array(length),
  low: new Float64Array(length),
  close: new Float64Array(length),
  volume: new Float64Array(length),
  vwap: new Float64Array(length),
})

const dailyDays = (until: string) =>
  Array.from({ length: (Date.parse(until) - Date.parse(splits.daily[0].from)) / dayMs + 1 }, (_, i) => {
    const epoch = Date.parse(splits.daily[0].from) + i * dayMs
    return { date: new Date(epoch).toISOString().slice(0, 10), epoch, open: 0, slots: 1 }
  })

export const readBars = async (
  source: Readable,
  symbols: readonly string[],
  calendar: readonly Session[],
  frequency: Frequency,
  until: string,
  receipt: FileReceipt,
  signal: AbortSignal,
): Promise<Market> => {
  const stride = frequency === 'daily' ? 1 : slots
  const days = frequency === 'daily' ? dailyDays(until) : calendar.filter((d) => d.date <= until)
  const index = new Map(days.map((d, i) => [d.date, i]))
  const series = new Map(symbols.map((symbol) => [symbol, makeBars(days.length * stride)]))
  const observed: Record<string, number> = Object.fromEntries(symbols.map((symbol) => [symbol, 0]))
  const rawHash = createHash('sha256')
  const gzipHash = createHash('sha256')
  const gunzip = createGunzip()
  let rawBytes = 0
  let gzipBytes = 0
  let rows = 0
  let outsideRth = 0
  source.on('data', (chunk: Buffer) => {
    gzipHash.update(chunk)
    gzipBytes += chunk.length
  })
  source.on('error', (error) => gunzip.destroy(error))
  gunzip.on('data', (chunk: Buffer) => {
    rawHash.update(chunk)
    rawBytes += chunk.length
  })
  // A stream error must reject even when readline has not observed its first record.
  const finished = new Promise<void>((resolve, reject) => {
    gunzip.once('end', resolve)
    gunzip.once('error', reject)
  })
  const abort = () => {
    source.destroy()
    gunzip.destroy(new Error('SIP read aborted'))
  }
  signal.addEventListener('abort', abort, { once: true })
  const consume = async () => {
    for await (const line of createInterface({ input: gunzip, crlfDelay: Infinity })) {
      rows++
      const first = line.indexOf('\t')
      const date = line.slice(first + 1, first + 11)
      // Hash the opaque holdout tail, but never decode, retain, or use its bars in development.
      if (date > until) continue
      const d = index.get(date)
      const symbol = line.slice(0, first)
      const bars = series.get(symbol)
      if (d === undefined || bars === undefined) throw new Error(`Unexpected date/symbol: ${receipt.key}:${rows}`)
      const session = days[d]
      const [time, ...values] = line.slice(first + 1).split('\t')
      const stamp = Date.parse(time)
      const slot = frequency === 'daily' ? 0 : (stamp - session.open) / (5 * minute)
      if (!Number.isFinite(stamp) || !Number.isInteger(slot))
        throw new Error(`Invalid timestamp: ${receipt.key}:${rows}`)
      if (slot < 0 || slot >= session.slots) {
        outsideRth++
        continue
      }
      if (date < (listing[symbol] ?? '')) continue
      const [o, h, l, c, v, w] = values.map(Number)
      const at = d * stride + slot
      if (
        values.length !== 6 ||
        bars.open[at] !== 0 ||
        ![o, h, l, c, v, w].every((n) => Number.isFinite(n) && n > 0) ||
        h < Math.max(o, c, l) ||
        l > Math.min(o, c)
      )
        throw new Error(`Invalid or duplicate OHLCV: ${receipt.key}:${rows}`)
      bars.open[at] = o
      bars.high[at] = h
      bars.low[at] = l
      bars.close[at] = c
      bars.volume[at] = v
      bars.vwap[at] = w
      observed[symbol]++
    }
  }
  try {
    const parsed = consume()
    source.pipe(gunzip)
    if (signal.aborted) abort()
    await Promise.all([parsed, finished])
  } finally {
    signal.removeEventListener('abort', abort)
    source.destroy()
    gunzip.destroy()
  }
  if (
    rows !== receipt.rows ||
    rawBytes !== receipt.rawBytes ||
    gzipBytes !== receipt.gzipBytes ||
    rawHash.digest('hex') !== receipt.rawSha256 ||
    gzipHash.digest('hex') !== receipt.gzipSha256
  )
    throw new Error('SIP bytes do not match manifest: ' + receipt.key)
  if (frequency === 'intraday') return { sessions: days, series, stride, observed, outsideRth }
  const spy = series.get('SPY')
  if (spy === undefined) throw new Error('SPY daily session spine missing')
  const trading = days.flatMap((_, i) => (spy.open[i] > 0 ? [i] : []))
  if (
    trading.some((i) => days[i].date >= '2024-01-02' && !calendar.some((d) => d.date === days[i].date)) ||
    calendar.some((d) => d.date <= until && spy.open[index.get(d.date) ?? -1] === 0) ||
    days.some((_, i) => spy.open[i] === 0 && [...series.values()].some((b) => b.open[i] > 0))
  )
    throw new Error('Daily session spine disagrees with calendar or instrument bars')
  const packed = new Map(
    [...series].map(([symbol, bars]) => {
      const result = makeBars(trading.length)
      for (const field of Object.keys(result) as (keyof Bars)[]) {
        for (const [i, j] of trading.entries()) result[field][i] = bars[field][j]
      }
      return [symbol, result]
    }),
  )
  return { sessions: trading.map((i) => days[i]), series: packed, stride, observed, outsideRth }
}

export const load = async (
  config: {
    endpoint: string
    bucket: string
    accessKeyId: Redacted.Redacted<string>
    secretAccessKey: Redacted.Redacted<string>
  },
  score: boolean,
  signal: AbortSignal,
) => {
  const s3 = new S3Client({
    ...config,
    region: 'us-east-1',
    accessKeyId: Redacted.value(config.accessKeyId),
    secretAccessKey: Redacted.value(config.secretAccessKey),
  })
  const readText = async (key: string) => {
    const response = await fetch(s3.presign(key, { expiresIn: 300 }), { signal })
    if (!response.ok) throw new Error(`SIP object ${key}: HTTP ${response.status}`)
    return response.text()
  }
  const manifestText = await readText(prefix + 'MANIFEST.json')
  const manifest = manifestSchema(JSON.parse(manifestText))
  const calendarText = await readText(calendarKey)
  if (sha256(calendarText) !== calendarHash) throw new Error('Invalid frozen calendar hash')
  const calendar = calendarSessions(calendarText)
  const core = [...manifest.universes.bayn21, ...manifest.universes.expanded29]
  const symbols = [...core, ...manifest.universes.sectorMacro12]
  if (core.length !== 50 || new Set(symbols).size !== 62 || symbols.join(',') !== manifest.universes.all62.join(','))
    throw new Error('Unexpected SIP universe')
  const files = (['daily', 'intraday'] as const).map((frequency) => {
    const receipt = manifest.files.find((f) => f.key === prefix + barNames[frequency])
    if (
      receipt === undefined ||
      receipt.rows !== receipts[frequency].rows ||
      receipt.rawSha256 !== receipts[frequency].rawSha256
    )
      throw new Error('Invalid manifest receipt: ' + frequency)
    return receipt
  })
  const get = async (frequency: Frequency, receipt: FileReceipt) => {
    const response = await fetch(s3.presign(receipt.key, { expiresIn: 300 }), { signal })
    if (!response.ok || response.body === null) throw new Error(`SIP object ${receipt.key}: HTTP ${response.status}`)
    return readBars(
      Readable.from(response.body),
      symbols,
      calendar,
      frequency,
      score ? end : splits[frequency][1].to,
      receipt,
      signal,
    )
  }
  const daily = await get('daily', files[0])
  const intraday = await get('intraday', files[1])
  return {
    daily,
    intraday,
    core,
    provenance: { manifestSha256: sha256(manifestText), calendarKey, calendarHash, files },
  }
}
