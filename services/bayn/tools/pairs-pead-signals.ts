import { makeBars, type Bars, type Market } from './pairs-pead-data'
import { listing, priorSessions, rvolMinimum, wdcReset } from './pairs-pead-protocol'

export const requireBars = (market: Market, symbol: string): Bars => {
  const series = market.series.get(symbol)
  if (series === undefined) throw new Error('Missing symbol: ' + symbol)
  return series
}

export const priorEligible = (market: Market, symbol: string) => {
  const firstDate = listing[symbol] ?? ''
  const first = market.sessions.findIndex(({ date }) => date >= firstDate)
  return (day: number) => first >= 0 && day >= first + priorSessions
}

export const sessionBars = (market: Market, symbol: string) => {
  const bars = requireBars(market, symbol)
  if (market.stride === 1) return bars
  const aggregate = makeBars(market.sessions.length)
  for (const [d, { slots }] of market.sessions.entries()) {
    const at = d * market.stride
    aggregate.close[d] = bars.close[at + slots - 1]
    aggregate.open[d] = bars.open[at]
    let high = 0
    let low = Infinity
    let volume = 0
    for (let t = 0; t < slots; t++) {
      if (bars.open[at + t] === 0) {
        volume = 0
        break
      }
      high = Math.max(high, bars.high[at + t])
      low = Math.min(low, bars.low[at + t])
      volume += bars.volume[at + t]
    }
    if (volume > 0) {
      aggregate.volume[d] = volume
      aggregate.high[d] = high
      aggregate.low[d] = low
    }
  }
  return aggregate
}

export type OuModel = { intercept: number; beta: number; sigma: number; halfLife: number; correlation: number }
// Causal OLS on log prices; AR(1) with intercept fitted to the demeaned residuals.
// Return correlation is computed on log differences, not on trending price levels.
export const fitOu = (a: readonly number[], b: readonly number[]): OuModel | null => {
  if (a.length < 4 || a.length !== b.length || a.some((v, i) => !(v > 0 && b[i] > 0))) return null
  const x = b.map(Math.log)
  const y = a.map(Math.log)
  const n = x.length
  const mean = (v: readonly number[]) => v.reduce((sum, r) => sum + r, 0) / v.length
  const xbar = mean(x),
    ybar = mean(y)
  let varX = 0,
    cov = 0
  for (let i = 0; i < n; i++) {
    varX += (x[i] - xbar) ** 2
    cov += (x[i] - xbar) * (y[i] - ybar)
  }
  const beta = cov / varX
  if (!(beta > 0 && Number.isFinite(beta))) return null
  const intercept = ybar - beta * xbar
  const e = x.map((v, i) => y[i] - intercept - beta * v)
  const sigma = Math.sqrt(e.reduce((ss, v) => ss + v * v, 0) / (n - 2))
  if (!(sigma > 1e-8)) return null
  const lagMean = mean(e.slice(0, -1)),
    leadMean = mean(e.slice(1))
  const dx = x.slice(1).map((v, i) => v - x[i])
  const dy = y.slice(1).map((v, i) => v - y[i])
  const dxbar = mean(dx),
    dybar = mean(dy)
  let lagVar = 0,
    ac = 0,
    retCov = 0,
    dxVar = 0,
    dyVar = 0
  for (let i = 0; i < n - 1; i++) {
    lagVar += (e[i] - lagMean) ** 2
    ac += (e[i] - lagMean) * (e[i + 1] - leadMean)
    retCov += (dx[i] - dxbar) * (dy[i] - dybar)
    dxVar += (dx[i] - dxbar) ** 2
    dyVar += (dy[i] - dybar) ** 2
  }
  const phi = ac / lagVar
  return {
    beta,
    intercept,
    sigma,
    halfLife: phi > 0 && phi < 1 ? -Math.LN2 / Math.log(phi) : Infinity,
    correlation: retCov / Math.sqrt(dxVar * dyVar),
  }
}

export const spreadZ = (model: OuModel | null, a: number, b: number) =>
  model !== null && a > 0 && b > 0 ? (Math.log(a) - model.beta * Math.log(b) - model.intercept) / model.sigma : NaN

export const buildPair = (market: Market, a: string, b: string, lookback: number, daily: ReadonlyMap<string, Bars>) => {
  const aa = daily.get(a),
    bb = daily.get(b)
  if (aa === undefined || bb === undefined) throw new Error('Pair session data missing')
  const eligibleA = priorEligible(market, a),
    eligibleB = priorEligible(market, b)
  const aBars = requireBars(market, a),
    bBars = requireBars(market, b)
  const model: (OuModel | null)[] = []
  const z = new Float64Array(aBars.close.length).fill(NaN)
  const wdc = a === 'WDC' || b === 'WDC'
  const reset = wdc ? market.sessions.findIndex((s) => s.date >= wdcReset) : -1
  for (const [d, s] of market.sessions.entries()) {
    const from = d - lookback
    const fit =
      from >= 0 && eligibleA(d) && eligibleB(d) && !(reset >= 0 && d >= reset && from < reset)
        ? fitOu(Array.from(aa.close.subarray(from, d)), Array.from(bb.close.subarray(from, d)))
        : null
    model.push(fit)
    if (fit !== null)
      for (let t = d * market.stride; t < d * market.stride + s.slots; t++)
        z[t] = spreadZ(fit, aBars.close[t], bBars.close[t])
  }
  return { model, z }
}

export type Opening = { gap: number; candle: number; rvol: number; atr: number; previous: number }
export const gapDirection = (o: Opening, threshold: number, fade: boolean) => {
  if (Math.abs(o.gap) < threshold * o.atr || o.rvol < rvolMinimum || !Number.isFinite(o.rvol)) return 0
  const side = Math.sign(o.gap)
  if (fade) return side * o.candle <= -0.25 * o.atr ? -side : 0
  return side * o.candle > 0 ? side : 0
}

export const buildGap = (market: Market, symbol: string, horizon: number, daily: Bars) => {
  const bars = requireBars(market, symbol)
  const eligible = priorEligible(market, symbol)
  const sumVol = new Float64Array(market.sessions.length)
  const result: (Opening | null)[] = []
  for (const [d, { date }] of market.sessions.entries()) {
    const start = d * market.stride
    let volume = 0
    for (let t = start; t < start + horizon; t++) {
      if (bars.open[t] === 0) {
        volume = 0
        break
      }
      volume += bars.volume[t]
    }
    sumVol[d] = volume
    if (
      !eligible(d) ||
      d < 20 ||
      volume <= 0 ||
      (symbol === 'WDC' && date >= wdcReset && market.sessions[d - 20].date < wdcReset)
    ) {
      result.push(null)
      continue
    }
    let tr = 0,
      baseline = 0
    for (let i = d - 20; i < d; i++) {
      baseline += sumVol[i]
      if (sumVol[i] === 0) {
        baseline = 0
        break
      }
      if (i < d - 14) continue
      const prev = daily.close[i - 1]
      // Daily split-day NVDA high contains a discontinuous print, unlike the RTH 5m series.
      if (
        !(prev > 0 && daily.high[i] > 0) ||
        (market.stride === 1 && symbol === 'NVDA' && market.sessions[i].date === '2024-06-10')
      ) {
        baseline = 0
        break
      }
      tr += Math.max(daily.high[i] - daily.low[i], Math.abs(daily.high[i] - prev), Math.abs(daily.low[i] - prev))
    }
    const previous = daily.close[d - 1]
    if (baseline <= 0 || tr <= 0 || previous <= 0) result.push(null)
    else
      result.push({
        gap: bars.open[start] - previous,
        candle: bars.close[start + horizon - 1] - bars.open[start],
        rvol: (volume * 20) / baseline,
        atr: tr / 14,
        previous,
      })
  }
  return result
}
