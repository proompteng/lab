import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Redacted, Schema } from 'effect'

import { sha256 } from '../src/hash'
import { loadDevelopment, loadHoldout, withArchive } from './noise-area-study-data'
import { splits, type Day as IntradaySession } from './noise-area-study-replay'
import { blend } from './orthogonal-pillar3-metrics'
import { receipts } from './pure-etf-dual-horizon-data'
import {
  closeSignals,
  type Frame,
  mark,
  marketAlpha,
  pairedSharpeLift,
  performance,
  protocol,
  replay,
  type ReturnDay,
  Ticker,
  tickers,
  tickerSchema,
  Verdict,
  verdictFor,
  walkForward,
} from './research-10yr-sector-dispersion-core'
import { pearson } from './research-orb-zab-statistics'
import { foldBounds } from './research-lib/calendar'
import { withS3Archive } from './research-lib/s3-archive'
import { stationaryBootstrap, sum, wealth } from './research-lib/statistics'
import { controlIds, controls, prepareControls } from './research/event-calendar-etf-controls'
import { type DailyFrame, loadFrozenDailyFrames } from './research/macro-etf-core-dual-horizon-data'

const base = receipts.datasets.daily
const manifestKey = `${base.prefix}/MANIFEST.json`
const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-10yr-sp100-manifest.v1'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])'),
    etfs: Schema.Array(Schema.String),
    files: Schema.Array(
      Schema.Struct({
        key: Schema.Literal(`${base.prefix}/${base.name}`),
        rows: Schema.Literal(base.rows),
        gzipBytes: Schema.Literal(base.bytes),
        gzipSha256: Schema.Literal(base.sha256),
        rawBytes: Schema.Literal(base.rawBytes),
        rawSha256: Schema.Literal(base.rawSha256),
      }),
    ),
  }),
)

export const confirmRoster = (input: unknown) => {
  const { etfs, files } = decodeManifest(input)
  const confirmed = new Set(etfs.filter(Schema.is(tickerSchema)))
  if (files.length !== 1 || new Set(etfs).size !== etfs.length || tickers.some((ticker) => !confirmed.has(ticker)))
    throw new Error('Base manifest does not uniquely confirm the registered ETF roster and tape')
  return tickers
}

const version = 'bayn.wave21h.sector-dispersion.v1'
const encodeHeader = Schema.encodeSync(
  Schema.Struct({ schemaVersion: Schema.Literal(version), verdict: Schema.Enum(Verdict) }),
)

const returns = (days: readonly ReturnDay[]) => days.map(({ net }) => net)
const compounded = (days: readonly ReturnDay[]) => wealth(returns(days), true) - 1
const positive = (value: number | null | undefined) => value !== null && value !== undefined && value > 0

const study = (daily: readonly DailyFrame[], intraday: readonly IntradaySession[], confirmed: readonly Ticker[]) => {
  const control = prepareControls(daily, intraday)
  // Only symbols bound by the base manifest cross the boundary into the rotation engine.
  const tape: Frame[] = daily.map(({ date, bars }) => ({
    date,
    bars: new Map(
      confirmed.flatMap((ticker) => {
        const bar = bars.get(ticker)
        return bar === undefined ? [] : [[ticker, bar]]
      }),
    ),
  }))
  const { first, end } = foldBounds(
    tape.map(({ date }) => date),
    protocol.firstFill,
    protocol.lastMark,
  )
  if (tape[first - 1]?.date !== protocol.firstMark || end !== tape.length)
    throw new Error('Ten-year OOS mark boundary mismatch')
  const { decisions, folds } = walkForward(closeSignals(tape), first)
  const scored = tape.slice(first, end)
  const dates = scored.map(({ date }) => date)
  const plan = (first: number, end: number) => ({
    first,
    end,
    bootstrap: stationaryBootstrap(end - first, protocol.bootstrap),
  })
  const period = ({ first, last, count }: typeof splits.validation | typeof splits.holdout) => {
    const bounds = foldBounds(dates, first, last, count)
    return plan(bounds.first, bounds.end)
  }
  const windows = { oos: plan(0, dates.length), validation: period(splits.validation), holdout: period(splits.holdout) }
  const buyAndHold = (ticker: Ticker.SHY | Ticker.QQQ) =>
    scored.map(
      (frame, i): ReturnDay => ({
        date: frame.date,
        net: mark(frame, ticker).close / mark(tape[first + i - 1], ticker).close - 1,
        turnover: 0,
      }),
    )
  const shy = buyAndHold(Ticker.SHY)
  const qqq = buyAndHold(Ticker.QQQ)
  const annual = folds.map((fold, i) => {
    const start = dates.indexOf(fold.firstFill)
    const end = i === folds.length - 1 ? dates.length : dates.indexOf(folds[i + 1].firstFill)
    return { receipt: { ...fold, sessions: end - start, lastMark: dates[end - 1] }, start, end }
  })

  const byCost = protocol.roundTripBps.map((roundTripBps) => {
    const rotation = replay(scored, decisions, roundTripBps, true)
    const ungated = replay(scored, decisions, roundTripBps, false)
    const { SPY, F4, O1, B0 } = control.at(roundTripBps)
    const benchmarks = {
      SPY: SPY.slice(first, end),
      QQQ: qqq,
      SHY: shy,
      F4: F4.slice(first, end),
      O1: O1.slice(first, end),
      B0: B0.slice(first, end),
    }
    const transfer = (sleeves: readonly (readonly ReturnDay[])[], weights: readonly number[]) =>
      blend(
        sleeves.map((days) => days.map((day) => ({ ...day, borrow: 0 }))),
        weights,
        roundTripBps / 2,
      ).map(({ net, turnover }, i): ReturnDay => ({ date: dates[i], net, turnover }))
    const allocation = protocol.blendAllocation
    const stackMembers = [benchmarks.F4, benchmarks.O1, benchmarks.B0]
    const stack = transfer(
      stackMembers,
      stackMembers.map(() => 1 / stackMembers.length),
    )
    const withRotation = transfer(
      [...stackMembers, rotation],
      [...stackMembers.map(() => (1 - allocation) / stackMembers.length), allocation],
    )
    const singleBlends = controls.map((id) => ({
      id,
      path: transfer([benchmarks[id], rotation], [1 - allocation, allocation]),
    }))

    const evaluate = ({ first, end, bootstrap }: ReturnType<typeof plan>) => {
      const slice = <A>(path: readonly A[]) => path.slice(first, end)
      const days = slice(rotation)
      const active = returns(days)
      const portfolio = (base: readonly ReturnDay[], blend: readonly ReturnDay[]) => {
        const before = slice(base)
        const after = slice(blend)
        const baseline = performance(before)
        const mixed = performance(after)
        return {
          baseline,
          mixed,
          lift: {
            sharpe: pairedSharpeLift(returns(after), returns(before), bootstrap),
            calmar: mixed.calmar === null || baseline.calmar === null ? null : mixed.calmar - baseline.calmar,
            maxDrawdownReduction: baseline.maxDrawdown - mixed.maxDrawdown,
          },
        }
      }
      const alpha = marketAlpha(active, returns(slice(benchmarks.SPY)), returns(slice(shy)), bootstrap)
      const combined = portfolio(stack, withRotation)
      const summary = performance(days)
      return {
        firstFill: dates[first],
        lastMark: dates[end - 1],
        sessions: end - first,
        rotation: summary,
        ungated: performance(slice(ungated)),
        execution: {
          tradedSessions: days.filter(({ traded }) => traded).length,
          defensiveSessions: days.filter(({ defensive }) => defensive).length,
          sumFeesAsPriorCloseEquityFractions: sum(days.map(({ fee }) => fee)),
        },
        benchmarks: Object.fromEntries(Object.entries(benchmarks).map(([id, path]) => [id, performance(slice(path))])),
        marketAlpha: alpha,
        correlation: Object.fromEntries(
          Object.entries(benchmarks).map(([id, path]) => [id, pearson(active, returns(slice(path)))]),
        ),
        singleControlBlends: Object.fromEntries(
          singleBlends.map(({ id, path }) => [id, portfolio(benchmarks[id], path)]),
        ),
        combined,
        gates: {
          positiveNet: summary.netReturn > 0,
          alpha: positive(alpha.ci95?.lower),
          portfolio:
            positive(combined.lift.sharpe.ci95?.lower) &&
            positive(combined.lift.calmar) &&
            combined.lift.maxDrawdownReduction > 0,
        },
      }
    }

    return {
      roundTripBps,
      oos: evaluate(windows.oos),
      validation: evaluate(windows.validation),
      holdout: evaluate(windows.holdout),
      annual: annual.map(({ receipt: { year }, start, end }) => ({
        year,
        rotation: compounded(rotation.slice(start, end)),
        ungated: compounded(ungated.slice(start, end)),
        SPY: compounded(benchmarks.SPY.slice(start, end)),
        stack: compounded(stack.slice(start, end)),
        stackWithRotation: compounded(withRotation.slice(start, end)),
      })),
      pathsSha256: Object.fromEntries(
        Object.entries({ rotation, ungated, ...benchmarks, stack, withRotation }).map(([id, path]) => [
          id,
          sha256(JSON.stringify(path)),
        ]),
      ),
    }
  })
  const { verdict, ...gates } = verdictFor(
    byCost.flatMap(({ roundTripBps, oos, holdout }) =>
      protocol.decisionCosts.some((cost) => cost === roundTripBps) ? [oos.gates, holdout.gates] : [],
    ),
  )
  return {
    ...encodeHeader({ schemaVersion: version, verdict }),
    input: {
      receipts,
      confirmedTickers: confirmed,
      coverage: Object.fromEntries(
        confirmed.map((ticker) => {
          const present = tape.filter(({ bars }) => bars.has(ticker))
          return [ticker, { sessions: present.length, first: present[0]?.date, last: present.at(-1)?.date }]
        }),
      ),
    },
    protocol,
    firstDecision: decisions[0],
    folds: annual.map(({ receipt }) => receipt),
    controlIds,
    controlOracle: control.oracle,
    gates,
    byCost,
  }
}

class StudyError extends Data.TaggedError('SectorDispersionStudyError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

const main = Effect.gen(function* () {
  const output = yield* Effect.try({
    try: () => {
      const { values } = parseArgs({ options: { output: { type: 'string' } } })
      if (values.output === undefined || values.output === '') throw new Error('Missing output argument')
      return values.output
    },
    catch: (cause) =>
      new StudyError({
        message: 'Usage: research-10yr-sector-dispersion.ts --output <new path>',
        cause: Redacted.make(cause),
      }),
  })
  const manifest = yield* withS3Archive((archive) => archive.readJson(manifestKey, base.manifestSha256)).pipe(
    Effect.timeout('1 minute'),
  )
  const confirmed = yield* Effect.try({
    try: () => confirmRoster(manifest),
    catch: (cause) =>
      new StudyError({
        message: 'Base archive manifest failed the registered ETF and tape checks',
        cause: Redacted.make(cause),
      }),
  })
  const daily = yield* loadFrozenDailyFrames
  const intraday = yield* withArchive(async (archive) => {
    const development = await loadDevelopment(archive)
    const holdout = await loadHoldout(archive)
    return [...development.days, ...holdout.days]
  }).pipe(Effect.timeout('5 minutes'))
  const result = yield* Effect.try({
    try: () => study(daily, intraday, confirmed),
    catch: (cause) =>
      new StudyError({
        message: cause instanceof Error ? cause.message : 'Sector dispersion scoring failed',
        cause: Redacted.make(cause),
      }),
  })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, JSON.stringify(result, null, 2) + '\n', { signal, flag: 'wx' }),
    catch: (cause) => new StudyError({ message: 'Unable to write new study output', cause: Redacted.make(cause) }),
  })
})

if (import.meta.main) NodeRuntime.runMain(main)
