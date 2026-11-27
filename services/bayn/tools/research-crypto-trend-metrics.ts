import { bootstrap, gate } from './research-crypto-trend-protocol'
import type { Day } from './research-crypto-trend-simulation'
import { dailySharpe, deflatedSharpe } from './research-orb-zab-statistics'

const compound = (returns: readonly number[]) => returns.reduce((wealth, r) => wealth * (1 + r), 1) - 1

// All trials of the same length use the same deterministic draws. Cache only full-sample split/year lengths.
const schedules = new Map<number, Uint16Array>()
const drawStarts = (n: number) => {
  const existing = schedules.get(n)
  if (existing !== undefined) return existing
  const samples = new Uint16Array(Math.ceil(n / bootstrap.days) * bootstrap.draws)
  let state = bootstrap.seed
  for (let i = 0; i < samples.length; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    samples[i] = (state >>> 0) % n
  }
  schedules.set(n, samples)
  return samples
}

export const blockP = (daily: readonly number[]) => {
  const n = daily.length
  if (n < 2 * bootstrap.days || n > 65_535 || daily.every((r) => r === daily[0])) return null
  const returns = daily.map((r) => Math.log1p(r))
  const total = returns.reduce((sum, r) => sum + r, 0)
  const mean = total / n
  const prefix = new Float64Array(n * 2 + 1)
  for (let j = 0; j < n * 2; j++) prefix[j + 1] = prefix[j] + returns[j % n] - mean
  const tail = n % bootstrap.days
  const sums = Float64Array.from(returns, (_, j) => prefix[j + bootstrap.days] - prefix[j])
  const tails = Float64Array.from(returns, (_, j) => prefix[j + tail] - prefix[j])
  const starts = drawStarts(n)
  const blocks = Math.floor(n / bootstrap.days)
  let exceeds = 0
  let at = 0
  for (let draw = 0; draw < bootstrap.draws; draw++) {
    let resampled = 0
    for (let b = 0; b < blocks; b++) resampled += sums[starts[at++]]
    if (tail > 0) resampled += tails[starts[at++]]
    if (resampled >= total) exceeds++
  }
  return (exceeds + 1) / (bootstrap.draws + 1)
}

export const economics = (days: readonly Day[]) => {
  const returns = days.map(({ net }) => net)
  let equity = 1
  let peak = 1
  let maxDrawdown = 0
  let turnover = 0
  let feeDrag = 0
  let heldBars = 0
  let staleBars = 0
  let unsettled = 0
  for (const day of days) {
    maxDrawdown = Math.max(maxDrawdown, day.drawdown, 1 - (equity * day.min) / peak)
    peak = Math.max(peak, equity * day.max)
    equity *= 1 + day.net
    turnover += day.turnover
    feeDrag += day.feeDrag
    heldBars += day.heldBars
    staleBars += day.staleBars
    unsettled += day.unsettled
  }
  const annualize = 365 / days.length
  const cagr = equity ** annualize - 1
  const sharpe = dailySharpe(returns)
  const ranked = returns.toSorted((a, b) => b - a)
  return {
    days: days.length,
    net: equity - 1,
    cagr,
    sharpe: sharpe === null ? null : sharpe * Math.sqrt(365),
    maxDrawdown,
    calmar: maxDrawdown > 0 ? cagr / maxDrawdown : null,
    exTop5Net: ranked.length > 5 ? compound(ranked.slice(5)) : null,
    turnover,
    annualTurnover: turnover * annualize,
    annualFeeDrag: feeDrag * annualize,
    heldBars,
    staleBars,
    unsettled,
  }
}
export type Economics = ReturnType<typeof economics>
export const summarize = (days: readonly Day[], btc: Economics, dsrReference: number | null) => {
  const metrics = economics(days)
  const daily = days.map(({ net }) => net)
  return {
    ...metrics,
    maxDrawdownVsBtc: btc.maxDrawdown > 0 ? metrics.maxDrawdown / btc.maxDrawdown : null,
    blockP: blockP(daily),
    dsr: deflatedSharpe(daily, dsrReference),
  }
}
export type Metrics = ReturnType<typeof summarize>

export const economicGates = (m: Metrics) => ({
  positiveNet: m.net > 0,
  positiveExTop5: m.exTop5Net !== null && m.exTop5Net > 0,
  drawdown: m.maxDrawdownVsBtc !== null && m.maxDrawdownVsBtc < gate.maxBtcDrawdownRatio,
  lowTurnover: m.annualTurnover <= gate.maxAnnualTurnover,
  data: m.unsettled === 0 && m.heldBars > 0 && m.staleBars / m.heldBars <= 0.005,
})
export const regimeGate = (m: Metrics, btc: Economics, equal: Economics) =>
  m.sharpe !== null &&
  btc.sharpe !== null &&
  equal.sharpe !== null &&
  m.sharpe > Math.max(btc.sharpe, equal.sharpe) &&
  m.calmar !== null &&
  m.calmar > 0 &&
  m.maxDrawdownVsBtc !== null &&
  m.maxDrawdownVsBtc < gate.maxBtcDrawdownRatio
export const passes = (checks: Record<string, boolean>) => Object.values(checks).every(Boolean)
export const plateau = (candidate: Metrics, variants: readonly { id: string; metrics: Metrics }[]) => {
  const stable = variants
    .filter(
      ({ metrics: m }) =>
        passes(economicGates(m)) &&
        m.sharpe !== null &&
        candidate.sharpe !== null &&
        m.sharpe >= gate.neighborSharpeRatio * candidate.sharpe,
    )
    .map(({ id }) => id)
  return {
    tested: variants.map(({ id }) => id),
    stable,
    pass: variants.length >= 2 && stable.length >= Math.ceil(variants.length / 2),
  }
}
