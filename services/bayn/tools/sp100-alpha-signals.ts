import { type Tape } from './sp100-alpha-data'
import { type Trial } from './sp100-alpha-protocol'

export type Targets = Float64Array[]
export const rtxBreak = '2020-04-03'
const trendHorizons = [20, 60, 120, 252]

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

export function features(tape: Tape) {
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
  const atr = tape.series.map(({ close, high, low }, id) => {
    const range = prefix(close.length, (i) =>
      close[i] > 0 && close[i - 1] > 0
        ? Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])) / close[i - 1]
        : 0,
    )
    return (i: number) => (history[id].complete(i, 60) ? range(i, 60) / 60 : NaN)
  })
  const cache = new Map<string, Float64Array[]>()
  const cached = (key: string, score: (id: number, i: number) => number) => {
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const scores = tape.series.map(({ close }, id) => close.map((_, i) => score(id, i)))
    cache.set(key, scores)
    return scores
  }
  const spy = tape.series[tape.spy].close
  const guard = spy.map((value, i) => {
    if (i < 126) return 1
    let peak = 0
    for (let j = Math.max(0, i - 251); j <= i; j++) peak = Math.max(peak, spy[j])
    const spyVol = Math.sqrt(252 * history[tape.spy].variance(i, 20))
    return value / peak < 0.85 && spyVol > 0.25 ? 0.4 : 1
  })
  return { returns, history, model, beta, atr, cached, guard }
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

function closeEligible(tape: Tape, id: number, i: number) {
  const { symbol, close } = tape.series[id]
  const date = tape.dates[i]
  // Announced 2020-03-30: flatten the predecessor before the discontinuous merger/spinoff.
  return close[i] > 0 && !(symbol === 'RTX' && date >= '2020-03-30' && date < rtxBreak)
}

function trendBook(
  tape: Tape,
  config: Extract<Trial, { family: 'trend' }>['config'],
  f: ReturnType<typeof features>,
  i: number,
  book: Float64Array,
) {
  const votes = f.cached('trend-votes', (id, day) => {
    const { close } = tape.series[id]
    if (!f.history[id].complete(day, 252)) return NaN
    return (
      trendHorizons.reduce((total, window) => total + Math.sign(close[day] - close[day - window]), 0) /
      trendHorizons.length
    )
  })
  for (const group of tape.etfClasses) {
    const candidates = group.flatMap((id) => {
      const signal = votes[id][i]
      const risk = config.weighting === 'atr' ? f.atr[id](i) : Math.sqrt(f.history[id].variance(i, 60))
      return Number.isFinite(signal) && risk > 0 ? [{ id, signal, inverseRisk: 1 / Math.max(0.0025, risk) }] : []
    })
    const divisor = candidates.reduce((total, { inverseRisk }) => total + inverseRisk, 0) * tape.etfClasses.length
    for (const { id, signal, inverseRisk } of candidates) {
      if (Math.abs(signal) <= config.deadband || (signal < 0 && config.mode === 'long-only')) continue
      book[id] = (Math.sign(signal) * inverseRisk) / divisor
    }
  }
}

export function targetBook(tape: Tape, trial: Trial, f: ReturnType<typeof features>, omittedSector = -1): Targets {
  const cycle = 'cycle' in trial.config ? trial.config.cycle : trial.family === 'defensive' ? 21 : 5
  const stocks = tape.stockSectors.map((group, index) => (index === omittedSector ? [] : group))
  const members = stocks.flat()
  const omittedEtf = tape.sectorEtfs[omittedSector]
  const n = tape.series.length
  const tranches: Float64Array[] = Array.from({ length: cycle }, () => new Float64Array(n))
  const running = new Float64Array(n)
  const momentumBase: Targets = []
  const vol = new TrailingVol(126)
  return tape.dates.map((_, i) => {
    const next = new Float64Array(n)
    if (trial.family === 'trend') {
      trendBook(tape, trial.config, f, i, next)
    } else if (trial.family === 'momentum') {
      const { regression, lookback, skip, book } = trial.config
      const scores = f.cached(
        `residual-${regression}-${lookback}-${skip}`,
        (id, day) => f.model.get(id)?.residual(day - skip, regression, lookback) ?? NaN,
      )
      const score = (id: number) => (closeEligible(tape, id, i) && Number.isFinite(f.beta[id][i]) ? scores[id][i] : NaN)
      const depth = Number(book.split('-')[1])
      if (book.startsWith('sector-')) {
        for (const group of stocks) assignSpread(next, group, score, depth, 1 / stocks.length)
      } else {
        assignSpread(next, members, score, depth, 1)
      }
    } else if (trial.family === 'reversal') {
      const { lookback } = trial.config
      const scores = f.cached(
        `residual-60-${lookback}-0`,
        (id, day) => f.model.get(id)?.residual(day, 60, lookback) ?? NaN,
      )
      const weakest = stocks
        .flatMap((group, sector) => {
          const score = (id: number) =>
            closeEligible(tape, id, i) &&
            Number.isFinite(f.beta[id][i]) &&
            Math.abs(f.returns[id][i]) <= 3.5 * f.atr[id](i - 1)
              ? -scores[id][i]
              : NaN
          const eligible = group.filter((id) => Number.isFinite(score(id))).sort((a, b) => score(a) - score(b) || a - b)
          const short = eligible[0],
            long = eligible.at(-1)
          return short !== undefined && long !== undefined && short !== long
            ? [{ sector, short, long, spread: score(long) - score(short) }]
            : []
        })
        .sort((a, b) => b.spread - a.spread || a.sector - b.sector)
      for (const { short, long } of weakest.slice(0, 10)) {
        next[short] = -0.05
        next[long] = 0.05
      }
    } else {
      const { metric, depth } = trial.config
      assignSpread(
        next,
        members,
        (id) => {
          if (!closeEligible(tape, id, i) || !Number.isFinite(f.beta[id][i])) return NaN
          return metric === 'beta' ? -f.beta[id][i] : -Math.sqrt(f.history[id].variance(i, 60))
        },
        depth,
        1,
      )
    }

    const slot = i % cycle
    const prior = tranches[slot]
    const target = new Float64Array(n)
    for (let id = 0; id < n; id++) {
      running[id] += next[id] - prior[id]
      if (Math.abs(running[id]) < 1e-12) running[id] = 0
      if (id === omittedEtf || !closeEligible(tape, id, i)) continue
      if (trial.family !== 'trend' && id !== tape.spy && !Number.isFinite(f.beta[id][i])) continue
      target[id] = running[id] / cycle
    }
    tranches[slot] = next
    // Equal-dollar stock spreads retain sector neutrality; the ETF overlay neutralizes estimated SPY beta.
    if (trial.family !== 'trend') {
      const sectorNeutral =
        trial.family === 'reversal' || (trial.family === 'momentum' && trial.config.book.startsWith('sector-'))
      for (const group of sectorNeutral ? stocks : [members]) dollarNeutral(target, group)
      for (const id of members) if (target[id] !== 0) target[tape.spy] -= target[id] * f.beta[id][i]
    }
    const exposure = Math.max(1, gross(target))
    for (let id = 0; id < n; id++) target[id] /= exposure
    if (trial.family !== 'momentum') return target
    vol.push(shadowReturn(tape, momentumBase, i))
    momentumBase.push(target)
    const realized = vol.annualized()
    const scale = (2 / 3) * (realized === 0 ? 1 : clamp(0.1 / realized, 0.4, 1.5)) * f.guard[i]
    return target.map((w) => w * scale)
  })
}

export class TrailingVol {
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

function shadowReturn(tape: Tape, targets: Targets, i: number) {
  if (i < 2) return 0
  return targets[i - 2].reduce((sum, value, id) => {
    if (value === 0) return sum
    const { open, close } = tape.series[id]
    if (!(open[i] > 0 && open[i - 1] > 0 && close[i - 2] > 0)) return sum
    return sum + (value * (open[i] - open[i - 1])) / close[i - 2]
  }, 0)
}

export function riskParity(tape: Tape, sleeves: Targets[]): Targets {
  const vol = sleeves.map(() => new TrailingVol(126))
  return tape.dates.map((_, i) => {
    const weights = sleeves.map((sleeve, j) => {
      vol[j].push(shadowReturn(tape, sleeve, i))
      return 1 / Math.max(0.05, vol[j].annualized())
    })
    const total = weights.reduce((a, b) => a + b, 0)
    return Float64Array.from(tape.series, (_, id) =>
      sleeves.reduce((sum, sleeve, j) => sum + (sleeve[i][id] * weights[j]) / total, 0),
    )
  })
}
