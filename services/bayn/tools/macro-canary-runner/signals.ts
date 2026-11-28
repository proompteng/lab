import { Result } from 'effect'

import { failure } from './contract'

// Wave 5D's frozen base trial (proompteng/lab#16376).
export const wave5dRevision = '12529c2cd54bcfc2f9f6ae8e4a11ab07817f9c54'
// Keep universe order: the reference uses it to resolve equal momentum scores.
export const etfs = [
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  'XLK',
  'XLF',
  'XLE',
  'XLV',
  'XLI',
  'XLP',
  'XLU',
  'XLY',
  'XLB',
  'XLC',
  'XLRE',
  'TLT',
  'IEF',
  'SHY',
  'HYG',
  'LQD',
  'GLD',
  'SLV',
  'DBC',
  'USO',
  'UUP',
  'EFA',
  'EEM',
] as const
export type Etf = (typeof etfs)[number]
export const anchorDate = '2016-01-04'
export const historyLength = 320
export const reviewCadence = 21
const horizons = [21, 63, 126, 252] as const
const annualDays = 252
const riskWindow = 63
const macroHorizon = 63
export const macroInputs = ['HYG', 'IEF', 'GLD', 'TLT', 'DBC', 'UUP'] as const
type MacroInput = (typeof macroInputs)[number]
const canaries = ['EEM', 'HYG', 'IEF', 'TLT'] as const
const offense = ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'GLD', 'DBC', 'XLK', 'XLE', 'XLF', 'XLV'] as const
const defense = ['SHY', 'IEF', 'TLT', 'GLD', 'UUP', 'DBC'] as const
const trendSleeves = [
  ['SPY', 'QQQ', 'EFA', 'EEM'],
  ['TLT', 'IEF'],
  ['HYG', 'LQD'],
  ['GLD', 'SLV', 'DBC'],
  ['UUP'],
] as const
const regimes = [
  { name: 'Goldilocks', basket: ['QQQ', 'SPY', 'XLK', 'IEF'] },
  { name: 'Reflation', basket: ['XLE', 'DBC', 'GLD', 'XLI', 'SPY'] },
  { name: 'Stagflation', basket: ['UUP', 'GLD', 'DBC', 'SHY'] },
  { name: 'Deflation', basket: ['TLT', 'IEF', 'GLD', 'SHY'] },
] as const

export type Session = { date: string; closes: ReadonlyMap<Etf, number> }
const asset = (symbol: Etf) => etfs.indexOf(symbol)
const zero = () => new Float64Array(etfs.length)
const gross = (weights: Float64Array) => weights.reduce((sum, x) => sum + Math.abs(x), 0)
const vector = (values: Float64Array) => etfs.map((symbol, i) => ({ symbol, value: values[i] }))
const close = (session: Session, symbol: MacroInput) => session.closes.get(symbol) ?? NaN
const covarianceOf = (a: Float64Array, b: Float64Array, covariance: Float64Array) => {
  let value = 0
  for (let i = 0; i < etfs.length; i++)
    if (a[i] !== 0)
      for (let j = 0; j < etfs.length; j++) if (b[j] !== 0) value += a[i] * b[j] * covariance[i * etfs.length + j]
  return value
}

const riskParity = (covariance: readonly (readonly number[])[]) => {
  const weights = covariance.map((row, i) => 1 / Math.sqrt(row[i]))
  for (let pass = 0; pass < 32; pass++) {
    for (let i = 0; i < weights.length; i++) {
      const a = covariance[i][i]
      const b = covariance[i].reduce((sum, c, j) => sum + (i === j ? 0 : c * weights[j]), 0)
      const root = Math.sqrt(b * b + 4 * a)
      weights[i] = b >= 0 ? 2 / (b + root) : (root - b) / (2 * a)
    }
  }
  const sum = weights.reduce((total, value) => total + value, 0)
  return weights.map((value) => value / sum)
}

const macro = (sessions: readonly Session[], t: number) => {
  const ret = (symbol: MacroInput) => close(sessions[t], symbol) / close(sessions[t - macroHorizon], symbol) - 1
  const relative = (a: MacroInput, b: MacroInput) => Math.log1p(ret(a)) - Math.log1p(ret(b))
  const credit = relative('HYG', 'IEF')
  const inflation = (relative('GLD', 'TLT') + relative('DBC', 'IEF')) / 2
  const dollar = ret('UUP')
  const quadrant = credit > 0 ? (inflation > 0 ? 1 : 0) : inflation > 0 ? 2 : 3
  const { name, basket } = regimes[quadrant]
  const budget = quadrant < 2 && dollar > 0 ? 0.75 : 1
  const active = basket.filter((symbol) => symbol !== 'UUP' || dollar > 0)
  const units = active.length + Number(quadrant === 2 && dollar > 0)
  const weights = zero()
  for (const symbol of active) weights[asset(symbol)] = (budget * (symbol === 'UUP' ? 2 : 1)) / units
  return { quadrant: name, credit, inflation, dollar, weights }
}

const closeFeatures = (sessions: readonly Session[], t: number) => {
  const n = etfs.length
  const sums = zero()
  const cross = new Float64Array(n * n)
  const price = (index: number, symbol: Etf) => sessions[index].closes.get(symbol) ?? NaN
  for (let k = t - riskWindow + 1; k <= t; k++) {
    const returns = etfs.map((symbol) => Math.log(price(k, symbol) / price(k - 1, symbol)))
    for (let i = 0; i < n; i++) {
      sums[i] += returns[i]
      for (let j = 0; j <= i; j++) cross[i * n + j] += returns[i] * returns[j]
    }
  }
  const covariance = new Float64Array(n * n)
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++)
      covariance[i * n + j] = covariance[j * n + i] =
        (annualDays / (riskWindow - 1)) * (cross[i * n + j] - (sums[i] * sums[j]) / riskWindow)
  const volatility = (i: number) => Math.max(Math.sqrt(Math.max(0, covariance[i * n + i])), 0.04)
  const inverseVol = (i: number) => 1 / volatility(i)
  const returns = etfs.map((symbol) => horizons.map((h) => price(t, symbol) / price(t - h, symbol) - 1))
  const momentum = returns.map(([r21, r63, r126, r252]) => 12 * r21 + 4 * r63 + 2 * r126 + r252)
  const trendScores = returns.map((r, i) => {
    const z = r.reduce((sum, x, j) => sum + Math.log1p(x) / (volatility(i) * Math.sqrt(horizons[j] / annualDays)), 0)
    return Math.min(1, Math.max(-1, z / horizons.length))
  })
  const canaryStatuses = canaries.map((symbol) => ({
    symbol,
    score: momentum[asset(symbol)],
    protective: momentum[asset(symbol)] <= 0,
  }))
  const protection = canaryStatuses.filter((status) => status.protective).length / canaries.length
  const canaryWeights = zero()
  const rank = (basket: readonly Etf[]) => basket.map(asset).sort((a, b) => momentum[b] - momentum[a] || a - b)
  const offensive = rank(offense).slice(0, 3)
  const defensive = rank(defense)
    .filter((i) => momentum[i] > 0)
    .slice(0, 2)
  const units = offensive.reduce((sum, i) => sum + inverseVol(i), 0)
  for (const i of offensive) canaryWeights[i] = ((1 - protection) * inverseVol(i)) / units
  for (const i of defensive) canaryWeights[i] += protection / defensive.length

  const trendWeights = zero()
  for (const sleeve of trendSleeves) {
    for (const symbol of sleeve) {
      const i = asset(symbol)
      trendWeights[i] = (Math.max(trendScores[i], 0) * inverseVol(i)) / (sleeve.length * trendSleeves.length)
    }
  }
  const trendGross = gross(trendWeights)
  const trendVol = Math.sqrt(Math.max(0, covarianceOf(trendWeights, trendWeights, covariance)))
  const trendScale = trendGross > 0 ? Math.min(0.08 / Math.max(trendVol, 1e-12), 1 / trendGross) : 0
  return {
    canaryStatuses,
    protection,
    trendScores,
    covariance,
    canaryWeights,
    trendWeights: trendWeights.map((w) => w * trendScale),
  }
}

export const computeSignals = (older: readonly Session[], recent: readonly Session[]) => {
  const sessions = [...older, ...recent]
  const last = sessions.length - 1
  const review = last - ((last - annualDays) % reviewCadence)
  const reviewedAt = sessions[review]?.date
  if (review - older.length < annualDays || reviewedAt === undefined)
    return Result.fail(failure('signal', 'Insufficient history for the anchored Wave 5D review'))
  const daily = closeFeatures(recent, recent.length - 1)
  const decision = review === last ? daily : closeFeatures(recent, review - older.length)
  let macroWeights = zero()
  // The macro sleeve starts from cash at the study anchor, not at the rolling fetch boundary.
  for (let i = macroHorizon; i <= review; i++) {
    const next = macro(sessions, i).weights
    macroWeights = macroWeights.map((value, j) => value + (next[j] - value) / 3)
  }
  const sleeves = [
    { name: 'canary', weights: decision.canaryWeights },
    { name: 'tsmom', weights: decision.trendWeights },
    { name: 'macro', weights: macroWeights },
  ]
  const active = sleeves.filter(({ weights }) => gross(weights) > 1e-10)
  const cov = active.map(({ weights: a }, i) =>
    active.map(
      ({ weights: b }, j) => covarianceOf(a, b, decision.covariance) * (i === j ? 1 : 0.75) + (i === j ? 0.02 ** 2 : 0),
    ),
  )
  const budgets = riskParity(cov)
  const weights = Float64Array.from(
    etfs,
    (_, i) =>
      (active.reduce((sum, sleeve, k) => sum + budgets[k] * sleeve.weights[i], 0) * active.length) / sleeves.length,
  )
  const idleShyWeight = Math.max(0, 1 - gross(weights))
  weights[asset('SHY')] += idleShyWeight
  const { weights: dailyMacroWeights, ...dailyMacro } = macro(sessions, last)
  if (weights.some((w) => !Number.isFinite(w) || w < 0) || Math.abs(gross(weights) - 1) > 1e-9)
    return Result.fail(failure('signal', 'Wave 5D weights failed long-only unit-gross validation'))
  return Result.succeed({
    reviewedAt,
    reviewDue: review === last,
    canaries: daily.canaryStatuses,
    canaryProtection: daily.protection,
    tsmomScores: vector(Float64Array.from(daily.trendScores)),
    macro: { ...dailyMacro, unsmoothedWeights: vector(dailyMacroWeights) },
    sleeves: sleeves.map((sleeve) => ({
      name: sleeve.name,
      riskBudget: ((budgets[active.indexOf(sleeve)] ?? 0) * active.length) / sleeves.length,
      weights: vector(sleeve.weights),
    })),
    idleShyWeight,
    targetWeights: etfs.map((symbol, i) => ({ symbol, weight: weights[i] })),
  })
}
