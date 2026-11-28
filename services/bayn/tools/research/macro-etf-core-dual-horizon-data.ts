import { Effect, Result } from 'effect'

import { canonicalHashV1Result } from '../../src/hash'
import { type Etf, universe } from '../../src/strategy/macro-etf-core/policy'
import { closeSnapshotSchema } from '../../src/strategy/macro-etf-core/signals'
import { receipts, tapeReceipt } from '../pure-etf-dual-horizon-data'
import { noiseRosters } from '../pure-etf-dual-horizon-noise'
import { normalizeResearchCalendar, requireCalendarCoverage } from '../research-lib/calendar'
import { type ArchiveReader, countArchiveLines, withS3Archive } from '../research-lib/s3-archive'

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

const verifiedLines = (archive: ArchiveReader, receipt: Dataset, onLine: (line: string, index: number) => void) =>
  archive.readGzip(tapeReceipt(receipt), countArchiveLines(onLine))

const loadDaily = async (archive: ArchiveReader) => {
  const { readJson } = archive
  for (const dataset of [datasets.daily, datasets.macro])
    await readJson(`${dataset.prefix}/MANIFEST.json`, dataset.manifestSha256)
  const readCalendar = (receipt: (typeof calendars)[keyof typeof calendars]) =>
    readJson(`${receipt.prefix}/${receipt.name}`, receipt.sha256)
  const blind = requireCalendarCoverage(
    normalizeResearchCalendar({ query: { start: first, end: seam }, response: await readCalendar(calendars.blind) }),
    first,
    seam,
    2_012,
  )
  const recent = requireCalendarCoverage(
    normalizeResearchCalendar(await readCalendar(calendars.recent)).filter(({ date }) => date <= last),
    '2024-01-02',
    last,
    729,
  )
  const calendar = [...blind, ...recent]
  const byDate = new Map(calendar.map(({ date }) => [date, new Map<Etf, Bar>()]))
  for (const kind of ['daily', 'macro'] as const) {
    const receipt = datasets[kind]
    const seen = new Map<Etf, string>()
    const rows = await verifiedLines(archive, receipt, (line) => {
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
  return { daily, blind, recent }
}

export const closeEvidence = (daily: readonly DailyFrame[]) => {
  const calendar = daily.map(({ date, openAt, closeAt }) => ({ date, openAt, closeAt }))
  const bars = daily
    .slice(0, -1)
    .map(({ date, closeAt, bars }) =>
      [...bars].map(([symbol, bar]) => ({ date, symbol, availableAt: closeAt, ...bar })),
    )
  const snapshot = {
    schema: closeSnapshotSchema,
    datasetVersion: 'alpacav2-sip-10yr-sp100-with-dia-uup-2026-11-27',
    adjustment: 'all',
    calendar,
    bars,
  }
  return {
    asOf: daily[daily.length - 1].openAt,
    snapshot,
    snapshotHash: Result.getOrThrow(canonicalHashV1Result(snapshot)),
  }
}

const load = async (archive: ArchiveReader) => {
  for (const dataset of [datasets.blind, datasets.recent])
    await archive.readJson(`${dataset.prefix}/MANIFEST.json`, dataset.manifestSha256)
  const { daily, blind, recent } = await loadDaily(archive)
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
    const rows = await verifiedLines(archive, receipt, (line, index) => {
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

export const loadFrozenFrames = withS3Archive(load)
export const loadFrozenDailyFrames = withS3Archive(loadDaily).pipe(
  Effect.map(({ daily }) => daily),
  Effect.timeout('1 minute'),
)
