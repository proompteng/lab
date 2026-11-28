import { Data, Schema } from 'effect'

import { IsoDateSchema } from '../src/schemas'
import { blind, listingDates, prior, universe } from './8yr-unseen-intraday-protocol'
import { isListed, readTape } from './8yr-unseen-intraday-tape'
import { normalizeResearchCalendar, requireCalendarCoverage } from './research-lib/calendar'
import type { ArchiveReader } from './research-lib/s3-archive'

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const object = Schema.Struct({ key: Schema.String, bytes: count, sha256: digest })
const researchKey = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*(?:\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)+$/
const decodeBlindSource = Schema.decodeUnknownSync(
  Schema.Struct({
    schema: Schema.Literal('bayn.research.wave-4e.blind-archive.v1'),
    manifest: Schema.String.check(Schema.isPattern(researchKey)),
    manifestSha256: digest,
    bars: Schema.String.check(Schema.isPattern(researchKey)),
    calendar: Schema.String.check(Schema.isPattern(researchKey)),
    gzipMemberBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    rows: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
)
type BlindSource = Omit<ReturnType<typeof decodeBlindSource>, 'schema'>

export const replacementBlindSource = (input: unknown): BlindSource => {
  const { schema: _schema, ...source } = decodeBlindSource(input, { onExcessProperty: 'error' })
  const { manifest, manifestSha256, bars, calendar } = source
  if (
    !manifest.startsWith('bayn-research-datasets/') ||
    !bars.startsWith('bayn-research-datasets/') ||
    !calendar.startsWith('bayn-research-datasets/') ||
    manifest === blind.manifest ||
    bars === blind.bars ||
    manifestSha256 === blind.manifestSha256 ||
    new Set([manifest, bars, calendar]).size !== 3
  ) {
    throw new Error('A corrected blind archive must use a distinct manifest and tape in bayn-research-datasets/')
  }
  return source
}

const blindManifestFields = {
  dateRange: Schema.Struct({ start: IsoDateSchema, end: IsoDateSchema }),
  calendarSessions: count,
  symbolCount: count,
  symbols: Schema.Array(Schema.String),
  symbolRowCounts: Schema.Record(Schema.String, count),
  totalRows: count,
  files: Schema.Struct({ bars_5m: object, calendar: object }),
}
const decodeRejectedManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    ...blindManifestFields,
    dataset: Schema.Literal('alpaca-sip-8yr-5m-unseen-2016-2023'),
    source: Schema.Literal('Alpaca Data API v2 (feed=sip, adjustment=split, timeframe=5Min)'),
  }),
)
const decodeCorrectedManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    ...blindManifestFields,
    schemaVersion: Schema.Literal('bayn.sip-8yr-unseen-manifest.v2'),
    dataset: Schema.Literal('alpaca-sip-8yr-5m-exact62-unseen-2016-2023'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=split, timeframe=5Min)'),
    matchesWave3BUniverse: Schema.Literal(true),
  }),
)
const decodePriorManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-multiyear-dataset-manifest.v1'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=split)'),
    universes: Schema.Struct({ all62: Schema.Array(Schema.String) }),
    files: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        rows: count,
        rawBytes: count,
        gzipBytes: count,
        rawSha256: digest,
        gzipSha256: digest,
      }),
    ),
  }),
)

export const compareUniverse = (declared: readonly string[], rows?: Readonly<Record<string, number>>) => {
  const expected = new Set(universe)
  const actual = new Set(declared)
  return {
    missing: universe.filter((symbol) => !actual.has(symbol)),
    unexpected: [...actual].filter((symbol) => !expected.has(symbol)).sort(),
    duplicates: [...new Set(declared.filter((symbol, i) => declared.indexOf(symbol) !== i))].sort(),
    listedWithoutRows:
      rows === undefined
        ? []
        : universe.filter((symbol) => (listingDates[symbol] ?? blind.first) <= blind.last && !(rows[symbol] > 0)),
  }
}

export const admitUniverse = (label: string, declared: readonly string[], rows?: Readonly<Record<string, number>>) => {
  const problems = Object.entries(compareUniverse(declared, rows)).filter(([, symbols]) => symbols.length > 0)
  if (problems.length > 0) {
    throw new Error(
      `${label} universe differs from the frozen roster: ${problems.map(([issue, names]) => `${issue}=[${names.join(', ')}]`).join('; ')}`,
    )
  }
}

type Window = Pick<typeof blind | typeof prior, 'first' | 'last' | 'sessions'>
const checkCalendar = (input: unknown, window: Window) =>
  requireCalendarCoverage(normalizeResearchCalendar(input), window.first, window.last, window.sessions)

const checkBlindManifest = (input: unknown, binding: BlindSource) => {
  const manifest = binding.manifest === blind.manifest ? decodeRejectedManifest(input) : decodeCorrectedManifest(input)
  const { symbols, symbolRowCounts, files } = manifest
  if (
    manifest.dateRange.start !== blind.first ||
    manifest.dateRange.end !== blind.last ||
    manifest.calendarSessions !== blind.sessions ||
    manifest.symbolCount !== symbols.length ||
    manifest.totalRows !== binding.rows ||
    Object.values(symbolRowCounts).reduce((total, rows) => total + rows, 0) !== binding.rows ||
    Object.keys(symbolRowCounts).some((symbol) => !symbols.includes(symbol)) ||
    files.bars_5m.key !== binding.bars ||
    files.bars_5m.bytes <= 0 ||
    (binding.gzipMemberBytes !== undefined && binding.gzipMemberBytes >= files.bars_5m.bytes) ||
    files.calendar.key !== binding.calendar ||
    files.calendar.sha256 !== blind.calendarSha256
  ) {
    throw new Error('Blind manifest does not match the registered archive receipt')
  }
  return manifest
}

export const readArchiveMetadata = async (read: ArchiveReader['readJson'], binding: BlindSource = blind) => {
  const source = checkBlindManifest(await read(binding.manifest, binding.manifestSha256), binding)
  // Never treat an entirely absent early-listed name like an ordinary missing 5m bar.
  admitUniverse('2016–2023 blind SIP', source.symbols, source.symbolRowCounts)
  const blindCalendar = checkCalendar(
    {
      query: { start: blind.first, end: blind.last },
      response: await read(binding.calendar, blind.calendarSha256),
    },
    blind,
  )
  const continuity = decodePriorManifest(await read(prior.manifest, prior.manifestSha256))
  admitUniverse('2024–2026 continuity SIP', continuity.universes.all62)
  const priorTape = continuity.files.filter(({ key }) => key === prior.bars)
  if (priorTape.length !== 1 || priorTape[0].rows !== prior.rows) throw new Error('Missing registered continuity tape')
  const priorCalendar = checkCalendar(await read(prior.calendar, prior.calendarSha256), prior)
  return {
    blind: { calendar: blindCalendar, receipt: source.files.bars_5m, rowsBySymbol: source.symbolRowCounts },
    prior: { calendar: priorCalendar, receipt: priorTape[0] },
  }
}

export class ArchiveError extends Data.TaggedError('ArchiveError')<{ readonly message: string }> {}

async function* rows(batches: AsyncIterable<readonly string[]>) {
  for await (const batch of batches) yield* batch
}

export const loadTapes = async ({ readJson, readGzip }: ArchiveReader, binding: BlindSource = blind) => {
  // Both universe/calendar receipts must be admitted before the first bar GET.
  const metadata = await readArchiveMetadata(readJson, binding)
  const load = async (kind: 'blind' | 'prior') => {
    const { calendar, receipt } = metadata[kind]
    const stored =
      'gzipBytes' in receipt
        ? {
            key: receipt.key,
            bytes: receipt.gzipBytes,
            sha256: receipt.gzipSha256,
            raw: { bytes: receipt.rawBytes, sha256: receipt.rawSha256 },
          }
        : receipt
    const memberBytes = kind === 'blind' ? binding.gzipMemberBytes : undefined
    const tape = await readGzip(memberBytes === undefined ? stored : { ...stored, memberBytes }, (batches) =>
      readTape(
        calendar,
        rows(batches),
        kind,
        kind === 'blind' ? binding.rows : prior.rows,
        kind === 'blind' ? metadata.blind.rowsBySymbol : undefined,
      ),
    )
    const missing = universe.filter(
      (symbol) => calendar.some(({ date }) => isListed(symbol, date)) && !tape.supported.has(symbol),
    )
    if (missing.length > 0) throw new Error(`${kind} SIP lacks any admitted RTH bars for: ${missing.join(', ')}`)
    return { days: tape.days, coverage: tape.coverage, receipt }
  }
  return { blind: await load('blind'), prior: await load('prior') }
}
