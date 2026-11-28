import { type Day, Field, price } from './8yr-unseen-intraday-tape'
import { riskParity } from './etf-canary-macro-signals'
import { budgetedShares, cap, capital, checkpoints, closedLeg, markedGrossBound } from './noise-area-study-replay'
import { mean, sum } from './research-lib/statistics'
import type { DailyFrame } from './research/macro-etf-core-dual-horizon-data'

export const core = ['QQQ', 'SMH', 'XLK', 'IWM'] as const
export const sectors = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB'] as const
const additionalSectors = sectors.filter((symbol) => symbol !== 'XLK')
export const symbols = [...core, 'SPY', ...additionalSectors] as const
export type Etf = (typeof symbols)[number]
export const costs = [0, 2.5, 5, 10] as const
export const primaryCost = 5
export const lookback = 14
export const warmup = 60
const liquidityMinSessions = 55
const noiseBand = 1.4
const volFloor = 0.001
const covarianceShrink = 0.5
const participation = 0.01
const worstSlip = 1 + Math.max(...costs) / 20_000
export { cap, capital }

export enum Weighting {
  InverseVol = 'inverse-vol',
  EqualRisk = 'equal-risk',
}

const rungs = [
  { id: 'B0', fixed: core.slice(0, 2), top: 0 },
  { id: 'B0+XLK', fixed: core.slice(0, 3), top: 0 },
  { id: 'B0+XLK+IWM', fixed: core, top: 0 },
  { id: 'B0+Top3', fixed: core, top: 3 },
  { id: 'B0+Top6', fixed: core, top: 6 },
  { id: 'All13', fixed: symbols, top: 0 },
] as const
export const noiseTrials = rungs.flatMap(({ id, fixed, top }, i) =>
  // For two positive weights, equal contributions solve w1² σ1² = w2² σ2² regardless of covariance.
  (i === 0 ? [Weighting.InverseVol] : Object.values(Weighting)).map((weighting) => ({
    id: `A/${id}/${weighting}`,
    priorId: i === 0 ? null : `A/${rungs[i - 1].id}/${i === 1 ? Weighting.InverseVol : weighting}`,
    fixed,
    top,
    weighting,
  })),
)
export type NoiseTrial = (typeof noiseTrials)[number]
export const baselineId = 'A/B0/inverse-vol'

export enum Direction {
  Fade = 'fade',
  Continuation = 'continuation',
}

export enum GapBook {
  DollarNeutral = 'dollar-neutral',
  LongOnly = 'long-only',
}

export enum GapSize {
  Medium = '0.25-to-0.75-ATR',
  Large = '0.75-ATR-plus',
}

export enum CloseLocation {
  Aligned = 'aligned',
  Opposed = 'opposed',
}

export const gapTrials = ([30, 60] as const).flatMap((minutes) =>
  Object.values(Direction).flatMap((direction) =>
    Object.values(GapBook).flatMap((book) =>
      Object.values(GapSize).flatMap((size) =>
        Object.values(CloseLocation).map((location) => ({
          id: `B/${minutes}m/${direction}/${book}/${size}/${location}`,
          minutes,
          direction,
          book,
          size,
          location,
        })),
      ),
    ),
  ),
)
export type GapTrial = (typeof gapTrials)[number]

export const flattenSlot = (slots: number) => slots - 2
const at = (series: Float64Array | undefined, slot: number, field: Field) =>
  series === undefined ? 0 : price(series, slot, field)

const observed = (values: readonly number[]) => values.every((value) => value > 0)

export const riskWeights = (history: readonly (readonly number[])[], weighting: Weighting) => {
  const centered = history.map((returns) => {
    const center = mean(returns)
    return returns.map((value) => value - center)
  })
  const covariance = centered.map((a, i) =>
    centered.map((b, j) => {
      const raw = sum(a.map((value, t) => value * b[t])) / (a.length - 1)
      return i === j ? Math.max(volFloor ** 2, raw) : raw * covarianceShrink
    }),
  )
  if (weighting === Weighting.EqualRisk) return riskParity(covariance)
  const inverse = covariance.map((row, i) => 1 / Math.sqrt(row[i]))
  const total = sum(inverse)
  return inverse.map((value) => value / total)
}

export const annualLiquidity = (days: readonly Day[]) => {
  const elections = new Map<string, { asOf: string; ranked: readonly Etf[] | null }>()
  for (let i = warmup; i < days.length; i++) {
    const year = days[i].date.slice(0, 4)
    if (elections.has(year)) continue
    const history = days.slice(i - warmup, i)
    const scores = additionalSectors.map((symbol) => {
      const complete: number[] = []
      for (const { bars, slots } of history) {
        const series = bars.get(symbol)
        let dollars = 0
        for (let slot = 0; slot < slots; slot++) {
          const notional = at(series, slot, Field.Vwap) * at(series, slot, Field.Volume)
          if (notional === 0) break
          dollars += notional
          if (slot === slots - 1) complete.push(dollars)
        }
      }
      return { symbol, adv: complete.length < liquidityMinSessions ? null : mean(complete) }
    })
    const ranked = scores.every(({ adv }) => adv !== null)
      ? scores
          .toSorted((a, b) => Number(b.adv) - Number(a.adv) || a.symbol.localeCompare(b.symbol, 'en'))
          .map(({ symbol }) => symbol)
      : null
    elections.set(year, { asOf: history[history.length - 1].date, ranked })
  }
  return elections
}

type Side = 1 | -1
interface Order {
  readonly series: Float64Array
  readonly side: Side
  readonly reference: number
  readonly entry: number
  readonly exit: number | null
  readonly deadline: number
}

interface Signal {
  readonly order?: Order
  readonly missing: number
  readonly missingEntry?: true
}

/** Wave 6A B0 checkpoint and band semantics, with a hard latest permissible exit open. */
export const noiseOrder = (days: readonly Day[], index: number, symbol: Etf): Signal => {
  const day = days[index]
  const series = day.bars.get(symbol)
  const open = at(series, 0, Field.Open)
  const prior = days[index - 1]
  const close = at(prior.bars.get(symbol), prior.slots - 1, Field.Close)
  if (series === undefined || !observed([open, close])) return { missing: 1 }

  const decisions = checkpoints(day.slots, 30)
  const upper = Math.max(open, close)
  const lower = Math.min(open, close)
  const deadline = flattenSlot(day.slots)
  let missing = 0
  const direction = (slot: number) => {
    const current = price(series, slot, Field.Close)
    if (current === 0) {
      missing++
      return 0
    }
    const moves: number[] = []
    for (let j = index - 1; j >= 0 && moves.length < lookback; j--) {
      const previous = days[j]
      if (previous.slots <= slot) continue
      const tape = previous.bars.get(symbol)
      const from = at(tape, 0, Field.Open)
      const to = at(tape, slot, Field.Close)
      if (!observed([from, to])) {
        missing++
        return 0
      }
      moves.push(Math.abs(to / from - 1))
    }
    if (moves.length < lookback) return 0
    const band = noiseBand * mean(moves)
    return band <= 0 ? 0 : current > upper * (1 + band) ? 1 : current < lower * (1 - band) ? -1 : 0
  }
  for (const [i, decision] of decisions.entries()) {
    const side = direction(decision)
    if (side === 0) continue
    const entry = decision + 1
    if (price(series, entry, Field.Open) === 0) return { missing, missingEntry: true }
    const opposite = decisions.slice(i + 1).find((slot) => direction(slot) === -side)
    const requested = opposite === undefined ? day.slots - 3 : opposite + 1
    for (let slot = requested; slot <= deadline; slot++) {
      if (price(series, slot, Field.Open) > 0) {
        return {
          order: { series, side, reference: price(series, decision, Field.Close), entry, exit: slot, deadline },
          missing,
        }
      }
    }
    return {
      order: { series, side, reference: price(series, decision, Field.Close), entry, exit: null, deadline },
      missing,
    }
  }
  return { missing }
}

export interface RankedGap {
  readonly symbol: Etf
  readonly atrUnits: number
  readonly location: number
}

type DailyBar = NonNullable<ReturnType<DailyFrame['bars']['get']>>
export const gapInputs = (history: readonly DailyBar[]) => {
  const previous = history.at(-1)
  if (history.length !== lookback + 1 || previous === undefined)
    throw new Error('Gap ATR requires 15 prior aligned daily bars')
  const atr = mean(
    history.slice(1).map(({ high, low }, i) => {
      const close = history[i].close
      return (Math.max(high, close) - Math.min(low, close)) / close
    }),
  )
  return {
    atr,
    location: previous.high === previous.low ? 0.5 : (previous.close - previous.low) / (previous.high - previous.low),
  }
}

const rankGaps = (days: readonly Day[], daily: readonly DailyFrame[], index: number) => {
  const previous = days[index - 1]
  const today = days[index]
  const ranked: RankedGap[] = []
  for (const symbol of sectors) {
    const open = at(today.bars.get(symbol), 0, Field.Open)
    const close = at(previous.bars.get(symbol), previous.slots - 1, Field.Close)
    const prior = daily.slice(index - lookback - 1, index).flatMap(({ bars }) => {
      const row = bars.get(symbol)
      return row === undefined ? [] : [row]
    })
    if (!observed([open, close]) || prior.length !== lookback + 1) return null
    const { atr, location } = gapInputs(prior)
    if (!(atr > 0)) return null
    ranked.push({ symbol, atrUnits: (open / close - 1) / atr, location })
  }
  return ranked.sort((a, b) => b.atrUnits - a.atrUnits || a.symbol.localeCompare(b.symbol, 'en'))
}

export const gapLegs = (ranked: readonly RankedGap[], { direction, book, size, location }: GapTrial) => {
  const eligible = (row: RankedGap | undefined, sign: Side) => {
    if (row === undefined) return undefined
    const units = sign * row.atrUnits
    const magnitude = size === GapSize.Medium ? units >= 0.25 && units < 0.75 : units >= 0.75
    const aligned = sign === 1 ? row.location >= 0.65 : row.location <= 0.35
    const opposed = sign === 1 ? row.location <= 0.35 : row.location >= 0.65
    return magnitude && (location === CloseLocation.Aligned ? aligned : opposed) ? row.symbol : undefined
  }
  const up = eligible(ranked[0], 1)
  const down = eligible(ranked.at(-1), -1)
  const [long, short] = direction === Direction.Continuation ? [up, down] : [down, up]
  if (long === undefined) return []
  const buy = { symbol: long, side: 1 as const }
  if (book === GapBook.LongOnly) return [buy]
  return short === undefined ? [] : [buy, { symbol: short, side: -1 as const }]
}

export const emptyLedger = () => ({
  base: 0,
  slope: 0,
  turnover: 0,
  capacityUsd: null as number | null,
  grossBound: 0,
  filled: 0,
  unresolved: 0,
  heldGaps: 0,
  missingEntries: 0,
  missingInputs: 0,
})
export type Ledger = ReturnType<typeof emptyLedger>

export const bookOrder = (ledger: Ledger, order: Order, quantity: number) => {
  if (quantity <= 0) return
  ledger.filled++
  const { series, side, entry, exit, deadline } = order
  const open = price(series, entry, Field.Open)
  let high = open
  for (let slot = entry; slot < (exit ?? deadline + 1); slot++) {
    const mark = price(series, slot, Field.High)
    if (mark === 0) ledger.heldGaps++
    high = Math.max(high, mark)
  }
  if (exit === null) {
    ledger.unresolved++
    ledger.grossBound += markedGrossBound(quantity, high)
    return
  }
  const close = price(series, exit, Field.Open)
  ledger.grossBound += markedGrossBound(quantity, Math.max(high, close))
  const fill = closedLeg(side, quantity, open, close)
  ledger.base += fill.base
  ledger.slope += fill.slope
  ledger.turnover += (quantity * (open + close)) / capital
  const supported = (slot: number, fillPrice: number) =>
    (capital * participation * price(series, slot, Field.Volume) * price(series, slot, Field.Vwap)) /
    (quantity * fillPrice)
  ledger.capacityUsd = Math.min(ledger.capacityUsd ?? Infinity, supported(entry, open), supported(exit, close))
}

export const replayGap = (day: Day, ranked: readonly RankedGap[] | null, trial: GapTrial) => {
  const ledger = emptyLedger()
  if (ranked === null) {
    ledger.missingInputs++
    return ledger
  }
  const legs = gapLegs(ranked, trial)
  const entry = 1 // The 09:30 bar must have completed before the first modeled fill.
  const exit = trial.minutes / 5
  const orders: Order[] = []
  for (const { symbol, side } of legs) {
    const series = day.bars.get(symbol)
    const open = at(series, entry, Field.Open)
    if (series === undefined || open === 0) ledger.missingEntries++
    else
      orders.push({
        series,
        side,
        reference: open,
        entry,
        exit: price(series, exit, Field.Open) > 0 ? exit : null,
        deadline: exit,
      })
  }
  if (ledger.missingEntries > 0) return ledger
  for (const order of orders) bookOrder(ledger, order, capital / (orders.length * order.reference * worstSlip))
  return ledger
}

const noiseHistory = (days: readonly Day[], index: number, symbol: Etf) => {
  const returns: number[] = []
  for (const day of days.slice(index - lookback, index)) {
    const series = day.bars.get(symbol)
    const open = at(series, 0, Field.Open)
    const close = at(series, day.slots - 1, Field.Close)
    if (!observed([open, close])) return null
    returns.push(close / open - 1)
  }
  return returns
}

export const replay = (days: readonly Day[], daily: readonly DailyFrame[]) => {
  const elections = annualLiquidity(days)
  const noise = noiseTrials.map((spec) => ({ spec, rows: [] as Ledger[] }))
  const gap = gapTrials.map((spec) => ({ spec, rows: [] as Ledger[] }))
  days.forEach((day, index) => {
    if (index < warmup) {
      for (const path of [...noise, ...gap]) path.rows.push(emptyLedger())
      return
    }
    const ranks = elections.get(day.date.slice(0, 4))?.ranked ?? null
    const histories = new Map(symbols.map((symbol) => [symbol, noiseHistory(days, index, symbol)]))
    const orders = new Map(symbols.map((symbol) => [symbol, noiseOrder(days, index, symbol)]))
    for (const { spec, rows } of noise) {
      const ledger = emptyLedger()
      rows.push(ledger)
      const members = [...spec.fixed, ...(ranks?.slice(0, spec.top) ?? [])]
      const actual = members.map((symbol) => histories.get(symbol) ?? null)
      if (members.length !== spec.fixed.length + spec.top || !actual.every((values) => values !== null)) {
        ledger.missingInputs++
        continue
      }
      const weights = riskWeights(actual, spec.weighting)
      members.forEach((symbol, i) => {
        const path = orders.get(symbol)
        if (path === undefined) throw new Error(`Missing Noise Area replay: ${symbol}`)
        ledger.missingInputs += path.missing
        if (path.missingEntry === true) ledger.missingEntries++
        const { order } = path
        if (order === undefined) return
        const open = price(order.series, order.entry, Field.Open)
        bookOrder(ledger, order, budgetedShares(capital * weights[i], open, order.reference))
      })
    }
    const ranked = rankGaps(days, daily, index)
    for (const { spec, rows } of gap) rows.push(replayGap(day, ranked, spec))
  })
  return { elections: Object.fromEntries(elections), noise, gap }
}
