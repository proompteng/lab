import { NodeRuntime } from '@effect/platform-node'
import { Console, Effect, Redacted, Result, Schema } from 'effect'

import { BarInterval, createTapeProfiler, rankEtfs, rthBuckets } from './profile-intraday-liquidity-core'
import { normalizeResearchCalendar, requireCalendarCoverage, type Session } from './research-lib/calendar'
import {
  type ArchiveReader,
  archiveBucket,
  countArchiveLines,
  S3ArchiveError,
  withS3Archive,
} from './research-lib/s3-archive'

const prefix = 'bayn-research-datasets/2026-11-27-sip-multiyear'
const manifest = {
  key: `${prefix}/MANIFEST.json`,
  sha256: '5df0cfe213c69e9a6489dde46553db610edb2632b5e54fb76a6347740abcdead',
}
const calendar = {
  key: 'bayn-research-datasets/2026-11-27/calendar_2024_2026.json',
  sha256: 'b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71',
  firstSession: '2024-01-02',
  lastSession: '2026-11-25',
  sessions: 729,
}
const source = 'Alpaca Market Data API v2 (feed=sip, adjustment=split)'
const tapes = {
  [BarInterval.FiveMinutes]: `${prefix}/alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz`,
  [BarInterval.OneMinute]: `${prefix}/alpaca_sip_1m_rth_bayn21_20240102_20261125.tsv.gz`,
}

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const SymbolList = Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.]*$/)))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const Tape = Schema.Struct({
  key: Schema.String,
  rows: PositiveInt,
  gzipBytes: PositiveInt,
  gzipSha256: Sha256,
  rawBytes: PositiveInt,
  rawSha256: Sha256,
})
const decodeManifest = Schema.decodeUnknownResult(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-multiyear-dataset-manifest.v1'),
    source: Schema.Literal(source),
    bucket: Schema.Literal(archiveBucket),
    prefix: Schema.Literal(prefix),
    universes: Schema.Struct({
      bayn21: SymbolList,
      expanded29: SymbolList,
      sectorMacro12: SymbolList,
      all62: SymbolList,
    }),
    files: Schema.Array(Tape),
  }),
)

enum B0Status {
  NotMeasurable = 'NOT_MEASURABLE_WITHOUT_REALIZED_FILLS',
}

const encodeHeader = Schema.encodeSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.intraday-liquidity-profile.v1'),
    b0: Schema.Struct({
      status: Schema.Enum(B0Status),
      strictThresholdBps: Schema.Literal(2.5),
      meanRealizedSlippageBps: Schema.Null,
      medianRealizedSlippageBps: Schema.Null,
      verifiedEligibleEtfs: Schema.Tuple([]),
    }),
  }),
)
const encodeInterval = Schema.encodeSync(Schema.Enum(BarInterval))

export const readTapeProfile = async (
  archive: ArchiveReader,
  sessions: readonly Session[],
  interval: BarInterval,
  symbols: readonly string[],
  tape: typeof Tape.Type,
) => {
  const profiler = createTapeProfiler(sessions, symbols, interval)
  const rows = await archive.readGzip(
    {
      key: tape.key,
      bytes: tape.gzipBytes,
      sha256: tape.gzipSha256,
      raw: { bytes: tape.rawBytes, sha256: tape.rawSha256 },
    },
    countArchiveLines(profiler.add),
  )
  if (rows !== tape.rows) throw new S3ArchiveError({ message: `SIP row count mismatch: ${tape.key}` })
  return profiler.finish()
}

const registeredCalendar = (input: unknown) => {
  try {
    return requireCalendarCoverage(
      normalizeResearchCalendar(input),
      calendar.firstSession,
      calendar.lastSession,
      calendar.sessions,
    )
  } catch (cause) {
    throw new S3ArchiveError({ message: 'Invalid registered SIP research calendar', cause: Redacted.make(cause) })
  }
}

export const profileSipArchive = async (archive: ArchiveReader) => {
  const decoded = decodeManifest(await archive.readJson(manifest.key, manifest.sha256))
  if (Result.isFailure(decoded))
    throw new S3ArchiveError({
      message: 'Invalid registered SIP dataset manifest',
      cause: Redacted.make(decoded.failure),
    })
  const { universes, files } = decoded.success
  const { all62, bayn21, expanded29, sectorMacro12 } = universes
  const partition = new Set([...bayn21, ...expanded29, ...sectorMacro12])
  const baynEtfs = ['IWM', 'QQQ', 'SMH', 'SPY']
  if (
    all62.length !== 62 ||
    new Set(all62).size !== partition.size ||
    partition.size !== 62 ||
    bayn21.length !== 21 ||
    expanded29.length !== 29 ||
    sectorMacro12.length !== 12 ||
    !all62.every((symbol) => partition.has(symbol)) ||
    !baynEtfs.every((symbol) => bayn21.includes(symbol))
  )
    throw new S3ArchiveError({ message: 'Unexpected SIP universe partition' })

  const etfs = new Set([...baynEtfs, ...sectorMacro12])
  const sessions = registeredCalendar(await archive.readJson(calendar.key, calendar.sha256))
  const profiles = []
  for (const interval of [BarInterval.FiveMinutes, BarInterval.OneMinute]) {
    const descriptors = files.filter(({ key }) => key === tapes[interval])
    if (descriptors.length !== 1)
      throw new S3ArchiveError({ message: `Expected exactly one registered SIP ${interval} tape` })
    const tape = descriptors[0]
    const { rowCoverage, symbols } = await readTapeProfile(
      archive,
      sessions,
      interval,
      interval === BarInterval.FiveMinutes ? all62 : bayn21,
      tape,
    )
    profiles.push({
      interval: encodeInterval(interval),
      tape,
      rowCoverage,
      symbols,
      etfRanking: rankEtfs(symbols, etfs),
    })
  }

  return {
    ...encodeHeader({
      schemaVersion: 'bayn.intraday-liquidity-profile.v1',
      b0: {
        status: B0Status.NotMeasurable,
        strictThresholdBps: 2.5,
        meanRealizedSlippageBps: null,
        medianRealizedSlippageBps: null,
        verifiedEligibleEtfs: [],
      },
    }),
    archive: { bucket: archiveBucket, source, manifest, calendar },
    earlyCloses: sessions.filter(({ minutes }) => minutes === 210).map(({ date }) => date),
    rthBuckets,
    profiles,
  }
}

const main = Effect.gen(function* () {
  const profile = yield* withS3Archive(profileSipArchive).pipe(Effect.timeout('5 minutes'))
  yield* Console.log(JSON.stringify(profile, null, 2))
})

if (import.meta.main) NodeRuntime.runMain(main)
