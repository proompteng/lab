import { S3Client } from 'bun'
import { Config, Data, Effect, Redacted, Schema } from 'effect'

import { type Etf, universe } from '../../src/strategy/macro-etf-core/policy'
import { gunzipBound, receipts } from '../pure-etf-dual-horizon-data'
import { noiseRosters } from '../pure-etf-dual-horizon-noise'
import { normalizeResearchCalendar } from '../research-orb-zab-data'

const { datasets, calendars } = receipts
type Dataset = (typeof datasets)[keyof typeof datasets]
export type Bar = { readonly open: number; readonly high: number; readonly low: number; readonly close: number }
export type DailyFrame = {
  readonly date: string
  readonly openAt: number
  readonly closeAt: number
  readonly bars: ReadonlyMap<Etf, Bar>
}
const noiseRoster = noiseRosters.I1
type NoiseEtf = (typeof noiseRoster)[number]
export type IntradayFrame = {
  readonly date: string
  readonly slots: number
  readonly bars: ReadonlyMap<NoiseEtf, readonly (Bar | undefined)[]>
}
const dailySymbols = new Set<string>(universe)
const intradaySymbols = new Set<string>(noiseRoster)

class ArchiveError extends Data.TaggedError('MacroEtfCoreArchiveError')<{ readonly cause: unknown }> {}

const readObject = async (client: S3Client, key: string, signal: AbortSignal) => {
  let response: Response
  try {
    response = await fetch(client.presign(key, { expiresIn: 60 }), { signal, redirect: 'error' })
  } catch (cause) {
    // Transport errors can embed the signed URL.
    throw new Error(`Unable to fetch frozen archive ${key}: ${cause instanceof Error ? cause.name : 'transport error'}`)
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new Error(`Unable to read frozen archive ${key}: HTTP ${response.status}`)
  }
  return response
}
const verifiedObject = async (client: S3Client, key: string, expected: string, signal: AbortSignal) => {
  const bytes = await (await readObject(client, key, signal)).bytes()
  if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== expected)
    throw new Error(`Frozen object digest mismatch: ${key}`)
  return bytes
}

const verifiedLines = async (
  client: S3Client,
  receipt: Dataset,
  signal: AbortSignal,
  onLine: (line: string, index: number) => void,
) => {
  const response = await readObject(client, `${receipt.prefix}/${receipt.name}`, signal)
  if (response.body === null) throw new Error(`Missing archive body: ${receipt.name}`)
  const reader = gunzipBound(response.body, receipt).getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const rawHash = new Bun.CryptoHasher('sha256')
  let rows = 0
  let rest = ''
  let bytes = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if ('rawSha256' in receipt) rawHash.update(value)
      bytes += value.length
      const lines = (rest + decoder.decode(value, { stream: true })).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) onLine(line, rows++)
    }
    signal.throwIfAborted()
    rest += decoder.decode()
    if (rest.length > 0) onLine(rest, rows++)
    if ('rawSha256' in receipt && (bytes !== receipt.rawBytes || rawHash.digest('hex') !== receipt.rawSha256))
      throw new Error(`Decoded byte receipt mismatch: ${receipt.name}`)
    return rows
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const readCalendar = async (
  client: S3Client,
  receipt: (typeof calendars)[keyof typeof calendars],
  signal: AbortSignal,
): Promise<unknown> => {
  const bytes = await verifiedObject(client, `${receipt.prefix}/${receipt.name}`, receipt.sha256, signal)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
const decodeBlindCalendar = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ date: Schema.String, open: Schema.String, close: Schema.String })),
)
const first = '2016-01-04'
const seam = '2023-12-29'
const last = '2026-11-25'

const bar = (fields: readonly string[], volumeAt: number, label: string): Bar => {
  const [open, high, low, close, volume] = fields.slice(2, 7).map(Number)
  if (
    ![open, high, low, close, volume, Number(fields[volumeAt])].every((v) => Number.isFinite(v) && v > 0) ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    !Number.isSafeInteger(volume)
  )
    throw new Error(`Invalid OHLCV: ${label}`)
  return { open, high, low, close }
}

const load = async (client: S3Client, signal: AbortSignal) => {
  for (const dataset of Object.values(datasets))
    await verifiedObject(client, `${dataset.prefix}/MANIFEST.json`, dataset.manifestSha256, signal)
  const blind = normalizeResearchCalendar({
    query: { start: first, end: seam },
    response: decodeBlindCalendar(await readCalendar(client, calendars.blind, signal)),
  })
  const recent = normalizeResearchCalendar(await readCalendar(client, calendars.recent, signal)).filter(
    ({ date }) => date <= last,
  )
  if (
    blind.length !== 2_012 ||
    blind[0]?.date !== first ||
    blind.at(-1)?.date !== seam ||
    recent.length !== 729 ||
    recent[0]?.date !== '2024-01-02' ||
    recent.at(-1)?.date !== last
  )
    throw new Error('Unexpected frozen calendar counts or endpoint sessions')
  const calendar = [...blind, ...recent]
  const byDate = new Map(calendar.map(({ date }) => [date, new Map<Etf, Bar>()]))
  for (const kind of ['daily', 'macro'] as const) {
    const receipt = datasets[kind]
    const seen = new Map<Etf, string>()
    const rows = await verifiedLines(client, receipt, signal, (line) => {
      const symbol = line.slice(0, line.indexOf('\t')) as Etf
      if (!dailySymbols.has(symbol)) return
      const fields = line.split('\t')
      const date = fields[1]?.slice(0, 10)
      const bars = byDate.get(date)
      if (
        fields.length !== 8 ||
        !/^\d{4}-\d{2}-\d{2}T0[45]:00:00Z$/.test(fields[1]) ||
        bars === undefined ||
        date <= (seen.get(symbol) ?? '') ||
        (kind === 'macro') !== (symbol === 'DIA' || symbol === 'UUP')
      )
        throw new Error(`Malformed, unordered or duplicate ${kind} row: ${symbol} ${fields[1]}`)
      bars.set(symbol, bar(fields, 7, `${symbol} ${date}`))
      seen.set(symbol, date)
    })
    if (rows !== receipt.rows) throw new Error(`Unexpected ${kind} row count: ${rows}`)
  }
  const daily: DailyFrame[] = calendar.map(({ date, openMs, minutes }) => {
    const bars = byDate.get(date)
    if (bars === undefined) throw new Error(`Missing session: ${date}`)
    for (const symbol of universe) {
      const knownGap =
        (symbol === 'XLC' && date < '2018-06-19') ||
        (symbol === 'XLRE' && (date === '2016-01-25' || date === '2016-02-16'))
      if (bars.has(symbol) === knownGap) throw new Error(`Unexpected daily coverage: ${symbol} ${date}`)
    }
    return { date, openAt: openMs, closeAt: openMs + minutes * 60_000, bars }
  })
  const intraday: IntradayFrame[] = []
  const coverage = []
  for (const [kind, sessions] of [
    ['blind', blind],
    ['recent', recent],
  ] as const) {
    const receipt = datasets[kind]
    const frames = new Map(
      sessions.map((session) => [
        session.date,
        {
          session,
          bars: new Map<NoiseEtf, (Bar | undefined)[]>(),
        },
      ]),
    )
    const outsideRth = new Map<NoiseEtf, number>()
    const accepted = new Map<NoiseEtf, number>()
    const lastSeen = new Map<NoiseEtf, number>()
    let header = 0
    const rows = await verifiedLines(client, receipt, signal, (line, index) => {
      if (kind === 'blind' && index === 0 && line === 'symbol\tt\to\th\tl\tc\tv\tn\tvw') {
        header++
        return
      }
      const symbol = line.slice(0, line.indexOf('\t')) as NoiseEtf
      if (!intradaySymbols.has(symbol)) return
      const fields = line.split('\t')
      const stamp = fields[1]
      const frame = frames.get(stamp?.slice(0, 10))
      const time = Date.parse(stamp)
      if (
        fields.length !== (kind === 'blind' ? 9 : 8) ||
        !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00(?:\.0+)?(?:Z|\+00:00)$/.test(stamp) ||
        !Number.isFinite(time) ||
        time <= (lastSeen.get(symbol) ?? -Infinity) ||
        frame === undefined
      )
        throw new Error(`Invalid, unordered or duplicate ${kind} bar: ${symbol} ${stamp}`)
      lastSeen.set(symbol, time)
      const slots = frame.session.minutes / 5
      const slot = (time - frame.session.openMs) / 300_000
      if (!Number.isInteger(slot)) throw new Error(`Off-grid bar: ${symbol} ${stamp}`)
      if (kind === 'blind' && (!Number.isSafeInteger(Number(fields[7])) || Number(fields[7]) <= 0))
        throw new Error(`Invalid SIP trade count: ${symbol} ${stamp}`)
      const parsed = bar(fields, fields.length - 1, `${symbol} ${stamp}`)
      if (slot < 0 || slot >= slots) {
        outsideRth.set(symbol, (outsideRth.get(symbol) ?? 0) + 1)
        return
      }
      let series = frame.bars.get(symbol)
      if (series === undefined) {
        series = Array.from({ length: slots })
        frame.bars.set(symbol, series)
      }
      series[slot] = parsed
      accepted.set(symbol, (accepted.get(symbol) ?? 0) + 1)
    })
    if (rows - header !== receipt.rows) throw new Error(`Unexpected ${kind} row count: ${rows - header}`)
    for (const [date, { session, bars }] of frames) {
      if (noiseRoster.some((symbol) => !bars.has(symbol))) throw new Error(`Missing Noise ETF session: ${date}`)
      intraday.push({ date, slots: session.minutes / 5, bars })
    }
    coverage.push({
      archive: kind,
      rows: rows - header,
      regular: Object.fromEntries(accepted),
      outsideRth: Object.fromEntries(outsideRth),
    })
  }
  return { daily, intraday, coverage }
}

export const loadFrozenFrames = Effect.gen(function* () {
  const config = yield* Config.all({
    endpoint: Config.String('AGENTS_ARTIFACTS_ENDPOINT'),
    bucket: Config.String('AGENTS_ARTIFACTS_BUCKET'),
    accessKeyId: Config.Redacted('AWS_ACCESS_KEY_ID'),
    secretAccessKey: Config.Redacted('AWS_SECRET_ACCESS_KEY'),
  })
  if (config.bucket !== receipts.bucket || config.endpoint !== 'http://rook-ceph-rgw-objectstore.rook-ceph.svc:80')
    return yield* new ArchiveError({ cause: 'Expected the frozen Rook-Ceph agents-artifacts source' })
  return yield* Effect.tryPromise({
    try: (signal) =>
      load(
        new S3Client({
          endpoint: config.endpoint,
          bucket: config.bucket,
          accessKeyId: Redacted.value(config.accessKeyId),
          secretAccessKey: Redacted.value(config.secretAccessKey),
          region: 'us-east-1',
        }),
        signal,
      ),
    catch: (cause) => new ArchiveError({ cause }),
  })
})
