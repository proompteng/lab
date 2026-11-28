import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { NodeRuntime } from '@effect/platform-node'
import { Console, Data, Effect, Logger, Result } from 'effect'

import { sha256 } from '../src/hash'
import { rebalanceDue, withShyCarry } from '../src/strategy/macro-etf-core/planner'
import { asset, type Etf, parameters, Profile, universe } from '../src/strategy/macro-etf-core/policy'
import { replayMacroEtfCoreSignals } from '../src/strategy/macro-etf-core/signals'
import { outsideDriftBand } from './macro-canary-runner/planner'
import { coexistenceWeights } from './macro-etf-core-runner/allocation'
import { intradaySymbols, RunnerProfile } from './macro-etf-core-runner/contract'
import { receipts } from './pure-etf-dual-horizon-data'
import { elapsedDays, requireAlignedSessions } from './research-lib/calendar'
import { dailySharpe, mean, sum } from './research-lib/statistics'
import { closeEvidence, type DailyFrame, loadFrozenDailyFrames } from './research/macro-etf-core-dual-horizon-data'
import { wave5dTargets } from './research/macro-etf-core-wave5d'

const profiles = [RunnerProfile.F4, RunnerProfile.F2, RunnerProfile.Equal, 'O1'] as const
type SizingProfile = (typeof profiles)[number]
export type SizingSession = { date: string; bars: ReadonlyMap<Etf, { open: number; close: number }> }
type Reviews = ReadonlyMap<string, readonly number[]>
const capital = [10_000, 25_000, 100_000] as const
const costs = [2, 5, 10] as const
const annualSessions = parameters.annualSessions
const micros = (usd: number) => BigInt(Math.round(usd * 1_000_000))
const integerNoise = 1e-10 // Recognize a computed whole lot despite noise in target division.

const mark = (day: SizingSession, symbol: Etf, at: 'open' | 'close') => {
  const value = day.bars.get(symbol)?.[at]
  if (value === undefined || !Number.isFinite(value) || value <= 0)
    throw new Error(`Missing or invalid ${at} mark: ${symbol} ${day.date}`)
  return value
}

// Read drift from the completed close; a gap at the next open isn't a discretionary trigger.
const admittedTargets = (
  profile: SizingProfile,
  target: readonly number[],
  held: readonly number[],
  prior: SizingSession,
  priorEquity: number,
) => {
  const priorValues = universe.map((symbol, i) => (held[i] === 0 ? 0 : held[i] * mark(prior, symbol, 'close')))
  if (profile !== 'O1')
    return rebalanceDue(
      target.map((weight, i) => ({ weight, priorMicros: micros(priorValues[i]) })),
      micros(priorEquity),
    )
      ? target
      : null

  // The isolated canary uses per-name drift and retains in-band non-SHY positions.
  const current = priorValues.map((value) => value / priorEquity)
  const outside = current.map((weight, i) => outsideDriftBand(target[i], weight, held[i]))
  if (!outside.some(Boolean)) return null
  const intended = sum(current.map((weight, i) => (i === asset.SHY ? 0 : outside[i] ? target[i] : weight)))
  const shyWeight = Math.max(0, 1 - intended)
  return target.map((weight, i) =>
    i === asset.SHY
      ? outsideDriftBand(shyWeight, current[i], held[i])
        ? shyWeight
        : null
      : outside[i]
        ? weight
        : null,
  )
}

type ReviewOutcome = 'insideBand' | 'traded' | 'triggeredWithoutTrade'
type Book = { cash: number; held: readonly number[] }

const nav = (book: Book, day: SizingSession, at: 'open' | 'close') =>
  book.cash + sum(universe.map((symbol, i) => (book.held[i] === 0 ? 0 : book.held[i] * mark(day, symbol, at))))

const fillAtOpen = (
  book: Book,
  day: SizingSession,
  openingEquity: number,
  targets: readonly (number | null)[],
  profile: SizingProfile,
  rate: number,
  whole: boolean,
) => {
  let cash = book.cash
  const held = [...book.held]
  const buys: { i: number; qty: number; price: number }[] = []
  let tradedUsd = 0
  for (const [i, symbol] of universe.entries()) {
    const weight = targets[i]
    if (weight === null || (weight === 0 && held[i] === 0)) continue
    const price = mark(day, symbol, 'open')
    const targetUsd = openingEquity * weight
    const desired = targetUsd / price
    if (desired < held[i] - integerNoise) {
      // The core floors the final target lot; the canary floors the number of shares sold.
      const reduction = held[i] - desired
      const qty = !whole
        ? reduction
        : profile === 'O1'
          ? Math.floor(reduction + integerNoise)
          : held[i] - Math.floor(desired + integerNoise)
      held[i] -= qty
      tradedUsd += qty * price
      cash += qty * price * (1 - rate)
    } else {
      const add = targetUsd / (price * (1 + rate)) - held[i]
      const qty = whole ? Math.floor(add + integerNoise) : add
      if (qty > integerNoise) buys.push({ i, qty, price })
    }
  }
  // This is an auction-fill model, not a presubmission budget: only simulated fills release cash.
  const wanted = sum(buys.map(({ qty, price }) => qty * price * (1 + rate)))
  const scale = wanted > cash ? cash / wanted : 1
  for (const { i, qty, price } of buys) {
    const affordable = qty * scale
    const buy = whole ? Math.floor(affordable + integerNoise) : affordable
    held[i] += buy
    tradedUsd += buy * price
    cash -= buy * price * (1 + rate)
  }
  if (cash < -1e-7) throw new Error(`Sizer overspent cash: ${day.date}`)
  return { book: { cash: Math.max(0, cash), held }, tradedUsd }
}

const replay = (
  days: readonly SizingSession[],
  reviews: Reviews,
  profile: SizingProfile,
  initialEquityUsd: number,
  oneWayBps: number,
  whole: boolean,
) => {
  const rate = oneWayBps / 10_000
  let book: Book = { cash: initialEquityUsd, held: universe.map(() => 0) }
  let equity = initialEquityUsd
  let started = false
  return days.map((day, index) => {
    const prior = days[index - 1]
    const before = equity
    let review: ReviewOutcome | null = null
    let oneWayTurnover = 0
    let expensiveLots = false
    let wholeLotsBlocked = false
    const target = prior === undefined ? undefined : reviews.get(prior.date)
    if (prior !== undefined && target !== undefined) {
      started = true
      expensiveLots = mark(prior, 'SPY', 'close') >= 600 && mark(prior, 'QQQ', 'close') >= 510
      const admitted = admittedTargets(profile, target, book.held, prior, before)
      review = admitted === null ? 'insideBand' : 'triggeredWithoutTrade'
      if (admitted !== null) {
        const openingEquity = nav(book, day, 'open')
        const fill = fillAtOpen(book, day, openingEquity, admitted, profile, rate, whole)
        if (fill.tradedUsd > 0) review = 'traded'
        // Test the same book and target to separate the lot constraint from the policy's no-op reviews.
        else if (whole)
          wholeLotsBlocked = fillAtOpen(book, day, openingEquity, admitted, profile, rate, false).tradedUsd > 0
        book = fill.book
        oneWayTurnover = fill.tradedUsd / (2 * openingEquity)
      }
    }
    equity = nav(book, day, 'close')
    return {
      date: day.date,
      equity,
      net: equity / before - 1,
      cashPct: 100 * (book.cash / equity),
      started,
      review,
      oneWayTurnover,
      expensiveLots,
      wholeLotsBlocked,
    }
  })
}

type Replay = ReturnType<typeof replay>
const summarize = (rows: Replay, initial: number, years: number) => {
  const finalEquityUsd = rows[rows.length - 1].equity
  const sharpe = dailySharpe(rows.map(({ net }) => net))
  let peak = initial
  let maxDrawdown = 0
  for (const { equity } of rows) {
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak)
  }
  const deployed = rows.filter(({ started }) => started)
  return {
    finalEquityUsd,
    cagrPct: 100 * ((finalEquityUsd / initial) ** (1 / years) - 1),
    sharpe: sharpe === null ? null : sharpe * Math.sqrt(annualSessions),
    maxDrawdownPct: 100 * maxDrawdown,
    avgUninvestedCashPct: mean(rows.map(({ cashPct }) => cashPct)),
    avgUninvestedCashAfterFirstReviewPct: deployed.length === 0 ? null : mean(deployed.map(({ cashPct }) => cashPct)),
    annualOneWayTurnover: annualSessions * mean(rows.map(({ oneWayTurnover }) => oneWayTurnover)),
  }
}

const reviewCounts = (rows: Replay) => {
  let consecutive = 0
  let maxConsecutiveTriggeredWithoutTrade = 0
  const triggeredWithoutTradeDates = []
  let insideBand = 0
  let traded = 0
  for (const { date, review } of rows) {
    if (review === null) continue
    if (review === 'triggeredWithoutTrade') {
      triggeredWithoutTradeDates.push(date)
      maxConsecutiveTriggeredWithoutTrade = Math.max(maxConsecutiveTriggeredWithoutTrade, ++consecutive)
    } else {
      consecutive = 0
      if (review === 'insideBand') insideBand++
      else traded++
    }
  }
  return { insideBand, traded, triggeredWithoutTradeDates, maxConsecutiveTriggeredWithoutTrade }
}

const compareReviews = (fractional: Replay, whole: Replay) => ({
  fractional: reviewCounts(fractional),
  whole: reviewCounts(whole),
  onlyFractionalTraded: fractional.filter(({ review }, i) => review === 'traded' && whole[i].review !== 'traded')
    .length,
  onlyWholeTraded: whole.filter(({ review }, i) => review === 'traded' && fractional[i].review !== 'traded').length,
  wholeLotsBlockedDates: whole.filter(({ wholeLotsBlocked }) => wholeLotsBlocked).map(({ date }) => date),
})

export const compareSizing = (
  days: readonly SizingSession[],
  reviews: Reviews,
  profile: SizingProfile,
  initialEquityUsd: number,
  oneWayBps: number,
) => {
  const first = days[0]
  const last = days.at(-1)
  if (first === undefined || last === undefined || days.length < 2) throw new Error('Need at least two sessions')
  requireAlignedSessions(days)
  const years = (elapsedDays(first.date, last.date) + 1) / 365.2425
  const frac = replay(days, reviews, profile, initialEquityUsd, oneWayBps, false)
  const lots = replay(days, reviews, profile, initialEquityUsd, oneWayBps, true)
  const fractional = summarize(frac, initialEquityUsd, years)
  const whole = summarize(lots, initialEquityUsd, years)
  const active = lots.map(({ net }, i) => net - frac[i].net)
  const average = mean(active)
  const deviation = Math.sqrt(sum(active.map((value) => (value - average) ** 2)) / (active.length - 1))
  return {
    profile,
    initialEquityUsd,
    oneWayBps,
    fractional,
    whole,
    trackingErrorAnnualizedPct: 100 * Math.sqrt(annualSessions) * deviation,
    wholeMinusFractional: {
      cagrPp: whole.cagrPct - fractional.cagrPct,
      sharpe: whole.sharpe === null || fractional.sharpe === null ? null : whole.sharpe - fractional.sharpe,
      maxDrawdownPp: whole.maxDrawdownPct - fractional.maxDrawdownPct,
      avgUninvestedCashPp: whole.avgUninvestedCashPct - fractional.avgUninvestedCashPct,
      annualOneWayTurnover: whole.annualOneWayTurnover - fractional.annualOneWayTurnover,
    },
    reviews: compareReviews(frac, lots),
    reviewsWithPriorSpyAtLeast600AndQqqAtLeast510: compareReviews(
      frac.filter(({ expensiveLots }) => expensiveLots),
      lots.filter(({ expensiveLots }) => expensiveLots),
    ),
  }
}

const runStudy = (daily: readonly DailyFrame[]) => {
  const evidence = closeEvidence(daily)
  const core = (profile: Profile) =>
    Result.getOrThrow(replayMacroEtfCoreSignals({ schema: 'bayn.macro-etf-core-policy.v1', profile }, evidence))
  const f2 = core(Profile.F2)
  const f4 = core(Profile.F4)
  if (f2.length !== f4.length) throw new Error('Core profiles have different review cadences')
  const indices = new Map(daily.map(({ date }, i) => [date, i]))
  const adjust = (date: string, weights: readonly number[]) => {
    const i = indices.get(date)
    if (i === undefined) throw new Error(`Unbound core review: ${date}`)
    const excluded = new Set<string>(intradaySymbols)
    const closing = daily[i]
    const recent = daily.slice(i + 1 - parameters.minimumCandidateHistory, i + 1)
    const eligible = new Set(universe.filter((symbol) => recent.every(({ bars }) => bars.has(symbol))))
    for (const symbol of parameters.optionalCandidates) if (!closing.bars.has(symbol)) excluded.add(symbol)
    return coexistenceWeights(weights, excluded, eligible)
  }
  const reviews: Record<SizingProfile, Reviews> = {
    [RunnerProfile.F2]: new Map(f2.map(({ signalDate, weights }) => [signalDate, adjust(signalDate, weights)])),
    [RunnerProfile.F4]: new Map(f4.map(({ signalDate, weights }) => [signalDate, adjust(signalDate, weights)])),
    [RunnerProfile.Equal]: new Map(
      f2.map(({ signalDate, weights }, i) => {
        if (f4[i].signalDate !== signalDate) throw new Error(`Unpaired core review: ${signalDate}`)
        return [
          signalDate,
          adjust(
            signalDate,
            weights.map((weight, j) => (weight + f4[i].weights[j]) / 2),
          ),
        ]
      }),
    ),
    O1: new Map(
      wave5dTargets(daily)
        .slice(0, -1)
        .flatMap((weights, i) => (weights === undefined ? [] : [[daily[i].date, withShyCarry(weights)]])),
    ),
  }
  return {
    schema: 'bayn.small-account-sizing-study.v1',
    from: daily[0].date,
    through: daily[daily.length - 1].date,
    sessions: daily.length,
    archives: {
      bucket: receipts.bucket,
      base: receipts.datasets.daily,
      supplement: receipts.datasets.macro,
      calendars: receipts.calendars,
    },
    closeSnapshotSha256: evidence.snapshotHash,
    reviewReceipts: profiles.map((profile) => ({
      profile,
      count: reviews[profile].size,
      sha256: sha256(JSON.stringify([...reviews[profile]])),
    })),
    coreProtectedSymbols: intradaySymbols,
    sizingPrices: 'split-and-dividend-adjusted SIP (whole adjusted-share proxy)',
    results: profiles.flatMap((profile) =>
      capital.flatMap((usd) => costs.map((bps) => compareSizing(daily, reviews[profile], profile, usd, bps))),
    ),
  }
}

class SizingStudyError extends Data.TaggedError('SmallAccountSizingStudyError')<{ readonly cause: unknown }> {}
const usage = 'Usage: bun services/bayn/tools/research-10k-small-account-sizing.ts --output <new-report.json>'

const main = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () => parseArgs({ args: Bun.argv.slice(2), options: { output: { type: 'string' } }, tokens: true }),
    catch: () => new SizingStudyError({ cause: usage }),
  })
  const output = args.values.output
  if (args.tokens.length !== 1 || output === undefined || output.trim().length === 0)
    return yield* new SizingStudyError({ cause: usage })
  const daily = yield* loadFrozenDailyFrames
  const report = yield* Effect.try({ try: () => runStudy(daily), catch: (cause) => new SizingStudyError({ cause }) })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx', signal }),
    catch: (cause) => new SizingStudyError({ cause }),
  })
  yield* Effect.logInfo('Small-account sizing report written', {
    sessions: report.sessions,
    cases: report.results.length,
  })
})

if (import.meta.main) {
  NodeRuntime.runMain(
    Bun.argv.length === 3 && Bun.argv[2] === '--help'
      ? Console.log(usage)
      : // @effect-diagnostics-next-line strictEffectProvide:off -- this CLI entry point owns logging.
        main.pipe(Effect.provide(Logger.layer([Logger.consoleJson]))),
  )
}
