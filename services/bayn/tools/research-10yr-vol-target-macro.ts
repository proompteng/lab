import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Redacted, Schema } from 'effect'

import { sha256 } from '../src/hash'
import { type Etf } from '../src/strategy/macro-etf-core/policy'
import { etfs as o1Etfs, mix as o1Spec } from './etf-canary-macro-protocol'
import { marks, replay as replayO1 } from './etf-canary-macro-replay'
import { features, targets } from './etf-canary-macro-signals'
import { loadDevelopment, loadHoldout, withArchive } from './noise-area-study-data'
import { baskets, capital, createReplay, netAt, prepare, splits } from './noise-area-study-replay'
import { blend } from './orthogonal-pillar3-metrics'
import { receipts } from './pure-etf-dual-horizon-data'
import { base as b0Spec, verifyBaseline } from './research-10yr-qqq-smh-conditioning'
import { pearson } from './research-orb-zab-statistics'
import { foldBounds, requireAlignedSessions } from './research-lib/calendar'
import { withS3Archive } from './research-lib/s3-archive'
import {
  calmar,
  dailySharpe,
  deflatedSharpe,
  expectedMaximumSharpe,
  maxDrawdown,
  mean,
  sharpe,
  sortino,
  stationaryBootstrap,
  stationaryMeanP,
  sum,
  wealth,
} from './research-lib/statistics'
import { type Bar, type DailyFrame, loadFrozenDailyFrames } from './research/macro-etf-core-dual-horizon-data'
import { universe as f4Etfs } from './vol-regime-carry-data'
import { openingTrade, replay as replayF4 } from './vol-regime-carry-replay'
import { signalModel, type Trial as F4Trial } from './vol-regime-carry-signals'

export const tickers = [
  'SPY',
  'QQQ',
  'IWM',
  'EFA',
  'EEM',
  'TLT',
  'IEF',
  'GLD',
  'DBC',
  'SHY',
] as const satisfies readonly Etf[]
const horizons = [21, 63, 126, 252] as const
const forecastSessions = 63
const volFloor = 0.05
const warmup = Math.max(...horizons) + 1
const annualDays = 252
const overlayWeight = 0.25
const costs = [0, 2, 5, 10] as const
const bootstrap = { draws: 10_000, meanBlock: 10, seed: 0x19f2016 }
const protocolFile = new URL(
  '../../../docs/bayn/evidence/2026-11-27-10yr-vol-target-macro/protocol.md',
  import.meta.url,
)

enum Reference {
  SPY = 'SPY',
  SHY = 'SHY',
  B0 = 'B0',
  F4 = 'F4',
  O1 = 'O1',
  Stack = 'B0+F4+O1',
}

const incumbents = [Reference.B0, Reference.F4, Reference.O1] as const
const references = [Reference.SHY, ...incumbents, Reference.Stack] as const
const settings = ([8, 10, 12] as const).flatMap((vol) =>
  ([0, 10] as const).map((band) => ({ id: `T${vol}-D${band}`, targetVol: vol / 100, band: band / 100 })),
)
export const trials = settings.flatMap((setting) =>
  references.map((reference) => ({
    id: reference === Reference.SHY ? setting.id : `${reference}+${setting.id}`,
    setting: setting.id,
    reference,
  })),
)

type Price = Pick<Bar, 'open' | 'close'>
export type TrendSession = { readonly date: string; readonly bars: readonly Price[] }
type Signal = { readonly weights: readonly number[]; readonly forecast: number }
type Day = { readonly date: string; readonly net: number; readonly turnover: number; readonly borrow: number }
type Path = readonly Day[]
type Bounds = { readonly first: number; readonly end: number }
type Inference = ReturnType<typeof compare>

export const trendPanel = (frames: readonly Pick<DailyFrame, 'date' | 'bars'>[]): TrendSession[] => {
  requireAlignedSessions(frames)
  return frames.map(({ date, bars }) => ({
    date,
    bars: tickers.map((ticker) => {
      const bar = bars.get(ticker)
      if (bar === undefined || ![bar.open, bar.close].every((price) => Number.isFinite(price) && price > 0))
        throw new Error(`Missing or invalid trend bar: ${ticker} ${date}`)
      return bar
    }),
  }))
}

const annualVol = (returns: readonly number[]) => {
  if (returns.length < 2 || returns.every((value) => value === returns[0])) return 0
  const center = mean(returns)
  return Math.sqrt((sum(returns.map((value) => (value - center) ** 2)) * annualDays) / (returns.length - 1))
}

export const closeSignals = (sessions: readonly TrendSession[]): (Signal | undefined)[] => {
  const moves = sessions.map(({ bars }, i) =>
    i === 0 ? [] : bars.map((bar, j) => bar.close / sessions[i - 1].bars[j].close - 1),
  )
  return sessions.map(({ bars }, i) => {
    if (i < warmup - 1) return undefined
    const recent = moves.slice(i - forecastSessions + 1, i + 1)
    const raw = bars.map(({ close }, j) => {
      const vote = Math.max(0, mean(horizons.map((horizon) => Math.sign(close - sessions[i - horizon].bars[j].close))))
      return vote / Math.max(volFloor, annualVol(recent.map((row) => row[j])))
    })
    const total = sum(raw)
    if (total === 0) return { weights: raw, forecast: 0 }
    const weights = raw.map((value) => value / total)
    // Repricing the current weights on the trailing panel includes covariance, without estimating future P&L.
    const forecast = annualVol(recent.map((row) => sum(weights.map((weight, j) => weight * row[j]))))
    return { weights, forecast }
  })
}

export const outsideBand = (held: readonly number[], target: readonly number[], band: number) => {
  const changes = target.map((weight, i) => weight - held[i])
  const replacement = Math.max(sum(changes.filter((x) => x > 0)), -sum(changes.filter((x) => x < 0)))
  return replacement > 1e-12 && replacement >= band
}

export const replayTrend = (
  sessions: readonly TrendSession[],
  signals: readonly (Signal | undefined)[],
  targetVol: number,
  band: number,
  oneWayBps: number,
): Path => {
  if (signals.length !== sessions.length) throw new Error('Unaligned trend signals')
  let held: readonly number[] = Array.from({ length: sessions[0]?.bars.length ?? 0 }, () => 0)
  return sessions.map(({ bars, date }, i) => {
    const signal = signals[i - 1]
    const scale = signal === undefined || signal.forecast === 0 ? 1 : Math.min(1, targetVol / signal.forecast)
    const target = signal?.weights.map((weight) => weight * scale)
    const rebalance = target !== undefined && outsideBand(held, target, band)
    const cash = 1 - sum(held)
    const opened = i === 0 ? held : bars.map(({ open }, j) => held[j] * (open / sessions[i - 1].bars[j].close))
    const openNav = cash + sum(opened)
    if (!(Number.isFinite(openNav) && openNav > 0)) throw new Error(`Invalid trend opening NAV: ${date}`)
    const fill = rebalance ? openingTrade([...opened], openNav, target, oneWayBps * 2) : undefined
    const closing = (fill?.invested ?? opened).map((value, j) => value * (bars[j].close / bars[j].open))
    const closeNav = (fill?.cash ?? cash) + sum(closing)
    if (!(Number.isFinite(closeNav) && closeNav > 0)) throw new Error(`Invalid trend closing NAV: ${date}`)
    held = closing.map((value) => value / closeNav)
    return { date, net: closeNav - 1, turnover: fill?.turnover ?? 0, borrow: 0 }
  })
}

const mixPaths = (paths: readonly Path[], weights: readonly number[], oneWayBps: number): Path =>
  blend(paths, weights, oneWayBps).map((day, i) => ({ ...day, date: paths[0][i].date }))

const buyAndHold = (frames: readonly DailyFrame[], ticker: Reference.SHY | Reference.SPY, oneWayBps: number): Path => {
  const invested = 1 / (1 + oneWayBps / 10_000)
  let previousClose: number | undefined
  return frames.map(({ date, bars }) => {
    const bar = bars.get(ticker)
    if (bar === undefined) throw new Error(`Missing passive price: ${ticker} ${date}`)
    const net = previousClose === undefined ? (invested * bar.close) / bar.open - 1 : bar.close / previousClose - 1
    previousClose = bar.close
    return { date, net, turnover: date === frames[0].date ? invested / 2 : 0, borrow: 0 }
  })
}

const returns = (path: Path) => path.map(({ net }) => net)
const slice = <A>(rows: readonly A[], { first, end }: Bounds) => rows.slice(first, end)

export const summarize = (path: Path) => {
  if (
    path.length === 0 ||
    path.some(({ net, turnover }) => !Number.isFinite(net) || net <= -1 || !Number.isFinite(turnover) || turnover < 0)
  )
    throw new Error('Invalid return or turnover series')
  const daily = returns(path)
  const nav = wealth(daily, true)
  const cagr = nav ** (annualDays / daily.length) - 1
  const drawdown = maxDrawdown(daily, true)
  return {
    netReturn: nav - 1,
    cagr,
    annualVol: annualVol(daily),
    sharpe: sharpe(daily),
    sortino: sortino(daily),
    calmar: calmar(cagr, drawdown),
    maxDrawdown: drawdown,
    annualOneWayTurnover: annualDays * mean(path.map(({ turnover }) => turnover)),
  }
}

export const breakeven = (path: Path) => {
  const cap = 1000
  if (wealth(returns(path), true) <= 1) return { status: 'nonpositive-at-zero', bps: 0 } as const
  if (path.every(({ turnover }) => turnover === 0)) return { status: 'no-trades', bps: null } as const
  const staysProfitable = (bps: number) => {
    let nav = 1
    for (const { net, turnover } of path) {
      const factor = 1 + net - (2 * turnover * bps) / 10_000
      if (factor <= 0) return false
      nav *= factor
    }
    return nav > 1
  }
  if (staysProfitable(cap)) return { status: 'above-bound', bps: cap } as const
  let low = 0
  let high = cap
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2
    if (staysProfitable(middle)) low = middle
    else high = middle
  }
  return { status: 'estimated', bps: (high + low) / 2 } as const
}

const excess = (trial: readonly number[], reference: readonly number[]) => trial.map((value, i) => value - reference[i])

const compare = (trial: Path, reference: Path, plan: ReturnType<typeof stationaryBootstrap>, nullSharpe: number) => {
  requireAlignedSessions(reference, trial)
  const a = summarize(trial)
  const b = summarize(reference)
  const dailyExcess = excess(returns(trial), returns(reference))
  return {
    cagrLift: a.cagr - b.cagr,
    sharpeLift: a.sharpe === null || b.sharpe === null ? null : a.sharpe - b.sharpe,
    maxDrawdownImprovement: b.maxDrawdown - a.maxDrawdown,
    stationaryP: stationaryMeanP(dailyExcess, plan),
    dsr: deflatedSharpe(dailyExcess, nullSharpe),
  }
}

const passes = ({ cagrLift, sharpeLift, maxDrawdownImprovement, stationaryP, dsr }: Inference) =>
  cagrLift > 0 &&
  sharpeLift !== null &&
  sharpeLift > 0 &&
  maxDrawdownImprovement > 0 &&
  stationaryP !== null &&
  stationaryP < 0.05 &&
  dsr !== null &&
  dsr >= 0.95

export const passesPromotion = (byCost: ReadonlyMap<number, Inference>) =>
  costs.slice(1).every((bp) => {
    const atCost = byCost.get(bp)
    return atCost !== undefined && passes(atCost)
  })

const loadB0 = withArchive(async (archive) => {
  const development = await loadDevelopment(archive)
  const holdout = await loadHoldout(archive)
  const days = [...development.days, ...holdout.days]
  const replay = Array.from(prepare(days, baskets.B0), (day) => {
    let traded = 0
    const ledger = createReplay(day)(b0Spec, baskets.B0, undefined, {
      budget: capital,
      onFill: ({ quantity, entry, exit }) => {
        traded += quantity * (entry + exit)
      },
    })
    return { date: day.date, ledger, turnover: traded / (2 * capital) }
  })
  return { replay, developmentRows: development.coverage.physical, holdoutRows: holdout.coverage.physical }
}).pipe(Effect.timeout('5 minutes'))

const f4Spec = { family: 'F4', cadence: 42, power: 1, credit: 'LQD', mix: 'parity' } satisfies F4Trial
const checkPublished = (observed: number, expected: number, label: string, tolerance: number) => {
  if (!Number.isFinite(observed) || Math.abs(observed - expected) >= tolerance)
    throw new Error(`Published ${label} mismatch: ${observed} vs ${expected}`)
  return observed
}

const incumbentsAtCost = (frames: readonly DailyFrame[], b0: Effect.Success<typeof loadB0>) => {
  requireAlignedSessions(frames, b0.replay)
  const dates = frames.map(({ date }) => date)
  const fold = ({ first, last, count }: (typeof splits)[keyof typeof splits]) => foldBounds(dates, first, last, count)
  const windows = {
    train: fold(splits.train),
    validation: fold(splits.validation),
    holdout: fold(splits.holdout),
    full: { first: 0, end: dates.length },
  }
  const ledgers = b0.replay.map(({ ledger }) => ledger)
  const b0Audit = {
    train: verifyBaseline(slice(ledgers, windows.train), 'train'),
    validation: verifyBaseline(slice(ledgers, windows.validation), 'validation'),
    holdout: verifyBaseline(slice(ledgers, windows.holdout), 'holdout'),
    full: verifyBaseline(ledgers, 'full'),
  }
  const f4Frames = frames.map(({ date, bars }) => ({ date, bars: f4Etfs.map((ticker) => bars.get(ticker)) }))
  const f4Targets = signalModel(f4Frames)(f4Spec)
  const f4 = (rt: number) => replayF4(f4Frames, f4Targets, rt).map(({ date, idle }) => ({ ...idle, date, borrow: 0 }))
  const auditF4Windows = ['train', 'validation', 'holdout', 'full'] as const
  const f4Audit = [
    { roundTripBps: 10, expected: [0.426060485, 0.078919864, 0.372083365, 1.111094304] },
    { roundTripBps: 20, expected: [0.41836733, 0.077613006, 0.36920683, 1.092765661] },
  ].map(({ roundTripBps, expected }) => {
    const path = f4(roundTripBps)
    const observed = Object.fromEntries(
      auditF4Windows.map((name, i) => [
        name,
        checkPublished(wealth(returns(slice(path, windows[name])), true) - 1, expected[i], `F4 ${name}`, 5.01e-10),
      ]),
    )
    return { roundTripBps, observed }
  })
  const o1Frames = frames.map(({ date, bars }) => ({
    date,
    // The loader authenticates the known XLC/XLRE gaps; O1's frozen model leaves them ineligible.
    open: Float64Array.from(o1Etfs, (ticker) => bars.get(ticker)?.open ?? NaN),
    close: Float64Array.from(o1Etfs, (ticker) => bars.get(ticker)?.close ?? NaN),
  }))
  const o1Marks = marks(o1Frames)
  const o1Targets = targets(o1Spec, features(o1Frames), -1)
  const o1 = (rt: number): Path => {
    const { net, turnover } = replayO1(o1Marks, o1Targets, o1Spec, rt, true, -1)
    return dates.map((date, i) => ({ date, net: net[i], turnover: turnover[i], borrow: 0 }))
  }
  const o1Audit = [
    { roundTripBps: 2, expected: 0.9442965714 },
    { roundTripBps: 5, expected: 0.9286692789 },
    { roundTripBps: 10, expected: 0.9029113849 },
  ].map(({ roundTripBps, expected }) => ({
    roundTripBps,
    full: checkPublished(wealth(returns(o1(roundTripBps)), true) - 1, expected, 'O1 Full', 1e-9),
  }))
  const atCost = (bp: number): Record<Reference, Path> => {
    const paths = {
      [Reference.SPY]: buyAndHold(frames, Reference.SPY, bp),
      [Reference.SHY]: buyAndHold(frames, Reference.SHY, bp),
      [Reference.B0]: b0.replay.map(({ date, ledger, turnover }) => {
        const pnl = netAt(ledger, bp * 2)
        if (pnl === null) throw new Error(`Unresolved B0 position: ${date}`)
        return { date, net: pnl / capital, turnover, borrow: 0 }
      }),
      [Reference.F4]: f4(bp * 2),
      [Reference.O1]: o1(bp * 2),
    }
    return {
      ...paths,
      [Reference.Stack]: mixPaths(
        incumbents.map((id) => paths[id]),
        [1 / 3, 1 / 3, 1 / 3],
        bp,
      ),
    }
  }
  return {
    atCost,
    windows,
    audits: {
      b0: {
        id: b0Spec.id,
        roundTripBps: [2, 5],
        reproduced: b0Audit,
        missingEntries: sum(ledgers.map(({ missingEntries }) => missingEntries)),
        missingHeldBars: sum(ledgers.map(({ missingHeld }) => missingHeld)),
        developmentRows: b0.developmentRows,
        holdoutRows: b0.holdoutRows,
      },
      f4: { id: 'F4-42-1-LQD-parity', reproduced: f4Audit },
      o1: { id: 'Wave 5D ensemble/base', reproduced: o1Audit },
    },
  }
}

const evaluate = (frames: readonly DailyFrame[], b0: Effect.Success<typeof loadB0>) => {
  const { windows, audits, atCost } = incumbentsAtCost(frames, b0)
  const panel = trendPanel(frames)
  const signals = closeSignals(panel)
  const investable = { first: warmup, end: frames.length }
  const bounds = { ...windows, investable }
  const samples = Object.fromEntries(
    Object.entries(bounds).map(([key, { first, end }]) => [
      key,
      { first: frames[first].date, last: frames[end - 1].date, sessions: end - first },
    ]),
  )
  const years = Array.from({ length: 11 }, (_, i) => {
    const year = String(2016 + i)
    const first = frames.findIndex(({ date }) => date.startsWith(year))
    const end = frames.findLastIndex(({ date }) => date.startsWith(year)) + 1
    if (first < 0 || end <= first) throw new Error(`Missing calendar year: ${year}`)
    return [year, { first, end }] as const
  })
  const inferenceWindows = (['full', 'holdout'] as const).map((name) => {
    const range = bounds[name]
    return { name, range, plan: stationaryBootstrap(range.end - range.first, bootstrap) }
  })
  const development = { first: warmup, end: windows.validation.end }
  const scenarios = costs.map((oneWayBps) => {
    const controls = atCost(oneWayBps)
    const trend = new Map(
      settings.map(({ id, targetVol, band }) => [id, replayTrend(panel, signals, targetVol, band, oneWayBps)]),
    )
    const candidates = trials.map((trial) => {
      const sleeve = trend.get(trial.setting)
      if (sleeve === undefined) throw new Error(`Missing preregistered sleeve: ${trial.setting}`)
      const path =
        trial.reference === Reference.SHY
          ? sleeve
          : trial.reference === Reference.Stack
            ? mixPaths([...incumbents.map((id) => controls[id]), sleeve], [0.25, 0.25, 0.25, overlayWeight], oneWayBps)
            : mixPaths([controls[trial.reference], sleeve], [1 - overlayWeight, overlayWeight], oneWayBps)
      return { ...trial, path }
    })
    const developmentSharpes = candidates.map(({ id, path, reference }) => {
      const value = dailySharpe(
        excess(returns(slice(path, development)), returns(slice(controls[reference], development))),
      )
      if (value === null || !Number.isFinite(value)) throw new Error(`Undefined development excess Sharpe: ${id}`)
      return value
    })
    const nullSharpe = expectedMaximumSharpe(developmentSharpes, trials.length)
    if (nullSharpe === null) throw new Error('Undefined development DSR benchmark')
    const paths: Record<string, Path> = { ...controls }
    for (const { id, path } of candidates) paths[id] = path
    return {
      oneWayBps,
      dsrNullDailySharpe: nullSharpe,
      portfolios: Object.fromEntries(
        Object.entries(paths).map(([id, path]) => [
          id,
          {
            ...Object.fromEntries(Object.entries(bounds).map(([name, range]) => [name, summarize(slice(path, range))])),
            yearlyReturns: Object.fromEntries(
              years.map(([year, range]) => [year, wealth(returns(slice(path, range)), true) - 1]),
            ),
          },
        ]),
      ),
      comparisons: Object.fromEntries(
        candidates.map(({ id, path, reference }) => {
          const [full, holdout] = inferenceWindows.map(({ range, plan }) =>
            compare(slice(path, range), slice(controls[reference], range), plan, nullSharpe),
          )
          return [id, { reference, full, holdout }]
        }),
      ),
      correlations: Object.fromEntries(
        inferenceWindows.map(({ name, range }) => {
          const references = [...incumbents, Reference.SPY].map(
            (id) => [id, returns(slice(controls[id], range))] as const,
          )
          return [
            name,
            Object.fromEntries(
              Object.entries(paths).map(([id, path]) => {
                const daily = returns(slice(path, range))
                return [id, Object.fromEntries(references.map(([ref, series]) => [ref, pearson(daily, series)]))]
              }),
            ),
          ]
        }),
      ),
      ...(oneWayBps === 0
        ? {
            breakeven: Object.fromEntries(
              Object.entries(paths).map(([id, path]) => [
                id,
                { full: breakeven(path), holdout: breakeven(slice(path, bounds.holdout)) },
              ]),
            ),
          }
        : {}),
    }
  })
  const qualifyingTrials = trials
    .filter(
      ({ id, reference }) =>
        reference === Reference.Stack &&
        passesPromotion(new Map(scenarios.map(({ oneWayBps, comparisons }) => [oneWayBps, comparisons[id].holdout]))),
    )
    .map(({ id }) => id)
  return {
    tickers,
    tickerSessions: Object.fromEntries(tickers.map((ticker) => [ticker, frames.length])),
    samples,
    warmupSessions: warmup,
    signal: { horizons, forecastSessions, volFloor, settings, overlayWeight },
    trials,
    exactTrialCount: trials.length,
    bootstrap,
    dsrReferenceSample: {
      first: frames[development.first].date,
      last: frames[development.end - 1].date,
      sessions: development.end - development.first,
    },
    baselineAudit: audits,
    scenarios,
    qualifyingTrials,
    verdict: qualifyingTrials.length === 0 ? 'DO NOT PROMOTE' : 'PROMOTE',
  }
}

enum DailySource {
  AlpacaSipTotalReturn = 'Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])',
}
const decodeRoster = Schema.decodeUnknownSync(
  Schema.Struct({ source: Schema.Enum(DailySource), etfs: Schema.Array(Schema.String) }),
)

class StudyError extends Data.TaggedError('VolTargetMacroStudyError')<{
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const compute = <A>(message: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new StudyError({
        message: cause instanceof Error ? `${message}: ${cause.message}` : message,
        cause: Redacted.make(cause),
      }),
  })

const main = Effect.gen(function* () {
  const { values } = yield* Effect.try({
    try: () => parseArgs({ args: Bun.argv.slice(2), options: { output: { type: 'string' } } }),
    catch: (cause) =>
      new StudyError({ message: 'Invalid arguments; expected --output NEW_RESULTS.json', cause: Redacted.make(cause) }),
  })
  const output = values.output
  if (output === undefined || output.trim() === '')
    return yield* new StudyError({
      message: 'Usage: bun services/bayn/tools/research-10yr-vol-target-macro.ts --output NEW_RESULTS.json',
    })
  const provenance = yield* Effect.tryPromise({
    try: async (signal) => ({
      protocolSha256: sha256(await readFile(protocolFile, { signal })),
      runnerSha256: sha256(await readFile(new URL(import.meta.url), { signal })),
    }),
    catch: (cause) => new StudyError({ message: 'Unable to hash study registration', cause: Redacted.make(cause) }),
  })
  const { prefix, manifestSha256 } = receipts.datasets.daily
  const manifest = yield* withS3Archive((archive) => archive.readJson(`${prefix}/MANIFEST.json`, manifestSha256)).pipe(
    Effect.timeout('1 minute'),
  )
  yield* compute('Invalid daily ETF roster', () => {
    const { etfs } = decodeRoster(manifest)
    const missing = tickers.filter((ticker) => !etfs.includes(ticker))
    if (missing.length !== 0) throw new Error(`Required tickers not in pinned archive: ${missing.join(', ')}`)
  })
  const daily = yield* loadFrozenDailyFrames
  const b0 = yield* loadB0
  const summary = yield* compute('Wave 19F replay failed', () => evaluate(daily, b0))
  yield* Effect.tryPromise({
    try: (signal) =>
      writeFile(
        output,
        JSON.stringify(
          { schemaVersion: 'bayn.wave19f.vol-target-macro.v1', provenance, archive: receipts, ...summary },
          null,
          2,
        ) + '\n',
        { flag: 'wx', signal },
      ),
    catch: (cause) => new StudyError({ message: 'Unable to write new study receipt', cause: Redacted.make(cause) }),
  })
})

if (import.meta.main) NodeRuntime.runMain(main)
