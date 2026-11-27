// Wave 3A frozen momentum-120-120-21-10-sector-2 (proompteng/lab@5ad36d2bc, PR #16366).
import type { Sp100Tape } from './master-portfolio-data'

type Targets = Float64Array[]
const rtxBreak = '2020-04-03'
export const mmcLastSession = '2026-01-13'
export const mmcSuccessorStart = '2026-01-14'
type MmcHandling = 'original' | 'causal-exit' | 'ex-mmc'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const gross = (book: Float64Array) => book.reduce((total, value) => total + Math.abs(value), 0)

const prefix = (length: number, compute: (i: number) => number) => {
  const values = new Float64Array(length + 1)
  for (let i = 0; i < length; i++) values[i + 1] = values[i] + compute(i)
  return (end: number, n: number) => values[end + 1] - values[end + 1 - n]
}

const closeReturns = (close: Float64Array, reset = -1) =>
  close.map((value, i) =>
    i > 0 && i !== reset && value > 0 && close[i - 1] > 0 ? Math.log(value / close[i - 1]) : NaN,
  )

function moments(returns: Float64Array) {
  const n = returns.length
  const missing = prefix(n, (i) => +!Number.isFinite(returns[i]))
  const sum = prefix(n, (i) => returns[i] || 0)
  const squares = prefix(n, (i) => returns[i] ** 2 || 0)
  return {
    complete: (i: number, len: number) => i >= len && missing(i, len) === 0,
    sum,
    variance: (i: number, len: number) => Math.max(0, squares(i, len) / len - (sum(i, len) / len) ** 2),
  }
}

export function regress(varMarket: number, varSector: number, cross: number, covMarket: number, covSector: number) {
  const determinant = varMarket * varSector - cross ** 2
  if (!(determinant > 1e-7 * varMarket * varSector)) return null
  return [
    (covMarket * varSector - covSector * cross) / determinant,
    (covSector * varMarket - covMarket * cross) / determinant,
  ]
}

function residualFeatures(y: Float64Array, x: Float64Array, z: Float64Array) {
  const [stock, market, sector] = [moments(y), moments(x), moments(z)]
  const product = (a: Float64Array, b: Float64Array) => prefix(a.length, (i) => a[i] * b[i] || 0)
  const [xy, xz, yz] = [product(x, y), product(x, z), product(y, z)]
  const cov = (a: typeof stock, b: typeof stock, p: typeof xy, i: number, n: number) =>
    p(i, n) / n - (a.sum(i, n) * b.sum(i, n)) / n ** 2
  return {
    beta(i: number) {
      if (!stock.complete(i, 60) || !market.complete(i, 60)) return NaN
      const v = market.variance(i, 60)
      return v > 0 ? cov(stock, market, xy, i, 60) / v : NaN
    },
    residual(i: number, regression: number, lookback: number) {
      const fit = i - lookback
      if (![stock, market, sector].every((m) => m.complete(fit, regression) && m.complete(i, lookback))) return NaN
      const covMarket = cov(stock, market, xy, fit, regression)
      const covSector = cov(stock, sector, yz, fit, regression)
      const beta = regress(
        market.variance(fit, regression),
        sector.variance(fit, regression),
        cov(market, sector, xz, fit, regression),
        covMarket,
        covSector,
      )
      if (beta === null) return NaN
      const [b, c] = beta
      const fitted = (day: number, n: number) => stock.sum(day, n) - b * market.sum(day, n) - c * sector.sum(day, n)
      const noise = stock.variance(fit, regression) - b * covMarket - c * covSector
      return noise > 1e-10
        ? (fitted(i, lookback) - (fitted(fit, regression) * lookback) / regression) / Math.sqrt(noise * lookback)
        : NaN
    },
  }
}

export function features(tape: Sp100Tape) {
  const returns = tape.series.map(({ close, symbol }) =>
    closeReturns(close, symbol === 'RTX' ? tape.dates.indexOf(rtxBreak) : -1),
  )
  const history = returns.map(moments)
  const model = new Map(
    tape.stockSectors.flatMap((group, sector) =>
      group.map(
        (id) => [id, residualFeatures(returns[id], returns[tape.spy], returns[tape.sectorEtfs[sector]])] as const,
      ),
    ),
  )
  const beta = tape.series.map(({ close }, id) => close.map((_, i) => model.get(id)?.beta(i) ?? NaN))
  const spy = tape.series[tape.spy].close
  const guard = spy.map((value, i) => {
    if (i < 126) return 1
    let peak = 0
    for (let j = Math.max(0, i - 251); j <= i; j++) peak = Math.max(peak, spy[j])
    const spyVol = Math.sqrt(252 * history[tape.spy].variance(i, 20))
    return value / peak < 0.85 && spyVol > 0.25 ? 0.4 : 1
  })
  return { model, beta, guard }
}

function assignSpread(
  book: Float64Array,
  members: readonly number[],
  score: (i: number) => number,
  depth: number,
  budget: number,
) {
  const sorted = members
    .map((id) => ({ id, value: score(id) }))
    .filter(({ value }) => Number.isFinite(value))
    .sort((a, b) => a.value - b.value || a.id - b.id)
  if (sorted.length < depth * 2) return
  const unit = budget / (2 * depth)
  for (let k = 0; k < depth; k++) {
    book[sorted[k].id] = -unit
    book[sorted[sorted.length - 1 - k].id] = unit
  }
}

function dollarNeutral(book: Float64Array, members: readonly number[]) {
  let long = 0
  let short = 0
  for (const id of members) {
    long += Math.max(0, book[id])
    short -= Math.min(0, book[id])
  }
  if (long > short) {
    for (const id of members) if (book[id] > 0) book[id] *= short / long
  } else if (short > long) {
    for (const id of members) if (book[id] < 0) book[id] *= long / short
  }
}

function closeEligible(tape: Sp100Tape, id: number, i: number) {
  const { symbol, close } = tape.series[id]
  const date = tape.dates[i]
  // Announced 2020-03-30: flatten the predecessor before the discontinuous merger/spinoff.
  return close[i] > 0 && !(symbol === 'RTX' && date >= '2020-03-30' && date < rtxBreak)
}

export function sp100Targets(tape: Sp100Tape, mmc: MmcHandling): Targets {
  const cycle = 10
  const f = features(tape)
  const stocks = tape.stockSectors.map((group) =>
    group.filter((id) => mmc !== 'ex-mmc' || tape.series[id].symbol !== 'MMC'),
  )
  const members = stocks.flat()
  const n = tape.series.length
  const eligible = (id: number, i: number) =>
    closeEligible(tape, id, i) &&
    !(mmc === 'causal-exit' && tape.series[id].symbol === 'MMC' && tape.dates[i] >= mmcLastSession)
  const tranches = Array.from({ length: cycle }, () => new Float64Array(n))
  const running = new Float64Array(n)
  const momentumBase: Targets = []
  const vol = new TrailingVol(126)
  return tape.dates.map((_, i) => {
    const next = new Float64Array(n)
    const score = (id: number) =>
      eligible(id, i) && Number.isFinite(f.beta[id][i]) ? (f.model.get(id)?.residual(i - 21, 120, 120) ?? NaN) : NaN
    for (const group of stocks) assignSpread(next, group, score, 2, 1 / stocks.length)
    const slot = i % cycle
    const prior = tranches[slot]
    const target = new Float64Array(n)
    for (const id of members) {
      running[id] += next[id] - prior[id]
      if (Math.abs(running[id]) < 1e-12) running[id] = 0
      if (eligible(id, i) && Number.isFinite(f.beta[id][i])) target[id] = running[id] / cycle
    }
    tranches[slot] = next
    for (const group of stocks) dollarNeutral(target, group)
    for (const id of members) if (target[id] !== 0) target[tape.spy] -= target[id] * f.beta[id][i]
    const exposure = Math.max(1, gross(target))
    for (let id = 0; id < n; id++) target[id] /= exposure
    vol.push(shadowReturn(tape, momentumBase, i, mmc))
    momentumBase.push(target)
    const realized = vol.annualized()
    const scale = (2 / 3) * (realized === 0 ? 1 : clamp(0.1 / realized, 0.4, 1.5)) * f.guard[i]
    return target.map((w) => w * scale)
  })
}
class TrailingVol {
  private readonly values: Float64Array
  private count = 0
  private sum = 0
  private squares = 0

  constructor(private readonly window: number) {
    this.values = new Float64Array(window)
  }

  push(value: number) {
    const slot = this.count++ % this.window
    const old = this.values[slot]
    this.sum += value - old
    this.squares += value ** 2 - old ** 2
    this.values[slot] = value
  }

  annualized() {
    if (this.count < this.window) return 0
    return Math.sqrt(252 * Math.max(0, this.squares / this.window - (this.sum / this.window) ** 2))
  }
}

function shadowReturn(tape: Sp100Tape, targets: Targets, i: number, mmc: MmcHandling) {
  if (i < 2) return 0
  return targets[i - 2].reduce((sum, value, id) => {
    if (value === 0) return sum
    const { symbol, open, close } = tape.series[id]
    const exit =
      mmc === 'causal-exit' && symbol === 'MMC' && tape.dates[i] === mmcSuccessorStart ? close[i - 1] : open[i]
    if (!(exit > 0 && open[i - 1] > 0 && close[i - 2] > 0)) return sum
    return sum + (value * (exit - open[i - 1])) / close[i - 2]
  }, 0)
}
