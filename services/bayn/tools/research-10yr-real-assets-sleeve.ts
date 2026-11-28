import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Redacted, Result, Schema } from 'effect'

import { IsoDateSchema } from '../src/schemas'
import { loadDevelopment, loadHoldout, sources, withArchive } from './noise-area-study-data'
import { splits } from './noise-area-study-replay'
import { receipts, tapeReceipt } from './pure-etf-dual-horizon-data'
import {
  foldBounds,
  normalizeResearchCalendar,
  requireAlignedSessions,
  requireCalendarCoverage,
} from './research-lib/calendar'
import { type ArchiveReader, countArchiveLines, withS3Archive } from './research-lib/s3-archive'
import { mean, stationaryBootstrap, stationaryMeanP } from './research-lib/statistics'
import { pearson } from './research-orb-zab-statistics'
import {
  admitCoverage,
  attribution,
  blend,
  decide,
  drawdownReturns,
  encodeDecision,
  type Frame,
  type Marks,
  pairedSharpeLower,
  performance,
  protocol,
  replay,
  returns,
  returnsFor,
  Scope,
  stressFlags,
  Ticker,
  tracked,
} from './research-10yr-real-assets-sleeve-core'
import { controlIds, prepareControls } from './research/event-calendar-etf-controls'
import { loadFrozenDailyFrames } from './research/macro-etf-core-dual-horizon-data'

const dataset = receipts.datasets.daily
const tape = tapeReceipt(dataset)
const manifestKey = `${dataset.prefix}/MANIFEST.json`
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const decodeManifest = Schema.decodeUnknownResult(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-10yr-sp100-manifest.v1'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])'),
    etfs: Schema.Array(Schema.String),
    files: Schema.Array(
      Schema.Struct({
        key: Schema.Literal(tape.key),
        rows: positiveInt,
        rawBytes: positiveInt,
        rawSha256: digest,
        gzipBytes: positiveInt,
        gzipSha256: digest,
      }),
    ),
  }),
)
const price = Schema.FiniteFromString.check(Schema.isGreaterThan(0))
const decodeRow = Schema.decodeUnknownResult(
  Schema.Tuple([
    Schema.String,
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T0[45]:00:00Z$/)),
    price,
    price,
    price,
    price,
    price.check(Schema.isInt()),
    price,
  ]),
)
const decodeDate = Schema.decodeUnknownSync(IsoDateSchema)
const trackedByName = new Map<string, Ticker>(tracked.map((ticker) => [ticker, ticker]))

class StudyError extends Data.TaggedError('RealAssetsStudyError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

const failure = (message: string) => (cause: unknown) => new StudyError({ message, cause: Redacted.make(cause) })

export const collectDailyFrames = async (
  batches: AsyncIterable<readonly string[]>,
  calendar: readonly { readonly date: string }[],
  expectedRows: number,
) => {
  const byDate = new Map(calendar.map(({ date }) => [date, new Map<Ticker, Marks>()]))
  const previous = new Map<Ticker, string>()
  const rows = await countArchiveLines((line, index) => {
    const ticker = trackedByName.get(line.slice(0, line.indexOf('\t')))
    if (ticker === undefined) return
    const decoded = decodeRow(line.split('\t'))
    if (Result.isFailure(decoded)) throw failure(`Malformed daily tape row ${index + 1}`)(decoded.failure)
    const [, stamp, open, high, low, close] = decoded.success
    const date = decodeDate(stamp.slice(0, 10))
    const frame = byDate.get(date)
    if (
      frame === undefined ||
      date <= (previous.get(ticker) ?? '') ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close)
    )
      throw new Error(`Invalid or out-of-order ${ticker} bar on ${date}`)
    frame.set(ticker, { open, close })
    previous.set(ticker, date)
  })(batches)
  if (rows !== expectedRows) throw new Error(`Daily tape row count mismatch: expected ${expectedRows}, got ${rows}`)
  return [...byDate].map(([date, bars]) => ({ date, bars }))
}

const loadDaily = async (archive: ArchiveReader) => {
  const decoded = decodeManifest(await archive.readJson(manifestKey, dataset.manifestSha256))
  if (Result.isFailure(decoded)) throw failure('Invalid daily archive manifest')(decoded.failure)
  const { etfs, files } = decoded.success
  const [file] = files
  if (
    files.length !== 1 ||
    file.rows !== dataset.rows ||
    file.rawBytes !== dataset.rawBytes ||
    file.rawSha256 !== dataset.rawSha256 ||
    file.gzipBytes !== dataset.bytes ||
    file.gzipSha256 !== dataset.sha256
  )
    throw new Error('Daily manifest disagrees with the registered object receipt')
  const read = ({ prefix, name, sha256 }: (typeof receipts.calendars)[keyof typeof receipts.calendars]) =>
    archive.readJson(`${prefix}/${name}`, sha256)
  const { train, validation, holdout } = splits
  const developmentCalendar = requireCalendarCoverage(
    normalizeResearchCalendar({
      query: { start: train.first, end: validation.last },
      response: await read(receipts.calendars.blind),
    }),
    train.first,
    validation.last,
    train.count + validation.count,
  )
  const holdoutCalendar = requireCalendarCoverage(
    normalizeResearchCalendar(await read(receipts.calendars.recent)).filter(({ date }) => date <= holdout.last),
    holdout.first,
    holdout.last,
    holdout.count,
  )
  const calendar = [...developmentCalendar, ...holdoutCalendar]
  const frames = await archive.readGzip(tape, (batches) => collectDailyFrames(batches, calendar, dataset.rows))
  return { frames, ...admitCoverage(calendar, etfs, frames) }
}

type PublishedControls = ReturnType<typeof prepareControls>

const study = (frames: readonly Frame[], scope: Scope, controls: PublishedControls) => {
  const dates = frames.slice(1).map(({ date }) => date)
  const train = foldBounds(dates, dates[0], splits.train.last, splits.train.count - 1)
  const validation = foldBounds(dates, splits.validation.first, splits.validation.last, splits.validation.count)
  const holdout = foldBounds(dates, splits.holdout.first, splits.holdout.last, splits.holdout.count)
  const windows = {
    full: { first: 0, end: dates.length },
    train,
    validation,
    holdout,
    oos: { first: validation.first, end: holdout.end },
    year2022: foldBounds(dates, '2022-01-03', '2022-12-30', 251),
  }
  const windowScores = <A>(score: (take: <T>(rows: readonly T[]) => T[]) => A) => {
    const slice = ({ first, end }: typeof train) => score((rows) => rows.slice(first, end))
    return {
      full: slice(windows.full),
      train: slice(windows.train),
      validation: slice(windows.validation),
      holdout: slice(windows.holdout),
      oos: slice(windows.oos),
      year2022: slice(windows.year2022),
    }
  }
  const at = controls.at(protocol.controlCostRoundTripBps)
  const baseLegs = { B0: at.B0.slice(1), F4: at.F4.slice(1), O1: at.O1.slice(1) }
  const spy = returnsFor(frames, Ticker.SPY)
  const ief = returnsFor(frames, Ticker.IEF)
  const shy = returnsFor(frames, Ticker.SHY)
  const stress = stressFlags(frames)
  requireAlignedSessions(spy, ief, shy, stress, baseLegs.B0, baseLegs.F4, baseLegs.O1, at.SPY.slice(1))

  const plan = stationaryBootstrap(holdout.end - holdout.first, protocol.bootstrap)
  const byCost = protocol.costsOneWayBps.map((oneWayBps) => {
    const sleeve = replay(frames, scope, oneWayBps)
    const base = blend(baseLegs, null, oneWayBps)
    const addSleeve = blend(baseLegs, sleeve, oneWayBps)
    const addShy = blend(baseLegs, shy, oneWayBps)
    const windows = windowScores((take) => {
      const sleeveRows = take(sleeve)
      const net = returns(sleeveRows)
      const reference = performance(take(base))
      const withSleeve = performance(take(addSleeve))
      const withShy = performance(take(addShy))
      const difference = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b)
      return {
        sleeve: {
          ...performance(sleeveRows),
          tradeSessions: sleeveRows.filter(({ turnover }) => turnover > 0).length,
          annualTradedNotionalOverNav: 252 * mean(sleeveRows.map(({ turnover }) => turnover)),
          meanCostBps: 10_000 * mean(sleeveRows.map(({ cost }) => cost)),
        },
        correlations: {
          B0: pearson(net, returns(take(baseLegs.B0))),
          F4: pearson(net, returns(take(baseLegs.F4))),
          O1: pearson(net, returns(take(baseLegs.O1))),
          SPY: pearson(net, returns(take(spy))),
          IEF: pearson(net, returns(take(ief))),
        },
        stress: drawdownReturns(sleeveRows, take(shy), take(stress)),
        base: reference,
        withSleeve,
        withShy,
        sharpeLift: difference(withSleeve.sharpe, reference.sharpe),
        calmarLift: difference(withSleeve.calmar, reference.calmar),
        sharpeLiftVsShy: difference(withSleeve.sharpe, withShy.sharpe),
        calmarLiftVsShy: difference(withSleeve.calmar, withShy.calmar),
        attributionBpsPerSession: attribution(take(addSleeve)),
      }
    })
    const hold = <A>(rows: readonly A[]) => rows.slice(holdout.first, holdout.end)
    return {
      oneWayBps,
      windows,
      holdoutTests: {
        excessShyMeanP: stationaryMeanP(
          hold(sleeve).map(({ net }, i) => net - shy[holdout.first + i].net),
          plan,
        ),
        sharpeLiftLower95: pairedSharpeLower(hold(addSleeve), hold(base), plan),
      },
    }
  })
  const primary = byCost.find(({ oneWayBps }) => oneWayBps === protocol.primaryCostOneWayBps)
  if (primary === undefined) throw new Error('Missing primary cost tier')
  const benchmarks = windowScores((take) => ({
    SPY: performance(take(spy)),
    IEF: performance(take(ief)),
    SHY: performance(take(shy)),
    B0: performance(take(baseLegs.B0)),
    F4: performance(take(baseLegs.F4)),
    O1: performance(take(baseLegs.O1)),
  }))
  const positive = (value: number | null) => value !== null && value > 0
  const main = primary.windows.holdout
  const { B0, F4, O1 } = main.correlations
  const gates = {
    positiveExcess:
      primary.windows.oos.sleeve.net > benchmarks.oos.SHY.net &&
      primary.holdoutTests.excessShyMeanP !== null &&
      primary.holdoutTests.excessShyMeanP < protocol.bootstrapLowerTail,
    positiveStress:
      primary.windows.year2022.sleeve.net > 0 &&
      positive(primary.windows.oos.stress.joint.meanSleeveBps) &&
      positive(primary.windows.oos.stress.joint.meanExcessShyBps),
    orthogonal: [B0, F4, O1].every((r) => r !== null && Math.abs(r) <= protocol.maxAbsCorrelation),
    portfolio:
      positive(primary.holdoutTests.sharpeLiftLower95) &&
      positive(main.calmarLift) &&
      positive(main.sharpeLiftVsShy) &&
      positive(main.calmarLiftVsShy),
  }
  return {
    bounds: windowScores((take) => {
      const window = take(dates)
      return { from: window[0], through: window.at(-1), sessions: window.length }
    }),
    benchmarks,
    byCost,
    gates,
    verdict: decide(scope, gates),
  }
}

const loadIntraday = withArchive(async (archive) => {
  const development = await loadDevelopment(archive)
  const holdout = await loadHoldout(archive)
  return [...development.days, ...holdout.days]
}).pipe(Effect.timeout('5 minutes'))

export const outputPath = (args: string[]) => {
  const { values } = parseArgs({ args, options: { output: { type: 'string' } }, strict: true })
  if (values.output === undefined || basename(values.output) !== 'results.json')
    throw new Error('Pass --output <new-directory>/results.json')
  return values.output
}

const run = Effect.gen(function* () {
  const output = yield* Effect.try({
    try: () => outputPath(process.argv.slice(2)),
    catch: failure('Invalid arguments: pass --output <new-directory>/results.json'),
  })
  const coverage = yield* withS3Archive(loadDaily).pipe(Effect.timeout('1 minute'))
  yield* Effect.logInfo('Verified daily sleeve archive', { scope: coverage.scope, missing: coverage.missing })
  const controlDaily = yield* loadFrozenDailyFrames
  const controlIntraday = yield* loadIntraday
  const result = yield* Effect.try({
    try: () => {
      requireAlignedSessions(coverage.frames, controlDaily, controlIntraday)
      const controls = prepareControls(controlDaily, controlIntraday)
      const measured = study(coverage.frames, coverage.scope, controls)
      const { verdict, ...evidence } = measured
      return {
        schemaVersion: 'bayn.wave24b.real-assets-sleeve.v1',
        decision: encodeDecision({
          requestedScope: Scope.Requested,
          evaluatedScope: coverage.scope,
          missing: coverage.missing,
          verdict,
        }),
        archive: {
          bucket: receipts.bucket,
          manifestKey,
          manifestSha256: dataset.manifestSha256,
          tape,
          rows: dataset.rows,
        },
        coverage: coverage.coverage,
        protocol,
        controls: {
          ids: controlIds,
          sources: { daily: receipts.datasets.daily, macro: receipts.datasets.macro, intraday: sources },
          oracle: controls.oracle,
        },
        evidence,
      }
    },
    catch: failure('Could not score aligned sleeve and published controls'),
  })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', signal }),
    catch: failure('Cannot write new results.json'),
  })
  yield* Effect.logInfo(result.decision.verdict, { evaluatedScope: result.decision.evaluatedScope })
})

if (import.meta.main) NodeRuntime.runMain(run)
