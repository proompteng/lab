import { quantile } from './midday-research-statistics'
import { baskets, createReplay, grid, prepare, type Bar, type Day } from './noise-area-study-replay'
import { correlation } from './noise-area-study-statistics'
import { foldBounds, requireAlignedSessions } from './research-lib/calendar'
import {
  dailySharpe,
  maxDrawdown,
  sharpe,
  stationaryBootstrap,
  stationaryMeanP,
  sum,
  type StationaryPlan,
} from './research-lib/statistics'

export enum Etf {
  QQQ = 'QQQ',
  SPY = 'SPY',
  IWM = 'IWM',
  SMH = 'SMH',
  XLK = 'XLK',
  XLF = 'XLF',
  XLE = 'XLE',
  XLI = 'XLI',
}

export const etfs = Object.values(Etf)
const widths = [15, 30] as const
type Width = (typeof widths)[number]
const variants = widths.flatMap((width) => [true, false].map((gated) => ({ width, gated })))
type Variant = (typeof variants)[number]

export const barMinutes = 5
const referenceSessions = 20
const maxOpeningRvRatio = 0.8
const minOpeningRvol = 1.25
const lastSignalMinute = 115
const capital = 100_000
const costs = [0, 2, 5, 10] as const
const primaryCost = 5
const orbWeight = 0.2
const minimumActiveDays = 30
const maxAbsoluteCorrelation = 0.3
const alpha = 0.025
const bootstrap = { draws: 10_000, meanBlock: 5, seed: 0x23d20261 }
const baselineId = 'B0/30/1.4/opposite_band/inverse_vol_parity'
export const firstDate = '2024-01-02'
export const lastDate = '2026-11-25'
const folds = [
  { trainThrough: '2024-12-31', trainSessions: 252, from: '2025-01-02', through: '2025-12-31', sessions: 250 },
  { trainThrough: '2025-12-31', trainSessions: 502, from: '2026-01-02', through: lastDate, sessions: 227 },
] as const
export const expectedSessions = folds[1].trainSessions + folds[1].sessions

type Bars = readonly (Bar | undefined)[]

export const openingRange = (bars: Bars, width: Width) => {
  let high = -Infinity
  let low = Infinity
  let variance = 0
  let volume = 0
  let previousClose = bars[0]?.open
  for (let slot = 0; slot < width / barMinutes; slot++) {
    const bar = bars[slot]
    if (bar === undefined || previousClose === undefined) return undefined
    high = Math.max(high, bar.high)
    low = Math.min(low, bar.low)
    variance += Math.log(bar.close / previousClose) ** 2
    volume += bar.volume
    previousClose = bar.close
  }
  return { high, low, realizedVol: Math.sqrt(variance), volume }
}
type Opening = ReturnType<typeof openingRange>
type OpeningReference = Pick<NonNullable<Opening>, 'realizedVol' | 'volume'> | undefined

export enum Cash {
  OpeningUnavailable = 'openingUnavailable',
  ReferenceUnavailable = 'referenceUnavailable',
  VolatilityGate = 'volatilityGate',
  RvolGate = 'rvolGate',
  SignalUnavailable = 'signalUnavailable',
  NoBreakout = 'noBreakout',
  NoWholeShare = 'noWholeShare',
}

interface Order {
  readonly signalSlot: number
  readonly side: 1 | -1
  readonly quantity: number
}

export const planEntry = (
  bars: Bars,
  opening: Opening,
  prior: readonly OpeningReference[],
  { width, gated }: Variant,
): Order | Cash => {
  if (opening === undefined) return Cash.OpeningUnavailable
  if (gated) {
    const observed = prior.filter((value) => value !== undefined)
    if (observed.length !== referenceSessions || observed.length !== prior.length) return Cash.ReferenceUnavailable
    const typicalVol = quantile(
      observed.map(({ realizedVol }) => realizedVol),
      0.5,
    )
    const typicalVolume = quantile(
      observed.map(({ volume }) => volume),
      0.5,
    )
    if (typicalVol === null || typicalVol <= 0 || typicalVolume === null || typicalVolume <= 0)
      return Cash.ReferenceUnavailable
    if (opening.realizedVol > maxOpeningRvRatio * typicalVol) return Cash.VolatilityGate
    if (opening.volume < minOpeningRvol * typicalVolume) return Cash.RvolGate
  }
  for (let slot = width / barMinutes; slot < lastSignalMinute / barMinutes; slot++) {
    const bar = bars[slot]
    if (bar === undefined) return Cash.SignalUnavailable
    const side = bar.close > opening.high ? 1 : bar.close < opening.low ? -1 : 0
    if (side !== 0) {
      const quantity = Math.floor(capital / etfs.length / bar.close)
      return quantity > 0 ? { signalSlot: slot, side, quantity } : Cash.NoWholeShare
    }
  }
  return Cash.NoBreakout
}

export enum FillGap {
  Entry = 'missingEntry',
  Exit = 'missingExit',
}

interface RoundTrip {
  readonly entry: number
  readonly exit: number
  readonly entrySlot: number
  readonly exitSlot: number
  readonly side: Order['side']
  readonly quantity: number
  readonly missingHeld: number
}

export const fillOrder = (order: Order, bars: Bars, slots: number, extraBars: 0 | 1): RoundTrip | FillGap => {
  const entrySlot = order.signalSlot + 1 + extraBars
  const exitSlot = slots - 1
  if (entrySlot >= exitSlot) throw new Error('ORB entry must precede the same-session flatten')
  const entry = bars[entrySlot]?.open
  if (entry === undefined) return FillGap.Entry
  const exit = bars[exitSlot]?.open
  if (exit === undefined) return FillGap.Exit
  let missingHeld = 0
  for (let slot = entrySlot + 1; slot < exitSlot; slot++) if (bars[slot] === undefined) missingHeld++
  return { ...order, entry, exit, entrySlot, exitSlot, missingHeld }
}

const bookDay = (
  date: string,
  fills: readonly RoundTrip[],
  missingEntries: number,
  missingExits: number,
  ambiguousHeldBars = 0,
) => ({
  date,
  missingEntries,
  missingExits,
  ambiguousHeldBars,
  longRoundTrips: fills.filter(({ side }) => side === 1).length,
  shortRoundTrips: fills.filter(({ side }) => side === -1).length,
  heldGapBars: sum(fills.map(({ missingHeld }) => missingHeld)),
  grossUsd: sum(fills.map(({ side, quantity, entry, exit }) => side * quantity * (exit - entry))),
  entryNotionalUsd: sum(fills.map(({ quantity, entry }) => quantity * entry)),
  turnoverUsd: sum(fills.map(({ quantity, entry, exit }) => quantity * (entry + exit))),
  latestExitSlot: fills.length === 0 ? null : Math.max(...fills.map(({ exitSlot }) => exitSlot)),
})
type BookDay = ReturnType<typeof bookDay>

const aggregateOrbDay = (date: string, fills: readonly (RoundTrip | FillGap)[]) =>
  bookDay(
    date,
    fills.filter((fill) => typeof fill !== 'string'),
    fills.filter((fill) => fill === FillGap.Entry).length,
    fills.filter((fill) => fill === FillGap.Exit).length,
  )

export const replayOrb = (days: readonly Day[], variant: Variant) => {
  const openings = days.map(
    ({ bars }) => new Map(etfs.map((etf) => [etf, openingRange(bars.get(etf) ?? [], variant.width)])),
  )
  return days.map(({ date, bars, slots }, index) => {
    const prior = openings.slice(Math.max(0, index - referenceSessions), index)
    const cash: Cash[] = []
    const base: (RoundTrip | FillGap)[] = []
    const delayed: (RoundTrip | FillGap)[] = []
    for (const etf of etfs) {
      const series = bars.get(etf) ?? []
      const order = planEntry(
        series,
        openings[index].get(etf),
        prior.map((day) => day.get(etf)),
        variant,
      )
      if (typeof order === 'string') cash.push(order)
      else {
        base.push(fillOrder(order, series, slots, 0))
        delayed.push(fillOrder(order, series, slots, 1))
      }
    }
    return { date, cash, nextOpen: aggregateOrbDay(date, base), delayedEntry: aggregateOrbDay(date, delayed) }
  })
}
type OrbDay = ReturnType<typeof replayOrb>[number]

const replayBaseline = (days: readonly Day[]) => {
  const spec = grid.find(({ id }) => id === baselineId)
  if (spec === undefined) throw new Error('Registered B0 control is unavailable')
  return Array.from(prepare(days, baskets.B0), (day) => {
    const fills: RoundTrip[] = []
    const ledger = createReplay(day)(spec, baskets.B0, undefined, {
      budget: capital,
      onFill: (fill) => {
        if (fill.exitSlot <= fill.entrySlot || fill.exitSlot >= day.slots)
          throw new Error('B0 violated the same-session flatten')
        fills.push(fill)
      },
    })
    if (fills.length !== ledger.trades) throw new Error('B0 fill count did not reconcile')
    return bookDay(day.date, fills, ledger.missingEntries, ledger.unresolved, ledger.missingHeld)
  })
}

const unresolved = (day: BookDay) => day.missingEntries > 0 || day.missingExits > 0 || day.ambiguousHeldBars > 0

// Half the round-trip penalty is applied adversely to each raw fill, for either side.
const dailyNet = (rows: readonly BookDay[], bp: number) =>
  rows.some(unresolved) ? null : rows.map((day) => (day.grossUsd - (bp * day.turnoverUsd) / 20_000) / capital)

const execution = (rows: readonly BookDay[]) => {
  const unresolvedDays = rows.filter(unresolved).map(({ date, missingEntries, missingExits, ambiguousHeldBars }) => ({
    date,
    missingEntries,
    missingExits,
    ambiguousHeldBars,
  }))
  const longRoundTrips = sum(rows.map((row) => row.longRoundTrips))
  const shortRoundTrips = sum(rows.map((row) => row.shortRoundTrips))
  const turnoverUsd = sum(rows.map((row) => row.turnoverUsd))
  const latestSlot = Math.max(...rows.map(({ latestExitSlot }) => latestExitSlot ?? -1))
  const flatMinute = 9 * 60 + 30 + latestSlot * barMinutes
  return {
    activeDays: rows.filter((row) => row.longRoundTrips + row.shortRoundTrips > 0).length,
    confirmedRoundTrips: longRoundTrips + shortRoundTrips,
    longRoundTrips,
    shortRoundTrips,
    confirmedEntryFills: longRoundTrips + shortRoundTrips + sum(rows.map(({ missingExits }) => missingExits)),
    confirmedExitFills: longRoundTrips + shortRoundTrips,
    unresolvedDays,
    heldGapBarsOnConfirmedTrips: sum(rows.map(({ heldGapBars }) => heldGapBars)),
    latestConfirmedExitEt:
      latestSlot < 0 ? null : `${Math.floor(flatMinute / 60)}:${String(flatMinute % 60).padStart(2, '0')}`,
    maxClosedEntryNotionalUsdPerDay: Math.max(...rows.map((row) => row.entryNotionalUsd)),
    confirmedRawTurnoverUsd: turnoverUsd,
    turnoverCapital: unresolvedDays.length === 0 ? turnoverUsd / capital : null,
    breakEvenRoundTripBps:
      unresolvedDays.length === 0 && turnoverUsd > 0
        ? (sum(rows.map((row) => row.grossUsd)) * 20_000) / turnoverUsd
        : null,
  }
}

const compare = (values: readonly number[], b0: readonly number[], plan: StationaryPlan | undefined) => {
  const blended = values.map((value, i) => orbWeight * value + (1 - orbWeight) * b0[i])
  const lift = values.map((value, i) => orbWeight * (value - b0[i]))
  const blendedSharpe = sharpe(blended)
  const b0Sharpe = sharpe(b0)
  return {
    correlation: correlation(values, b0).r,
    blendedNetUsd: sum(blended) * capital,
    blendedSharpe,
    blendedMaxDrawdown: maxDrawdown(blended, false),
    netLiftUsd: sum(lift) * capital,
    sharpeLift: blendedSharpe === null || b0Sharpe === null ? null : blendedSharpe - b0Sharpe,
    netLiftP: plan === undefined ? null : stationaryMeanP(lift, plan),
  }
}

export const scoreBook = (rows: readonly BookDay[], plan: StationaryPlan, baseline?: readonly BookDay[]) => {
  if (baseline !== undefined) requireAlignedSessions(rows, baseline)
  return {
    execution: execution(rows),
    costs: costs.map((bp) => {
      const values = dailyNet(rows, bp)
      const b0 = baseline === undefined ? null : dailyNet(baseline, bp)
      const inference = bp === primaryCost ? plan : undefined
      return {
        bp,
        netUsd: values === null ? null : sum(values) * capital,
        sharpe: values === null ? null : sharpe(values),
        maxDrawdown: values === null ? null : maxDrawdown(values, false),
        positiveMeanP: values === null || inference === undefined ? null : stationaryMeanP(values, inference),
        versusB0: values === null || b0 === null ? null : compare(values, b0, inference),
      }
    }),
  }
}

const scoreOrb = (days: readonly OrbDay[], plan: StationaryPlan, b0: readonly BookDay[]) => {
  const skips = new Map(Object.values(Cash).map((reason) => [reason, 0]))
  for (const day of days) for (const reason of day.cash) skips.set(reason, (skips.get(reason) ?? 0) + 1)
  return {
    skippedSymbolDays: Object.fromEntries(skips),
    nextOpen: scoreBook(
      days.map(({ nextOpen }) => nextOpen),
      plan,
      b0,
    ),
    delayedEntry: scoreBook(
      days.map(({ delayedEntry }) => delayedEntry),
      plan,
      b0,
    ),
  }
}
type OrbScore = ReturnType<typeof scoreOrb>

type TrialPath = Variant & { readonly days: readonly OrbDay[] }

export const fitWidth = (paths: readonly TrialPath[], train: ReturnType<typeof foldBounds>) => {
  const training = paths
    .filter(({ gated }) => gated)
    .map(({ width, days }) => {
      const values = dailyNet(
        days.slice(train.first, train.end).map(({ nextOpen }) => nextOpen),
        primaryCost,
      )
      return { width, dailySharpe: values === null ? null : dailySharpe(values) }
    })
  let best: { width: Width; sharpe: number } | undefined
  for (const { width, dailySharpe: score } of training) {
    if (score !== null && (best === undefined || score > best.sharpe || (score === best.sharpe && width < best.width)))
      best = { width, sharpe: score }
  }
  return { training, selectedWidth: best?.width ?? null }
}

export enum Verdict {
  Promote = 'PROMOTE',
  DoNotPromote = 'DO NOT PROMOTE',
}

const positive = (value: number | null | undefined) => value !== null && value !== undefined && value > 0
const significant = (p: number | null | undefined) => p !== null && p !== undefined && p < alpha
const atPrimary = (book: ReturnType<typeof scoreBook> | undefined) => book?.costs.find(({ bp }) => bp === primaryCost)

const promotion = (
  byFold: readonly (OrbScore | null)[],
  selected: OrbScore | null,
  b0: ReturnType<typeof scoreBook>,
) => {
  const next = atPrimary(selected?.nextOpen)
  const delay = atPrimary(selected?.delayedEntry)
  const r = next?.versusB0?.correlation
  const complete =
    selected !== null &&
    [selected.nextOpen, selected.delayedEntry, b0].every((book) => book.execution.unresolvedDays.length === 0)
  const enoughActivity = (selected?.nextOpen.execution.activeDays ?? 0) >= minimumActiveDays
  const positiveFolds = (kind: 'standalone' | 'blend') =>
    byFold.every(
      (fold) =>
        fold !== null &&
        fold.nextOpen.costs
          .filter(({ bp }) => bp >= primaryCost)
          .every((cost) => positive(kind === 'standalone' ? cost.netUsd : cost.versusB0?.netLiftUsd)),
    )
  const standalone = {
    positiveAt5And10InBothFolds: positiveFolds('standalone'),
    significantPooledMean: significant(next?.positiveMeanP),
    delayedNetPositive: positive(delay?.netUsd),
  }
  const alongsideB0 = {
    positiveLiftAt5And10InBothFolds: positiveFolds('blend'),
    lowAbsoluteCorrelation: r !== undefined && r !== null && Math.abs(r) <= maxAbsoluteCorrelation,
    positiveSharpeLift: positive(next?.versusB0?.sharpeLift),
    significantPairedLift: significant(next?.versusB0?.netLiftP),
    delayedLiftPositive: positive(delay?.versusB0?.netLiftUsd),
  }
  const passed =
    complete && enoughActivity && [standalone, alongsideB0].some((gate) => Object.values(gate).every(Boolean))
  return {
    verdict: passed ? Verdict.Promote : Verdict.DoNotPromote,
    gates: { complete, enoughActivity, standalone, alongsideB0 },
  }
}

export const evaluateStudy = (days: readonly Day[]) => {
  requireAlignedSessions(days)
  const dates = days.map(({ date }) => date)
  const baseline = replayBaseline(days)
  const paths = variants.map((variant) => ({ ...variant, days: replayOrb(days, variant) }))
  const cuts = folds.map((fold) => {
    const train = foldBounds(dates, firstDate, fold.trainThrough, fold.trainSessions)
    const test = foldBounds(dates, fold.from, fold.through, fold.sessions)
    if (train.end !== test.first) throw new Error('Walk-forward training must end before the first scored session')
    return { fold, ...fitWidth(paths, train), ...test }
  })
  const outOfSample = cuts.map(({ fold, training, selectedWidth, first, end }) => {
    const b0 = baseline.slice(first, end)
    const plan = stationaryBootstrap(b0.length, bootstrap)
    return {
      ...fold,
      training,
      selectedWidth,
      b0: scoreBook(b0, plan),
      variants: paths.map(({ width, gated, days: rows }) => ({
        width,
        gated,
        ...scoreOrb(rows.slice(first, end), plan, b0),
      })),
    }
  })
  const b0 = cuts.flatMap(({ first, end }) => baseline.slice(first, end))
  const chosen = cuts.map(({ first, end, selectedWidth }) =>
    paths.find(({ gated, width }) => gated && width === selectedWidth)?.days.slice(first, end),
  )
  const plan = stationaryBootstrap(b0.length, bootstrap)
  const pooled = {
    from: b0[0].date,
    through: b0[b0.length - 1].date,
    sessions: b0.length,
    b0: scoreBook(b0, plan),
    selected: chosen.some((path) => path === undefined)
      ? null
      : scoreOrb(
          chosen.flatMap((path) => path ?? []),
          plan,
          b0,
        ),
    variants: paths.map(({ width, gated, days: rows }) => ({
      width,
      gated,
      ...scoreOrb(
        cuts.flatMap(({ first, end }) => rows.slice(first, end)),
        plan,
        b0,
      ),
    })),
  }
  const byFold = outOfSample.map(
    (score) => score.variants.find(({ width, gated }) => gated && width === score.selectedWidth) ?? null,
  )
  return {
    protocol: {
      firstDate,
      lastDate,
      capital,
      etfs,
      barMinutes,
      widths,
      referenceSessions,
      maxOpeningRvRatio,
      minOpeningRvol,
      lastSignalMinute,
      costs,
      primaryCost,
      bootstrap,
      baselineId,
      orbWeight,
      minimumActiveDays,
      maxAbsoluteCorrelation,
      alpha,
    },
    outOfSample,
    pooled,
    ...promotion(byFold, pooled.selected, pooled.b0),
  }
}
