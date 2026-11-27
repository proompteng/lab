import { dayMs, type Bars, type Market } from './pairs-pead-data'
import {
  annualBorrow,
  capital,
  coreEtfs,
  pairs,
  pairWindows,
  sellFee,
  splits,
  wdcFlatten,
  wdcReset,
  type Trial,
} from './pairs-pead-protocol'
import { buildGap, buildPair, gapDirection, priorEligible, requireBars, sessionBars } from './pairs-pead-signals'

export const ledgerColumns = [
  'gross',
  'halfTurnover',
  'sales',
  'borrow',
  'entries',
  'exits',
  'missing',
  'unfilled',
  'markedGross',
  'fillGross',
  'markedNet',
] as const
export type Ledger = Record<(typeof ledgerColumns)[number], Float64Array>
const ledger = (n: number): Ledger => ({
  gross: new Float64Array(n),
  halfTurnover: new Float64Array(n),
  sales: new Float64Array(n),
  borrow: new Float64Array(n),
  entries: new Float64Array(n),
  exits: new Float64Array(n),
  missing: new Float64Array(n),
  unfilled: new Float64Array(n),
  markedGross: new Float64Array(n),
  fillGross: new Float64Array(n),
  markedNet: new Float64Array(n),
})

export const netAt = (l: Ledger, d: number, cost: number) =>
  l.gross[d] - (cost / 10_000) * l.halfTurnover[d] - sellFee * l.sales[d] - l.borrow[d]

export const accumulate = (to: Ledger, from: Ledger, sign = 1) => {
  for (const field of ledgerColumns) for (let d = 0; d < to[field].length; d++) to[field][d] += sign * from[field][d]
  return to
}

export class Book {
  side = 0
  entered = -1
  best = 0
  priorTarget = 0
  atr = 0
  aQty = 0
  bQty = 0
  aPrice = 0
  bPrice = 0

  constructor(
    readonly output: Ledger,
    readonly budget: number,
  ) {}

  mark(d: number, a: number, b: number) {
    if (this.side === 0) return
    this.output.gross[d] += this.aQty * (a - this.aPrice) + this.bQty * (b - this.bPrice)
    this.aPrice = a
    this.bPrice = b
  }

  carry(d: number, days: number) {
    this.output.borrow[d] +=
      (-Math.min(0, this.aQty * this.aPrice, this.bQty * this.bPrice) * annualBorrow * days) / 365
  }

  order(d: number, a: number, b: number, side: number) {
    this.mark(d, a, b)
    const aQty = (side * this.budget) / (2 * a)
    const bQty = (-side * this.budget) / (2 * b)
    const tradeA = (aQty - this.aQty) * a
    const tradeB = (bQty - this.bQty) * b
    this.output.halfTurnover[d] += (Math.abs(tradeA) + Math.abs(tradeB)) / 2
    this.output.sales[d] -= Math.min(0, tradeA) + Math.min(0, tradeB)
    this.output.fillGross[d] = Math.abs(aQty * a) + Math.abs(bQty * b)
    if (side !== 0 && this.side === 0) {
      this.output.entries[d]++
      this.entered = d
      this.best = a
    } else if (side === 0 && this.side !== 0) this.output.exits[d]++
    this.side = side
    this.aQty = aQty
    this.bQty = bQty
    this.aPrice = a
    this.bPrice = b
  }

  markExposure(d: number) {
    const a = this.aQty * this.aPrice,
      b = this.bQty * this.bPrice
    this.output.markedGross[d] = Math.abs(a) + Math.abs(b)
    this.output.markedNet[d] = a + b
  }
}

export const completedBarStop = (book: Book, bars: Bars, at: number) => {
  if (book.side === 0 || bars.open[at] === 0) return false
  const triggered = book.side === 1 ? bars.low[at] <= book.best - book.atr : bars.high[at] >= book.best + book.atr
  book.best = book.side === 1 ? Math.max(book.best, bars.high[at]) : Math.min(book.best, bars.low[at])
  return triggered
}

type Prepared = ReturnType<typeof prepare>
export const prepare = (market: Market, core: readonly string[]) => {
  const perSession = new Map([...market.series.keys()].map((symbol) => [symbol, sessionBars(market, symbol)]))
  const pairModels = new Map<string, ReturnType<typeof buildPair>>(
    pairs.flatMap(([a, b]) =>
      pairWindows.map((lookback) => [`${a}/${b}:${lookback}`, buildPair(market, a, b, lookback, perSession)] as const),
    ),
  )
  const gaps = new Map<string, ReturnType<typeof buildGap>>(
    core
      .filter((s) => s !== 'SPY')
      .flatMap((symbol) =>
        (market.stride === 1 ? [1] : [1, 3]).map((h) => {
          const daily = perSession.get(symbol)
          if (daily === undefined) throw new Error('Gap session data missing')
          return [`${symbol}:${h}`, buildGap(market, symbol, h, daily)] as const
        }),
      ),
  )
  return { market, core, pairModels, gaps }
}

const wdcClosing = (a: string, b: string, date: string) =>
  (a === 'WDC' || b === 'WDC') && date >= wdcFlatten && date <= wdcReset

const splitEnds = (market: Market, trial: Trial) =>
  new Set(splits[trial.frequency].map((s) => market.sessions.findLastIndex((d) => d.date <= s.to)))
type Unit = readonly [string, string, string]

export const replayUnit = (
  setup: Prepared,
  trial: Trial,
  unit: Unit,
  budget: number,
  boundaries: ReadonlySet<number>,
) => {
  const { market, pairModels, gaps } = setup
  const [id, symA, symB] = unit
  const a = requireBars(market, symA),
    b = requireBars(market, symB)
  const isPair = trial.engine === 'pair-intraday' || trial.engine === 'pair-swing'
  const pair = isPair ? pairModels.get(`${id}:${trial.lookback}`) : undefined
  const gap = isPair
    ? undefined
    : gaps.get(`${symA}:${trial.engine === 'gap-intraday' ? trial.horizon : trial.engine === 'gap-fade' ? 3 : 1}`)
  if (pair === undefined && gap === undefined) throw new Error('Missing precomputed signals for ' + id)
  const output = ledger(market.sessions.length)
  const book = new Book(output, budget)
  const eligibleB = priorEligible(market, symB)
  const eligibleA = priorEligible(market, symA)
  let pending = 0
  let exit = false
  for (const [d, s] of market.sessions.entries()) {
    const start = d * market.stride
    const last = boundaries.has(d)
    const nextDate = market.sessions[d + 1]?.date ?? ''
    if (d > 0 && book.side !== 0) {
      if (boundaries.has(d - 1)) {
        // The prior split is already unresolved. Do not import its positions into the next split.
        book.side = book.aQty = book.bQty = 0
        exit = false
      } else book.carry(d, (s.epoch - market.sessions[d - 1].epoch) / dayMs)
    }
    if (trial.frequency === 'daily') {
      const held = book.side !== 0
      const flat = last || wdcClosing(symA, symB, s.date)
      if (a.open[d] > 0 && b.open[d] > 0) {
        if (held) book.order(d, a.open[d], b.open[d], flat || exit ? 0 : book.side)
        else if (!flat && pending !== 0 && eligibleA(d) && eligibleB(d)) {
          book.order(d, a.open[d], b.open[d], pending)
          const opening = gap?.[d - 1]
          if (opening != null) book.atr = opening.atr
        }
      } else {
        if (held) output.missing[d]++
        if (pending !== 0) output.unfilled[d]++
      }
      pending = 0
      if (flat && book.side !== 0) {
        output.missing[d]++
        exit = true
      }
      const validClose = a.close[d] > 0 && b.close[d] > 0
      if (validClose) book.mark(d, a.close[d], b.close[d])
      else if (book.side !== 0) output.missing[d]++
      if (book.side !== 0 && trial.frequency === 'daily' && 'hold' in trial) {
        const z = pair?.z[d] ?? NaN
        const stop = isPair
          ? Math.abs(z) <= 0.25 || Math.abs(z) >= 4 || !Number.isFinite(z)
          : completedBarStop(book, a, d)
        exit = exit || !validClose || stop || d - book.entered + 1 >= trial.hold
      } else {
        exit = false
        if (
          !last &&
          !boundaries.has(d + 1) &&
          !wdcClosing(symA, symB, s.date) &&
          !wdcClosing(symA, symB, nextDate) &&
          validClose
        ) {
          if (trial.engine === 'pair-swing' && pair !== undefined) {
            const z = pair.z[d]
            if (entryAllowed(trial, z, pair.model[d])) pending = -Math.sign(z)
          } else if (trial.engine === 'gap-swing') {
            const opening = gap?.[d]
            if (opening != null) pending = gapDirection(opening, trial.gap, false)
          }
        }
      }
      book.markExposure(d)
      continue
    }

    let turnover = 0,
      volume = 0
    const opening = gap?.[d]
    for (let t = 0; t < s.slots; t++) {
      const at = start + t
      const eod = t === s.slots - 1
      if (a.open[at] > 0 && b.open[at] > 0) {
        if (book.side !== 0 && (exit || eod)) {
          book.order(d, a.open[at], b.open[at], 0)
          exit = false
        } else if (book.side === 0 && !eod && pending !== 0) {
          book.order(d, a.open[at], b.open[at], pending)
          if (opening != null) {
            book.atr = opening.atr
            book.priorTarget = opening.previous
          }
        }
      } else {
        if (pending !== 0) output.unfilled[d]++
        // A missing candidate bar can hide a protective stop even without a pending exit.
        if (book.side !== 0 && (exit || eod || (!isPair && a.open[at] === 0))) {
          output.missing[d]++
          exit = true
        }
      }
      pending = 0
      if (book.side !== 0 && eod) {
        if (a.close[at] > 0 && b.close[at] > 0) book.mark(d, a.close[at], b.close[at])
        book.markExposure(d)
      }
      if (eod) break
      turnover += a.volume[at] * a.vwap[at]
      volume += a.volume[at]
      if (book.side !== 0) {
        if (trial.engine === 'pair-intraday' && pair !== undefined) {
          const z = pair.z[at]
          exit ||= Math.abs(z) <= 0.25 || Math.abs(z) >= 4 || !Number.isFinite(z)
        } else {
          exit ||= completedBarStop(book, a, at)
          if (trial.engine === 'gap-fade' && a.close[at] > 0) {
            const target = trial.target === 'vwap' ? turnover / volume : book.priorTarget
            exit ||= book.side * (a.close[at] - target) >= 0
          }
        }
      } else if (t + 1 < s.slots - 1 && eligibleA(d) && eligibleB(d) && !wdcClosing(symA, symB, s.date)) {
        if (trial.engine === 'pair-intraday' && pair !== undefined && t >= 5) {
          const z = pair.z[at]
          if (entryAllowed(trial, z, pair.model[d])) pending = -Math.sign(z)
        } else if (
          t === 2 &&
          opening != null &&
          a.close[at] > 0 &&
          b.close[at] > 0 &&
          (trial.engine === 'gap-intraday' || trial.engine === 'gap-fade')
        ) {
          const side = gapDirection(opening, trial.gap, trial.engine === 'gap-fade')
          const target = trial.engine === 'gap-fade' && trial.target === 'vwap' ? turnover / volume : opening.previous
          // Do not enter a fade that has already reached its target by signal time.
          if (trial.engine !== 'gap-fade' || side * (a.close[at] - target) < 0) pending = side
        }
      }
    }
  }
  return output
}

export const entryAllowed = (
  trial: { filter: string; z: number },
  z: number,
  model: { halfLife: number; correlation: number } | null,
) =>
  model !== null &&
  Math.abs(z) >= trial.z &&
  Math.abs(z) < 4 &&
  (trial.filter === 'none' || (trial.filter === 'half-life' ? model.halfLife <= 10 : model.correlation >= 0.7))

export const replay = (setup: Prepared, trial: Trial) => {
  const isPair = trial.engine === 'pair-intraday' || trial.engine === 'pair-swing'
  const units: Unit[] = isPair
    ? pairs.map(([a, b]) => [`${a}/${b}`, a, b])
    : setup.core.filter((s) => s !== 'SPY' && (trial.universe === 'core' || !coreEtfs.has(s))).map((s) => [s, s, 'SPY'])
  const dates = setup.market.sessions
  const budget = capital / units.length
  const boundaries = splitEnds(setup.market, trial)
  const total = ledger(dates.length)
  const components = new Map(
    units.map((unit) => {
      const contribution = replayUnit(setup, trial, unit, budget, boundaries)
      accumulate(total, contribution)
      return [unit[0], contribution]
    }),
  )
  if (total.fillGross.some((v) => v > capital + 1e-7)) throw new Error('Fill gross exceeded portfolio cap: ' + trial.id)
  return { dates, total, components }
}
