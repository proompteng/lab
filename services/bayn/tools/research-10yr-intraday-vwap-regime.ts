import { writeFile } from 'node:fs/promises'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Redacted, Schema } from 'effect'

import { sha256 } from '../src/hash'
import { quantile } from './midday-research-statistics'
import { loadDevelopment, loadHoldout, sources, withArchive } from './noise-area-study-data'
import {
  baskets,
  capital,
  checkpoints,
  closedLeg,
  createReplay,
  prepare,
  type Bar,
  type Day,
  type Trial,
} from './noise-area-study-replay'
import { correlation } from './noise-area-study-statistics'
import { foldBounds, requireAlignedSessions } from './research-lib/calendar'
import {
  dailySharpe,
  deflatedSharpe,
  expectedMaximumSharpe,
  maxDrawdown,
  pairedSharpeDiff,
  sharpe,
  stationaryBootstrap,
  stationaryMeanP,
  sum,
} from './research-lib/statistics'

const symbols = ['QQQ', 'SMH', 'XLK', 'SPY', 'IWM'] as const
type StudySymbol = (typeof symbols)[number]
export const costs = [0, 2.5, 5, 10] as const
const primaryCostIndex = costs.indexOf(5)
const oos = { fromExclusive: '2016-11-25', throughInclusive: '2026-11-25' }
const startYear = 2017
const endYear = 2026
const openingSlots = 3
const rvLookback = 20
const deviationWidth = 0.5
const maxHoldSlots = 12
const bootstrap = { draws: 10_000, meanBlock: 5, seed: 0x19202611 }
const b0: Trial = {
  id: 'B0/30/1.4/opposite_band/inverse_vol_parity',
  basket: 'B0',
  minutes: 30,
  band: 1.4,
  exit: 'opposite_band',
  sizing: 'inverse_vol_parity',
}
const noiseControls = [
  { id: 'B0', symbols: baskets.B0 },
  { id: 'NA5', symbols },
]

export enum NoiseConfirmation {
  None = 'unconditioned',
  Vwap = 'vwap-aligned',
  Range = 'opening-break',
}

export enum Volatility {
  Any = 'any',
  Low = 'low-rv',
  High = 'high-rv',
}

export enum OpeningRange {
  Any = 'any',
  Inside = 'inside',
}

enum BookKind {
  Control = 'control',
  Replacement = 'replacement',
  Reversion = 'reversion',
  Blend = 'blend',
}

const volatilities = [Volatility.Any, Volatility.Low, Volatility.High]
const noiseTrials = noiseControls.flatMap((control) => {
  const { id, symbols: members } = control
  return [
    { confirmation: NoiseConfirmation.None, volatility: Volatility.Any },
    { confirmation: NoiseConfirmation.Vwap, volatility: Volatility.Any },
    { confirmation: NoiseConfirmation.Range, volatility: Volatility.Any },
    { confirmation: NoiseConfirmation.None, volatility: Volatility.Low },
    { confirmation: NoiseConfirmation.None, volatility: Volatility.High },
  ].map(({ confirmation, volatility }) => {
    const unconditioned = confirmation === NoiseConfirmation.None && volatility === Volatility.Any
    const suffix = confirmation === NoiseConfirmation.None ? volatility : confirmation
    return {
      id: unconditioned ? id : `${id}/${suffix}`,
      kind: unconditioned ? BookKind.Control : BookKind.Replacement,
      control: id,
      members,
      confirmation,
      volatility,
    }
  })
})
const reversionTrials = [OpeningRange.Any, OpeningRange.Inside].flatMap((openingRange) =>
  volatilities.map((volatility) => ({
    id: `REV/${openingRange}/${volatility}`,
    kind: BookKind.Reversion as const,
    openingRange,
    volatility,
  })),
)
const blendTrials = reversionTrials.map(({ id }) => ({
  id: `B0+${id}`,
  kind: BookKind.Blend as const,
  sleeve: id,
}))
const trials = [...noiseTrials, ...reversionTrials, ...blendTrials]
export const trialCount = trials.filter(({ kind }) => kind !== BookKind.Control).length * costs.length

const foldYear = (date: string) => Number(date.slice(0, 4)) + Number(date.slice(5) > '11-25')

/** Fit once at each annual boundary, then classify only with trailing completed-session variance. */
export const walkForwardVolatility = (dates: readonly string[], variance: readonly (number | undefined)[]) => {
  if (dates.length !== variance.length) throw new Error('Realized variance must align to official sessions')
  const history: number[] = []
  const cutoffs = new Map<number, { observations: number; median: number | null }>()
  const labels = dates.map((date, i) => {
    const year = foldYear(date)
    if (year >= startYear && !cutoffs.has(year))
      cutoffs.set(year, { observations: history.length, median: quantile(history, 0.5) })
    if (i < rvLookback) return undefined
    const prior = variance.slice(i - rvLookback, i)
    if (!prior.every((value): value is number => value !== undefined)) return undefined
    const realized = Math.sqrt(sum(prior) / rvLookback)
    history.push(realized)
    const median = cutoffs.get(year)?.median
    if (median === undefined || median === null) return undefined
    return realized <= median ? Volatility.Low : Volatility.High
  })
  return { cutoffs, labels }
}

export const sessionFeatures = (bars: readonly (Bar | undefined)[], slots: number) => {
  let weightedPrice = 0
  let volume = 0
  let high = -Infinity
  let low = Infinity
  let squared = 0
  let previousClose: number | undefined
  let complete = true
  const vwap = Array.from({ length: slots }, (_, i) => {
    const bar = bars[i]
    if (bar === undefined) complete = false
    if (!complete || bar === undefined) return undefined
    if (i < openingSlots) {
      high = Math.max(high, bar.high)
      low = Math.min(low, bar.low)
    }
    weightedPrice += bar.vwap * bar.volume
    volume += bar.volume
    squared += Math.log(bar.close / (previousClose ?? bar.open)) ** 2
    previousClose = bar.close
    return weightedPrice / volume
  })
  return {
    vwap,
    range: vwap[openingSlots - 1] === undefined ? undefined : { high, low },
    variance: complete ? squared / slots : undefined,
  }
}

// Both regular and 13:00 ET early closes use an observed open ten minutes before the close at the latest.
const flattenSlot = (slots: number) => slots - 2

const empty = () => ({ base: 0, slope: 0, roundTrips: 0, missingEntries: 0, heldGaps: 0, unresolved: 0, lastExit: -1 })
type Pnl = ReturnType<typeof empty>

const add = (a: Pnl, b: Pnl, weight = 1): Pnl => ({
  base: a.base + b.base * weight,
  slope: a.slope + b.slope * weight,
  roundTrips: a.roundTrips + b.roundTrips,
  missingEntries: a.missingEntries + b.missingEntries,
  heldGaps: a.heldGaps + b.heldGaps,
  unresolved: a.unresolved + b.unresolved,
  lastExit: Math.max(a.lastExit, b.lastExit),
})

export const replayReversion = (
  bars: readonly (Bar | undefined)[],
  slots: number,
  features: ReturnType<typeof sessionFeatures>,
  openingRange: OpeningRange,
): Pnl => {
  const { range, vwap } = features
  if (range === undefined || range.high <= range.low) return empty()
  const deviation = deviationWidth * (range.high - range.low)
  const deadline = flattenSlot(slots)
  for (const decisionSlot of checkpoints(slots, 30)) {
    const close = bars[decisionSlot]?.close
    const anchor = vwap[decisionSlot]
    if (close === undefined || anchor === undefined) continue
    if (openingRange === OpeningRange.Inside && (close < range.low || close > range.high)) continue
    const side = close <= anchor - deviation ? 1 : close >= anchor + deviation ? -1 : 0
    if (side === 0) continue
    const entrySlot = decisionSlot + 1
    const entry = bars[entrySlot]?.open
    if (entry === undefined) return { ...empty(), missingEntries: 1 }
    // Fix the order size at the signal close, not at the then-unknown entry open.
    const shares = Math.floor(capital / symbols.length / (close * (1 + costs[3] / 20_000)))
    if (shares === 0) return empty()
    const timeExit = Math.min(entrySlot + maxHoldSlots, deadline)
    let requested = false
    let heldGaps = 0
    for (let slot = entrySlot; slot <= deadline; slot++) {
      const bar = bars[slot]
      if (bar === undefined) {
        heldGaps++
        requested = true
        continue
      }
      if (requested || slot >= timeExit)
        return { ...empty(), ...closedLeg(side, shares, entry, bar.open), roundTrips: 1, heldGaps, lastExit: slot }
      const currentVwap = vwap[slot]
      requested = currentVwap === undefined || side * (bar.close - currentVwap) >= 0
    }
    return { ...empty(), heldGaps, unresolved: 1 }
  }
  return empty()
}

type Side = 1 | -1
type NoiseOutcome = {
  pnl: Pnl
  decision?: { slot: number; side: Side }
}

const noiseOutcomes = (replay: ReturnType<typeof createReplay>, slots: number, members: readonly StudySymbol[]) =>
  members.map((symbol) => {
    const outcome: NoiseOutcome = { pnl: empty() }
    // Keep each symbol's original basket weight. Blocking other paths never reallocates their budgets.
    const ledger = replay(b0, members, undefined, {
      budget: capital,
      blocked: (other) => other !== symbol,
      onFill: (fill) => {
        outcome.decision = { slot: fill.entrySlot - 1, side: fill.side }
        if (fill.exitSlot > flattenSlot(slots)) {
          outcome.pnl.unresolved++
          return
        }
        outcome.pnl = {
          ...empty(),
          ...closedLeg(fill.side, fill.quantity, fill.entry, fill.exit),
          roundTrips: 1,
          heldGaps: fill.missingHeld,
          lastExit: fill.exitSlot,
        }
      },
    })
    outcome.pnl.unresolved += ledger.unresolved
    outcome.pnl.missingEntries = ledger.missingEntries
    return { symbol, ...outcome }
  })

export const confirms = (
  confirmation: NoiseConfirmation,
  decision: NoiseOutcome['decision'],
  bars: readonly (Bar | undefined)[],
  features: ReturnType<typeof sessionFeatures>,
) => {
  // The control has no observed decision to condition for an unresolved path or missing entry.
  // Preserve that diagnostic rather than silently turning unproved execution into a proven flat day.
  if (confirmation === NoiseConfirmation.None || decision === undefined) return true
  const { slot, side } = decision
  const close = bars[slot]?.close
  if (close === undefined) throw new Error('Noise Area decision has no observed close')
  if (confirmation === NoiseConfirmation.Vwap) {
    const vwap = features.vwap[slot]
    return vwap !== undefined && side * (close - vwap) > 0
  }
  const { range } = features
  return range !== undefined && (side === 1 ? close > range.high : close < range.low)
}

const canTrade = (gate: Volatility, label: Volatility | undefined) => gate === Volatility.Any || gate === label

const verifyB0 = (rows: readonly Pnl[]) => {
  // Full source window, including the calibration months. Wave 6A's retained fixed-capital reference.
  const expectedUsd = [103_533.58, 69_780.16]
  const observedUsd = [2, 5].map((bp) => {
    if (rows.some(({ unresolved }) => unresolved !== 0)) throw new Error('B0 has an unproved timely exit')
    return sum(rows.map(({ base, slope }) => base - bp * slope))
  })
  if (observedUsd.some((value, i) => Math.round(100 * value) !== Math.round(100 * expectedUsd[i])))
    throw new Error('B0 does not reproduce Wave 6A to the cent')
  return { costsBp: [2, 5], expectedUsd, observedUsd }
}

const replay = (days: readonly Day[]) => {
  requireAlignedSessions(days)
  const dates = days.map(({ date }) => date)
  const market = new Map(
    symbols.map((symbol) => {
      const features = days.map(({ bars, slots }) => sessionFeatures(bars.get(symbol) ?? [], slots))
      return [
        symbol,
        {
          features,
          volatility: walkForwardVolatility(
            dates,
            features.map(({ variance }) => variance),
          ),
        },
      ]
    }),
  )
  const tapes = new Map(trials.map(({ id }) => [id, [] as Pnl[]]))
  const rowsOf = (id: string) => {
    const rows = tapes.get(id)
    if (rows === undefined) throw new Error(`Unknown registered book: ${id}`)
    return rows
  }
  const folds = Array.from({ length: endYear - startYear + 1 }, (_, offset) => {
    const year = startYear + offset
    const members = dates.filter((date) => foldYear(date) === year)
    const { first, end } = foldBounds(dates, members[0], members.at(-1) ?? '')
    return {
      yearEnding: year,
      first,
      end,
      start: dates[first],
      through: dates[end - 1],
      sessions: end - first,
      calibratedThrough: dates[first - 1],
      cutoffs: Object.fromEntries(
        symbols.map((symbol) => {
          const cutoff = market.get(symbol)?.volatility.cutoffs.get(year)
          if (cutoff === undefined || cutoff.median === null)
            throw new Error(`No prior volatility calibration for ${symbol} in fold ${year}`)
          return [symbol, cutoff]
        }),
      ),
    }
  })
  const first = folds[0].first
  if (dates[first - 1] !== oos.fromExclusive || dates.at(-1) !== oos.throughInclusive)
    throw new Error('Calendar does not bound the registered ten-year OOS window')
  const b0Rows: Pnl[] = []
  let i = -1
  for (const day of prepare(days, symbols)) {
    i++
    const noiseReplay = createReplay(day)
    const paths = new Map(
      noiseControls
        .filter(({ id }) => id === 'B0' || i >= first)
        .map(({ id, symbols: members }) => [id, noiseOutcomes(noiseReplay, day.slots, members)]),
    )
    const b0Day = paths.get('B0')?.reduce((row, { pnl }) => add(row, pnl), empty())
    if (b0Day === undefined) throw new Error('B0 control path is absent')
    b0Rows.push(b0Day)
    if (i < first) continue
    const studyDay = days[i]
    const point = (symbol: StudySymbol) => {
      const tape = market.get(symbol)
      if (tape === undefined) throw new Error(`Missing market features: ${symbol}`)
      return { bars: studyDay.bars.get(symbol) ?? [], features: tape.features[i], label: tape.volatility.labels[i] }
    }
    for (const trial of noiseTrials) {
      const outcomes = paths.get(trial.control)
      if (outcomes === undefined) throw new Error(`Missing control path: ${trial.control}`)
      const row = outcomes.reduce((total, outcome) => {
        const { bars, features, label } = point(outcome.symbol)
        return canTrade(trial.volatility, label) && confirms(trial.confirmation, outcome.decision, bars, features)
          ? add(total, outcome.pnl)
          : total
      }, empty())
      rowsOf(trial.id).push(row)
    }
    for (const trial of reversionTrials) {
      const row = symbols.reduce((total, symbol) => {
        const { bars, features, label } = point(symbol)
        return canTrade(trial.volatility, label)
          ? add(total, replayReversion(bars, day.slots, features, trial.openingRange))
          : total
      }, empty())
      rowsOf(trial.id).push(row)
    }
    for (const { id, sleeve } of blendTrials)
      rowsOf(id).push(add(add(empty(), b0Day, 0.5), rowsOf(sleeve)[i - first], 0.5))
  }
  return { folds, dates: dates.slice(first), rowsOf, parity: verifyB0(b0Rows) }
}

const returnsAt = (rows: readonly Pnl[], bp: number) =>
  rows.some(({ unresolved }) => unresolved > 0) ? null : rows.map(({ base, slope }) => (base - bp * slope) / capital)

export const breakEvenSlippage = (pnl: Pnl) => (pnl.unresolved === 0 && pnl.slope > 0 ? pnl.base / pnl.slope : null)

const riskMetrics = (returns: readonly number[] | null) => ({
  netReturn: returns === null ? null : sum(returns),
  sharpe: returns === null ? null : sharpe(returns),
  maxDrawdown: returns === null ? null : maxDrawdown(returns, false),
})

const improvesRisk = (a: ReturnType<typeof riskMetrics>, b: ReturnType<typeof riskMetrics>) =>
  a.sharpe !== null &&
  b.sharpe !== null &&
  a.sharpe > b.sharpe &&
  a.maxDrawdown !== null &&
  b.maxDrawdown !== null &&
  a.maxDrawdown < b.maxDrawdown

const exitClock = (slot: number) => {
  if (slot < 0) return null
  const minute = 9 * 60 + 30 + slot * 5
  return `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`
}

const score = (days: readonly Day[]) => {
  const { dates, folds, rowsOf, parity } = replay(days)
  const first = folds[0].first
  const schedule = stationaryBootstrap(dates.length, bootstrap)
  const benchmark = costs.map((bp) => returnsAt(rowsOf('B0'), bp))
  const paths = trials.map((trial) => {
    const rows = rowsOf(trial.id)
    if (rows.length !== dates.length) throw new Error(`Unaligned ledger: ${trial.id}`)
    return { trial, rows, returns: costs.map((bp) => returnsAt(rows, bp)) }
  })
  const finiteTrials = paths
    .filter(({ trial }) => trial.kind !== BookKind.Control)
    .flatMap(({ returns }) =>
      returns.flatMap((values) => {
        const value = values === null ? null : dailySharpe(values)
        return value === null ? [] : [value]
      }),
    )
  const hurdle = expectedMaximumSharpe(finiteTrials, trialCount)
  const books = paths.map(({ trial, rows, returns }) => {
    const total = rows.reduce((value, row) => add(value, row), empty())
    return {
      ...trial,
      execution: {
        roundTrips: total.roundTrips,
        missingEntries: total.missingEntries,
        heldGaps: total.heldGaps,
        unresolved: total.unresolved,
        unresolvedDates: dates.filter((_, i) => rows[i].unresolved > 0),
        lastObservedExitEt: exitClock(total.lastExit),
      },
      breakEvenSlippageBp: breakEvenSlippage(total),
      ledgerSha256: sha256(JSON.stringify(rows)),
      costs: costs.map((bp, i) => {
        const values = returns[i]
        const b = benchmark[i]
        const paired = values !== null && b !== null
        return {
          bp,
          ...riskMetrics(values),
          correlationVsB0: paired ? correlation(values, b).r : null,
          sharpeDeltaVsB0: paired ? pairedSharpeDiff(values, b) : null,
          bootstrapPositiveMeanP: values === null ? null : stationaryMeanP(values, schedule),
          bootstrapMeanAboveB0P: paired
            ? stationaryMeanP(
                values.map((v, j) => v - b[j]),
                schedule,
              )
            : null,
          deflatedSharpe: values === null ? null : deflatedSharpe(values, hurdle),
        }
      }),
      yearly: folds.map(({ yearEnding, first: from, end }) => ({
        yearEnding,
        costs: costs.map((bp) => ({ bp, ...riskMetrics(returnsAt(rows.slice(from - first, end - first), bp)) })),
      })),
    }
  })
  const find = (id: string) => {
    const book = books.find((entry) => entry.id === id)
    if (book === undefined) throw new Error(`Missing scored book: ${id}`)
    return book
  }
  const baseScore = find('B0')
  const five = (book: (typeof books)[number]) => book.costs[primaryCostIndex]
  const safe = ({ execution }: (typeof books)[number]) => execution.unresolved === 0 && execution.heldGaps === 0
  const gates = books.flatMap((book) => {
    if (book.kind === BookKind.Control || book.kind === BookKind.Blend) return []
    const primary = five(book)
    const checks = {
      execution: safe(book) && safe(baseScore),
      positiveAt10Bp: (book.costs[3].netReturn ?? -Infinity) > 0,
      positiveYearsAt5Bp: book.yearly.filter(
        ({ costs: yearly }) => (yearly[primaryCostIndex].netReturn ?? -Infinity) > 0,
      ).length,
      inferenceAt5Bp:
        (primary.netReturn ?? -Infinity) > 0 &&
        (primary.bootstrapPositiveMeanP ?? 1) < 0.05 &&
        (primary.deflatedSharpe ?? 0) >= 0.95,
      riskAt5Bp:
        book.kind === BookKind.Replacement && 'control' in book
          ? improvesRisk(primary, five(baseScore)) && improvesRisk(primary, five(find(book.control)))
          : safe(find(`B0+${book.id}`)) &&
            Math.abs(primary.correlationVsB0 ?? Infinity) < 0.3 &&
            improvesRisk(five(find(`B0+${book.id}`)), five(baseScore)),
    }
    return [
      {
        id: book.id,
        ...checks,
        qualified:
          checks.execution &&
          checks.positiveAt10Bp &&
          checks.positiveYearsAt5Bp >= 7 &&
          checks.inferenceAt5Bp &&
          checks.riskAt5Bp,
      },
    ]
  })
  return {
    schema: 'bayn.research.wave-19s.results.v1',
    verdict: gates.some(({ qualified }) => qualified) ? 'PROMOTE' : 'DO NOT PROMOTE',
    oos: { ...oos, sessions: dates.length, datesSha256: sha256(JSON.stringify(dates)) },
    symbols,
    startCapital: capital,
    b0Parity: parity,
    protocol: {
      b0,
      openingMinutes: openingSlots * 5,
      deviationWidth,
      rvLookback,
      maxHoldMinutes: maxHoldSlots * 5,
      bootstrap,
    },
    inference: {
      registeredTrials: trialCount,
      finiteSharpeTrials: finiteTrials.length,
      expectedMaximumDailySharpe: hurdle,
    },
    folds,
    books,
    gates,
  }
}

enum Argument {
  Output = '--output',
}
const decodeArgs = Schema.decodeUnknownSync(Schema.Tuple([Schema.Enum(Argument), Schema.NonEmptyString]))
class StudyError extends Data.TaggedError('VwapRegimeStudyError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

const program = Effect.gen(function* () {
  const [, output] = yield* Effect.try({
    try: () => decodeArgs(process.argv.slice(2)),
    catch: (cause) =>
      new StudyError({
        message: 'Usage: research-10yr-intraday-vwap-regime.ts --output <new JSON file>',
        cause: Redacted.make(cause),
      }),
  })
  yield* withArchive(async (archive) => {
    const development = await loadDevelopment(archive)
    const holdout = await loadHoldout(archive)
    const inputs = { development: sources.development, holdout: sources.holdout }
    const cover = ({ coverage }: typeof development) => {
      const selected = symbols.map((symbol) => [symbol, coverage.counts[symbol]] as const)
      if (selected.some(([, counts]) => counts.emptySessions.length !== 0))
        throw new Error('An enrolled ETF is missing a complete official session')
      return { ...coverage, counts: Object.fromEntries(selected) }
    }
    const coverage = { development: cover(development), holdout: cover(holdout) }
    const results = score([...development.days, ...holdout.days])
    return { ...results, inputs, coverage }
  }).pipe(
    Effect.timeout('10 minutes'),
    Effect.flatMap((results) =>
      Effect.tryPromise({
        try: (signal) => writeFile(output, JSON.stringify(results, null, 2) + '\n', { flag: 'wx', signal }),
        catch: (cause) =>
          new StudyError({ message: 'Unable to write a new study receipt', cause: Redacted.make(cause) }),
      }),
    ),
  )
})

if (import.meta.main) NodeRuntime.runMain(program)
