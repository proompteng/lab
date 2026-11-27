import type { Session } from './etf-canary-macro-data'
import {
  annualDays,
  asset,
  canaries,
  defense,
  defensiveSectors,
  ensembleCanary,
  ensembleMacro,
  ensembleTrend,
  etfs,
  horizons,
  offense,
  regimes,
  sectors,
  shy,
  trendSleeves,
  type Etf,
  type Standalone,
  type Trial,
} from './etf-canary-macro-protocol'

const n = etfs.length
const riskWindow = 63
const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x))
const l1 = (w: Float64Array) => w.reduce((sum, x) => sum + Math.abs(x), 0)
const zero = () => new Float64Array(n)

export type Features = {
  returns: ReadonlyMap<number, Float64Array>
  momentum: Float64Array
  covariance: Float64Array
  vol: Float64Array
}

export const features = (sessions: readonly Session[]): Features[] => {
  const run = new Uint16Array(n)
  const log = sessions.map(({ close }, t) =>
    Float64Array.from(close, (price, i) => {
      const prior = sessions[t - 1]?.close[i]
      return price > 0 && prior > 0 ? Math.log(price / prior) : 0
    }),
  )
  const sums = zero()
  const cross = new Float64Array(n * n)
  return sessions.map(({ close }, t) => {
    const add = log[t]
    const drop = log[t - riskWindow]
    for (let i = 0; i < n; i++) {
      run[i] = close[i] > 0 ? run[i] + 1 : 0
      sums[i] += add[i] - (drop?.[i] ?? 0)
      for (let j = 0; j <= i; j++) cross[i * n + j] += add[i] * add[j] - (drop !== undefined ? drop[i] * drop[j] : 0)
    }
    const covariance = new Float64Array(n * n)
    const vol = zero().fill(NaN)
    for (let i = 0; i < n; i++) {
      if (run[i] <= riskWindow) continue
      for (let j = 0; j <= i; j++) {
        if (run[j] <= riskWindow) continue
        const value = (annualDays / (riskWindow - 1)) * (cross[i * n + j] - (sums[i] * sums[j]) / riskWindow)
        covariance[i * n + j] = covariance[j * n + i] = value
      }
      vol[i] = Math.sqrt(Math.max(0, covariance[i * n + i]))
    }
    const returns = new Map<number, Float64Array>(
      horizons.map((h) => [
        h,
        Float64Array.from(close, (c, i) => (run[i] > h ? c / sessions[t - h].close[i] - 1 : NaN)),
      ]),
    )
    const momentum = Float64Array.from(
      close,
      (_, i) => 12 * ret(returns, 21, i) + 4 * ret(returns, 63, i) + 2 * ret(returns, 126, i) + ret(returns, 252, i),
    )
    return { returns, momentum, covariance, vol }
  })
}

const ret = (returns: Features['returns'], h: number, i: number) => returns.get(h)?.[i] ?? NaN
const relative = (f: Features, h: number, long: Etf, short: Etf, omit: number) => {
  const a = asset(long)
  const b = asset(short)
  return a === omit || b === omit ? NaN : Math.log1p(ret(f.returns, h, a)) - Math.log1p(ret(f.returns, h, b))
}

const weighted = (
  target: Float64Array,
  basket: readonly Etf[],
  count: number,
  score: (i: number) => number,
  weight: (i: number) => number,
  budget: number,
  omit: number,
) => {
  if (budget === 0) return
  const ranked = basket
    .map(asset)
    .filter((i) => i !== omit)
    .map((i) => ({ i, score: score(i), weight: weight(i) }))
    .filter((r) => Number.isFinite(r.score) && Number.isFinite(r.weight) && r.weight > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, count)
  const total = ranked.reduce((sum, r) => sum + r.weight, 0)
  for (const { i, weight } of ranked) target[i] += (budget * weight) / total
}

const inverseVol = (f: Features, i: number) => 1 / Math.max(f.vol[i], 0.04)
const unboosted = () => 1
const covarianceOf = (a: Float64Array, b: Float64Array, covariance: Float64Array) => {
  let v = 0
  for (let i = 0; i < n; i++)
    if (a[i] !== 0) for (let j = 0; j < n; j++) if (b[j] !== 0) v += a[i] * b[j] * covariance[i * n + j]
  return v
}

export const canaryProtection = (scores: readonly number[], protection: 'binary' | 'breadth') => {
  const bad = scores.filter((score) => !Number.isFinite(score) || score <= 0).length
  return protection === 'binary' ? Number(bad > 0) : bad / scores.length
}

export const trendSignal = (r: readonly number[], vol: number) => {
  if (!Number.isFinite(vol) || r.some((x) => !Number.isFinite(x))) return 0
  const z = r.reduce(
    (sum, x, i) => sum + Math.log1p(x) / (Math.max(vol, 0.04) * Math.sqrt(horizons[i] / annualDays)),
    0,
  )
  return clamp(z / horizons.length, -1, 1)
}

export const macroRegime = (credit: number, inflation: number) => {
  if (!Number.isFinite(credit) || !Number.isFinite(inflation)) return null
  return credit > 0 ? (inflation > 0 ? 1 : 0) : inflation > 0 ? 2 : 3
}

const standalone = (trial: Standalone, omit: number) => {
  let held = zero()
  return (f: Features, t: number): Float64Array => {
    const w = zero()
    if (trial.kind === 'canary') {
      if (t < 252 || (t - 252) % trial.cadence !== 0) return held
      const available = canaries[trial.panel].map(asset).filter((i) => i !== omit)
      const protection = canaryProtection(
        available.map((i) => f.momentum[i]),
        trial.protection,
      )
      const weight = trial.weighting === 'equal' ? unboosted : (i: number) => inverseVol(f, i)
      weighted(w, offense, trial.offensive, (i) => f.momentum[i], weight, 1 - protection, omit)
      weighted(
        w,
        defense,
        trial.defensive,
        (i) => (f.momentum[i] > 0 ? f.momentum[i] : NaN),
        unboosted,
        protection,
        omit,
      )
      held = w
      return held
    }
    if (trial.kind === 'trend') {
      if (t < 252) return held
      for (const sleeve of trendSleeves) {
        const active = sleeve.map(asset).filter((i) => i !== omit)
        for (const i of active) {
          const signal = trendSignal(
            horizons.map((h) => ret(f.returns, h, i)),
            f.vol[i],
          )
          w[i] =
            ((trial.book === 'long' ? Math.max(signal, 0) : signal) * inverseVol(f, i)) /
            (active.length * trendSleeves.length)
        }
      }
      const gross = l1(w)
      const vol = Math.sqrt(Math.max(0, covarianceOf(w, w, f.covariance)))
      const scale = gross > 0 ? Math.min(trial.vol / Math.max(vol, 1e-12), 1 / gross) : 0
      return w.map((x) => x * scale)
    }
    if (trial.kind === 'macro') {
      const h = trial.horizon
      const credit = relative(f, h, 'HYG', 'IEF', omit)
      const pairs = [relative(f, h, 'GLD', 'TLT', omit), relative(f, h, 'DBC', 'IEF', omit)].filter(Number.isFinite)
      const inflation = pairs.reduce((sum, x) => sum + x, 0) / pairs.length
      const state = macroRegime(credit, inflation)
      if (state !== null) {
        const dollar = omit === asset('UUP') ? NaN : ret(f.returns, h, asset('UUP'))
        // A rising dollar reduces risk-on budget and doubles the positive dollar hedge in stagflation.
        const budget = state < 2 && dollar > 0 ? 0.75 : 1
        const basket = regimes[state].filter((symbol) => symbol !== 'UUP' || dollar > 0)
        weighted(
          w,
          basket,
          basket.length,
          (i) => (Number.isFinite(ret(f.returns, h, i)) ? 0 : NaN),
          (i) => (i === asset('UUP') ? 2 : 1),
          budget,
          omit,
        )
      }
      // EMA of one-hot target portfolios, including transition from cash; alpha = 2/(5+1).
      held = held.map((value, i) => value + (w[i] - value) / 3)
      return held
    }
    if (t < trial.horizon || (t - trial.horizon) % trial.cadence !== 0) return held
    const credit = relative(f, trial.horizon, 'HYG', 'IEF', omit)
    const market = omit === asset('SPY') ? NaN : ret(f.returns, trial.horizon, asset('SPY'))
    const universe = credit > 0 && market > 0 ? sectors : defensiveSectors
    const hurdle = omit === shy ? 0 : ret(f.returns, trial.horizon, shy)
    weighted(
      w,
      universe,
      trial.top,
      (i) => {
        const excess = ret(f.returns, trial.horizon, i) - hurdle
        return excess > 0 ? excess * inverseVol(f, i) : NaN
      },
      unboosted,
      1,
      omit,
    )
    held = w
    return held
  }
}

// Cyclic coordinate descent for positive risk-budget weights with the same fixed budget per active sleeve.
export const riskParity = (covariance: readonly (readonly number[])[]) => {
  const w = covariance.map((row, i) => 1 / Math.sqrt(row[i]))
  for (let pass = 0; pass < 32; pass++) {
    for (let i = 0; i < w.length; i++) {
      const a = covariance[i][i]
      const b = covariance[i].reduce((sum, c, j) => sum + (i === j ? 0 : c * w[j]), 0)
      const root = Math.sqrt(b * b + 4 * a)
      w[i] = b >= 0 ? 2 / (b + root) : (root - b) / (2 * a)
    }
  }
  const sum = w.reduce((s, x) => s + x, 0)
  return w.map((x) => x / sum)
}

export const executionRule = (trial: Trial, prior: number) => {
  if (trial.kind === 'trend')
    return { review: prior >= 252, scheduled: prior >= 252 && (prior - 252) % trial.cadence === 0, band: trial.band }
  if (trial.kind === 'macro')
    return {
      review: prior >= trial.horizon && (prior - trial.horizon) % trial.review === 0,
      scheduled: false,
      band: trial.band,
    }
  if (trial.kind === 'ensemble')
    return { review: prior >= 252 && (prior - 252) % trial.cadence === 0, scheduled: false, band: trial.band }
  const start = trial.kind === 'canary' ? 252 : trial.horizon
  const scheduled = prior >= start && (prior - start) % trial.cadence === 0
  return { review: scheduled, scheduled, band: 0 }
}

export const targets = (trial: Trial, data: readonly Features[], omit: number) => {
  if (trial.kind !== 'ensemble') return data.map(standalone(trial, omit))
  const canary = standalone(
    {
      ...ensembleCanary,
      offensive: trial.variant === 'offensive2' ? 2 : trial.variant === 'offensive4' ? 4 : 3,
    },
    omit,
  )
  const trend = standalone({ ...ensembleTrend, vol: trial.variant === 'trend10vol' ? 0.1 : 0.08 }, omit)
  const macro = standalone({ ...ensembleMacro, horizon: trial.variant === 'macro126' ? 126 : 63 }, omit)
  return data.map((f, t) => {
    const signals = [canary(f, t), trend(f, t), macro(f, t)]
    if (!executionRule(trial, t).review) return zero()
    const active = signals.filter((w) => l1(w) > 1e-10)
    const cov = active.map((a, i) =>
      active.map((b, j) => covarianceOf(a, b, f.covariance) * (i === j ? 1 : 0.75) + (i === j ? 0.02 ** 2 : 0)),
    )
    const weights = riskParity(cov)
    return Float64Array.from(
      etfs,
      (_, i) => (active.reduce((sum, w, k) => sum + weights[k] * w[i], 0) * active.length) / signals.length,
    )
  })
}
