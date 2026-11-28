import { Schema } from 'effect'

import { type Day, Field, makeSeries, price } from './8yr-unseen-intraday-tape'
import { receipts, tapeReceipt } from './pure-etf-dual-horizon-data'
import { normalizeResearchCalendar, requireCalendarCoverage, type Session } from './research-lib/calendar'
import { type ArchiveReader, countArchiveLines, type GzipReceipt } from './research-lib/s3-archive'
import { flattenSlot, symbols } from './sector-etf-expansion-replay'

const first = '2016-01-04'
const developmentEnd = '2023-12-29'
const holdoutStart = '2024-01-02'
const last = '2026-11-25'
export const developmentSessions = 2_012
export const holdoutSessions = 729
const prefix = 'bayn-research-datasets/2026-11-27-sector-etf-intraday-expansion'
const supplementManifestSha256 = 'c53674d014b0d3d70f90a574746a8ea90ecf75fbac057e88903b590cbeee9cd0'
export const supplementSymbols = ['XLB', 'XLP', 'XLU'] as const
const baseSymbols = symbols.filter((symbol) => !supplementSymbols.some((name) => name === symbol))
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Count = Schema.Int.check(Schema.isGreaterThan(0))

enum SupplementSource {
  AlpacaSip5mRaw = 'alpaca-sip-5m-raw',
}

const decodeSupplement = Schema.decodeUnknownSync(
  Schema.Struct({
    schema: Schema.Literal('bayn.research.wave-18d.sip-supplement.v1'),
    source: Schema.Enum(SupplementSource),
    symbols: Schema.Array(Schema.Literals(supplementSymbols)),
    first: Schema.Literal(first),
    last: Schema.Literal(last),
    rows: Count,
    bytes: Count,
    sha256: Digest,
    rawBytes: Count,
    rawSha256: Digest,
  }),
)

const Roster = Schema.Array(Schema.String)
const decodeBlind = Schema.decodeUnknownSync(Schema.Struct({ symbols: Roster }))
const decodeRecent = Schema.decodeUnknownSync(Schema.Struct({ universes: Schema.Struct({ all62: Roster }) }))

const requireRoster = (raw: readonly string[], wanted: readonly string[], count: number, label: string) => {
  const declared = new Set(raw)
  if (declared.size !== count || raw.length !== count || wanted.some((symbol) => !declared.has(symbol)))
    throw new Error(`Unexpected ${label} archive roster`)
}

type SessionBars = { readonly session: Session; readonly bars: Map<string, Float64Array> }
const indexSessions = (sessions: readonly Session[]) =>
  new Map(sessions.map((session) => [session.date, { session, bars: new Map<string, Float64Array>() }]))

export enum Tape {
  Development,
  Continuity,
  Supplement,
}
const developmentHeader = 'symbol\tt\to\th\tl\tc\tv\tn\tvw'
const timestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00(?:\.0+)?(?:Z|\+00:00)$/

// The supplement is raw. Only XLB and XLU split in this interval (2:1, 2025-12-05).
const splitFactor = (symbol: string, date: string) =>
  (symbol === 'XLB' || symbol === 'XLU') && date < '2025-12-05' ? 2 : 1

export const loadTape = async (
  archive: ArchiveReader,
  index: ReadonlyMap<string, SessionBars>,
  kind: Tape,
  receipt: GzipReceipt,
  expectedRows: number,
  scoped: readonly string[],
) => {
  const development = kind === Tape.Development
  const supplemental = kind === Tape.Supplement
  const wanted = new Set(scoped)
  const seen = new Map<string, number>()
  const rows = await archive.readGzip(
    receipt,
    countArchiveLines((line, row) => {
      if (development && row === 0) {
        if (line !== developmentHeader) throw new Error('Missing registered development header')
        return
      }
      const symbol = line.slice(0, line.indexOf('\t'))
      if (!wanted.has(symbol)) {
        if (supplemental) throw new Error(`Unexpected supplement symbol at row ${row + 1}`)
        return
      }
      const fields = line.split('\t')
      const stamp = fields[1]
      const date = stamp?.slice(0, 10)
      const frame = index.get(date)
      const time = Date.parse(stamp)
      if (
        fields.length !== (development ? 9 : 8) ||
        !timestamp.test(stamp) ||
        !Number.isFinite(time) ||
        time <= (seen.get(symbol) ?? -Infinity) ||
        frame === undefined
      )
        throw new Error(`Invalid, duplicate or unordered SIP bar: ${symbol} row ${row + 1}`)
      seen.set(symbol, time)
      const slot = (time - frame.session.openMs) / 300_000
      const slots = frame.session.minutes / 5
      if (!Number.isInteger(slot)) throw new Error(`Off-grid SIP bar: ${symbol} ${stamp}`)
      if (slot < 0 || slot >= slots) {
        if (supplemental) throw new Error(`Outside-RTH supplement: ${symbol} ${stamp}`)
        return
      }
      const [open, high, low, close, volume] = fields.slice(2, 7).map(Number)
      const vwap = Number(fields.at(-1))
      const trades = development ? Number(fields[7]) : 1
      if (
        ![open, high, low, close, volume, vwap].every((value) => Number.isFinite(value) && value > 0) ||
        high < Math.max(open, close) ||
        low > Math.min(open, close) ||
        !Number.isSafeInteger(volume) ||
        !Number.isSafeInteger(trades) ||
        trades <= 0
      )
        throw new Error(`Invalid SIP OHLCV: ${symbol} ${stamp}`)
      const scale = supplemental ? splitFactor(symbol, date) : 1
      if (!Number.isSafeInteger(volume * scale)) throw new Error(`Invalid split-adjusted volume: ${symbol} ${stamp}`)
      const series = frame.bars.get(symbol) ?? makeSeries(slots)
      if (price(series, slot, Field.Open) !== 0) throw new Error(`Overlapping tape: ${symbol} ${stamp}`)
      const normalized = [open / scale, high / scale, low / scale, close / scale, volume * scale, vwap / scale]
      series.set(normalized, slot * normalized.length)
      frame.bars.set(symbol, series)
    }),
  )
  if (rows - Number(development) !== expectedRows) throw new Error(`Unexpected tape row count: ${receipt.key}`)
  if (scoped.some((symbol) => !seen.has(symbol))) throw new Error(`Missing symbol history: ${receipt.key}`)
}

const coverage = (days: readonly Day[]) =>
  Object.fromEntries(
    symbols.map((symbol) => {
      let slots = 0
      let present = 0
      const empty: string[] = []
      const missingOpen: string[] = []
      const missingLatestExit: string[] = []
      for (const day of days) {
        slots += day.slots
        const series = day.bars.get(symbol)
        if (series === undefined) empty.push(day.date)
        else for (let slot = 0; slot < day.slots; slot++) present += Number(price(series, slot, Field.Open) > 0)
        if (series === undefined || price(series, 0, Field.Open) === 0) missingOpen.push(day.date)
        if (series === undefined || price(series, flattenSlot(day.slots), Field.Open) === 0)
          missingLatestExit.push(day.date)
      }
      return [symbol, { slots, present, empty, missingOpen, missingLatestExit }]
    }),
  )

export const loadIntraday = async (archive: ArchiveReader) => {
  const { blind, recent, daily } = receipts.datasets
  const developmentManifest = await archive.readJson(`${blind.prefix}/MANIFEST.json`, blind.manifestSha256)
  const continuityManifest = await archive.readJson(`${recent.prefix}/MANIFEST.json`, recent.manifestSha256)
  requireRoster(decodeBlind(developmentManifest).symbols, baseSymbols, 62, 'development')
  requireRoster(decodeRecent(continuityManifest).universes.all62, baseSymbols, 62, 'continuity')
  const manifest = `${prefix}/${supplementManifestSha256}/MANIFEST.json`
  const supplement = decodeSupplement(await archive.readJson(manifest, supplementManifestSha256), {
    onExcessProperty: 'error',
  })
  requireRoster(supplement.symbols, supplementSymbols, supplementSymbols.length, 'supplement')
  const supplementalTape: GzipReceipt = {
    key: `${prefix}/raw-${supplement.sha256}.tsv.gz`,
    bytes: supplement.bytes,
    sha256: supplement.sha256,
    raw: { bytes: supplement.rawBytes, sha256: supplement.rawSha256 },
  }
  const readCalendar = (source: (typeof receipts.calendars)[keyof typeof receipts.calendars]) =>
    archive.readJson(`${source.prefix}/${source.name}`, source.sha256)
  const development = requireCalendarCoverage(
    normalizeResearchCalendar({
      query: { start: first, end: developmentEnd },
      response: await readCalendar(receipts.calendars.blind),
    }),
    first,
    developmentEnd,
    developmentSessions,
  )
  const continuity = requireCalendarCoverage(
    normalizeResearchCalendar(await readCalendar(receipts.calendars.recent)).filter(({ date }) => date <= last),
    holdoutStart,
    last,
    holdoutSessions,
  )
  const earlier = indexSessions(development)
  const later = indexSessions(continuity)
  const index = new Map([...earlier, ...later])
  await loadTape(archive, earlier, Tape.Development, tapeReceipt(blind), blind.rows, baseSymbols)
  await loadTape(archive, later, Tape.Continuity, tapeReceipt(recent), recent.rows, baseSymbols)
  await loadTape(archive, index, Tape.Supplement, supplementalTape, supplement.rows, supplementSymbols)
  const days: Day[] = Array.from(index.values(), ({ session, bars }) => ({
    date: session.date,
    slots: session.minutes / 5,
    bars,
  }))
  const earlierCoverage = coverage(days.slice(0, developmentSessions))
  const laterCoverage = coverage(days.slice(developmentSessions))
  for (const symbol of symbols) {
    if (earlierCoverage[symbol].present === 0 || laterCoverage[symbol].present === 0)
      throw new Error(`Missing entire RTH history: ${symbol}`)
  }
  return {
    days,
    source: {
      bucket: receipts.bucket,
      development: { manifestSha256: blind.manifestSha256, tape: tapeReceipt(blind) },
      holdout: { manifestSha256: recent.manifestSha256, tape: tapeReceipt(recent) },
      daily: { manifestSha256: daily.manifestSha256, tape: tapeReceipt(daily) },
      calendars: receipts.calendars,
      supplement: { manifest, manifestSha256: supplementManifestSha256, ...supplement, tape: supplementalTape.key },
    },
    coverage: { development: earlierCoverage, holdout: laterCoverage },
  }
}
