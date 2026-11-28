import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Data, Effect, FileSystem, Layer, Logger, Redacted, Result, Schema } from 'effect'

import { StrictNonEmptyStringSchema } from '../src/schemas'
import type { Bar, Day } from './noise-area-study-replay'
import { normalizeResearchCalendar, requireCalendarCoverage, type Session } from './research-lib/calendar'
import {
  archiveBucket,
  countArchiveLines,
  withS3Archive,
  type ArchiveReader,
  type GzipReceipt,
} from './research-lib/s3-archive'
import {
  barMinutes,
  Etf,
  etfs,
  evaluateStudy,
  expectedSessions,
  firstDate,
  lastDate,
} from './research-intraday-orb-etf-core'

const prefix = 'bayn-research-datasets/2026-11-27-sip-multiyear'
const source = {
  bucket: archiveBucket,
  manifest: {
    key: `${prefix}/MANIFEST.json`,
    sha256: '5df0cfe213c69e9a6489dde46553db610edb2632b5e54fb76a6347740abcdead',
  },
  calendar: {
    key: 'bayn-research-datasets/2026-11-27/calendar_2024_2026.json',
    sha256: 'b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71',
  },
  tapeKey: `${prefix}/alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz`,
  rows: 3_923_737,
}

export class OrbStudyError extends Data.TaggedError('OrbStudyError')<{
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const studyError = (message: string, cause?: unknown) =>
  new OrbStudyError(cause === undefined ? { message } : { message, cause: Redacted.make(cause) })

const decode = <A>(label: string, parse: () => A): A => {
  try {
    return parse()
  } catch (cause) {
    throw studyError(label, cause)
  }
}

enum ArchiveFeed {
  AlpacaSipSplit = 'Alpaca Market Data API v2 (feed=sip, adjustment=split)',
}

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Count = Schema.Int.check(Schema.isGreaterThan(0))
const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-multiyear-dataset-manifest.v1'),
    source: Schema.Enum(ArchiveFeed),
    universes: Schema.Struct({ all62: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Z]{1,5}$/))) }),
    files: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        rows: Count,
        gzipBytes: Count,
        rawBytes: Count,
        gzipSha256: Digest,
        rawSha256: Digest,
      }),
    ),
  }),
)

const Price = Schema.FiniteFromString.check(Schema.isGreaterThan(0))
const Volume = Price.check(Schema.isInt())
const decodeBar = Schema.decodeUnknownSync(Schema.Tuple([Price, Price, Price, Price, Volume, Price]))
const isEtf = Schema.is(Schema.Enum(Etf))
const barStart = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00Z$/
const barMs = barMinutes * 60_000

export const readStudyTape = async (
  archive: ArchiveReader,
  receipt: GzipReceipt,
  sessions: readonly Session[],
  roster: ReadonlySet<string>,
  expectedRows: number,
) => {
  const frames = new Map(
    sessions.map((session) => [session.date, { session, bars: new Map<Etf, (Bar | undefined)[]>() }]),
  )
  const seen = new Map<Etf, number>()
  const observed = new Map<Etf, number>()
  let scopedOutsideRthRows = 0
  const rows = await archive.readGzip(
    receipt,
    countArchiveLines((line, row) => {
      const tab = line.indexOf('\t')
      const symbol = line.slice(0, tab)
      if (tab < 1 || !roster.has(symbol)) throw studyError(`Unregistered SIP row identity at line ${row + 1}`)
      if (!isEtf(symbol)) return
      const [, stamp, ...fields] = line.split('\t')
      const time = Date.parse(stamp)
      const frame = frames.get(stamp.slice(0, 10))
      if (
        fields.length !== 6 ||
        !barStart.test(stamp) ||
        !Number.isFinite(time) ||
        time <= (seen.get(symbol) ?? -Infinity) ||
        frame === undefined
      )
        throw studyError(`Invalid, duplicate or unordered SIP timestamp or shape at line ${row + 1}`)
      seen.set(symbol, time)
      const slots = frame.session.minutes / barMinutes
      const slot = (time - frame.session.openMs) / barMs
      if (!Number.isInteger(slot)) throw studyError(`Off-grid SIP bar at line ${row + 1}`)
      if (slot < 0 || slot >= slots) {
        scopedOutsideRthRows++
        return
      }
      const [open, high, low, close, volume, vwap] = decode(`Invalid SIP numbers at line ${row + 1}`, () =>
        decodeBar(fields),
      )
      if (low > Math.min(open, close) || high < Math.max(open, close))
        throw studyError(`Invalid SIP OHLC bounds at line ${row + 1}`)
      const bars = frame.bars.get(symbol) ?? Array.from<Bar | undefined>({ length: slots })
      bars[slot] = { open, high, low, close, volume, vwap }
      frame.bars.set(symbol, bars)
      observed.set(symbol, (observed.get(symbol) ?? 0) + 1)
    }),
  )
  if (rows !== expectedRows) throw studyError('SIP row count does not match the verified manifest')
  const days = Array.from(
    frames.values(),
    ({ session, bars }): Day => ({ date: session.date, slots: session.minutes / barMinutes, bars }),
  )
  const expectedBars = days.reduce((total, day) => total + day.slots, 0)
  const bySymbol = Object.fromEntries(
    etfs.map((etf) => {
      const received = observed.get(etf)
      if (received === undefined) throw studyError(`No regular-session SIP bars observed for ${etf}`)
      return [etf, { expectedBars, observedBars: received, missingBars: expectedBars - received }]
    }),
  )
  return {
    days,
    coverage: {
      archiveRows: rows,
      scopedOutsideRthRows,
      sessions: days.length,
      earlyCloses: days.filter(({ slots }) => slots < 78).length,
      bySymbol,
    },
  }
}

export const loadStudyData = async (archive: ArchiveReader) => {
  const document = await archive.readJson(source.manifest.key, source.manifest.sha256)
  const manifest = decode('Invalid SIP archive manifest', () => decodeManifest(document))
  const roster = new Set(manifest.universes.all62)
  if (roster.size !== 62 || manifest.universes.all62.length !== 62 || etfs.some((etf) => !roster.has(etf)))
    throw studyError('Verified SIP archive does not declare the registered ETF universe')
  const files = manifest.files.filter(({ key }) => key === source.tapeKey)
  if (files.length !== 1 || files[0].rows !== source.rows)
    throw studyError('Verified SIP archive does not declare the registered 5m object and row count')
  const calendar = await archive.readJson(source.calendar.key, source.calendar.sha256)
  const sessions = decode('Invalid SIP regular-session calendar', () =>
    requireCalendarCoverage(normalizeResearchCalendar(calendar), firstDate, lastDate, expectedSessions),
  )
  const { gzipBytes, gzipSha256, rawBytes, rawSha256 } = files[0]
  const tape: GzipReceipt = {
    key: source.tapeKey,
    bytes: gzipBytes,
    sha256: gzipSha256,
    raw: { bytes: rawBytes, sha256: rawSha256 },
  }
  return { source: { ...source, tape }, ...(await readStudyTape(archive, tape, sessions, roster, source.rows)) }
}

const decodeArgs = Schema.decodeUnknownResult(Schema.Tuple([StrictNonEmptyStringSchema]))
const program = (args: readonly string[]) =>
  Effect.gen(function* () {
    const [output] = yield* Effect.fromResult(
      decodeArgs(args).pipe(
        Result.mapError((cause) =>
          studyError('Usage: bun services/bayn/tools/research-intraday-orb-etf.ts <new-results.json>', cause),
        ),
      ),
    )
    const data = yield* withS3Archive(loadStudyData).pipe(Effect.timeout('3 minutes'))
    const evidence = yield* Effect.try({
      try: () => ({
        schema: 'bayn.research.wave-23d.intraday-orb-etf.v1',
        registrationCommit: 'e63ec8d22a74ea5d2b4074d919323dcaee2a17a9',
        source: data.source,
        coverage: data.coverage,
        ...evaluateStudy(data.days),
      }),
      catch: (cause) => studyError('Could not evaluate the verified SIP study', cause),
    })
    const fs = yield* FileSystem.FileSystem
    yield* fs
      .writeFileString(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      .pipe(Effect.mapError((cause) => studyError('Could not write a new Wave 23D results file', cause)))
    yield* Effect.logInfo('Wave 23D verified replay complete', { verdict: evidence.verdict })
  })

if (import.meta.main)
  NodeRuntime.runMain(
    program(process.argv.slice(2)).pipe(
      Effect.tapError((error) => Effect.logError(error)),
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI owns its file output and structured logs
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Logger.layer([Logger.consoleJson]))),
    ),
    { disableErrorReporting: true },
  )
