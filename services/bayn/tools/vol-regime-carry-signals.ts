import { type Session, type Symbol, assets, universe } from './vol-regime-carry-data'

export const annualDays = 252
export const warmup = 100
export const band = 0.1
export const costs = [2, 5, 10, 20] as const
const budgets = [['SPY', 'QQQ', 'EFA', 'EEM'], ['IEF', 'TLT'], ['GLD'], ['DBC'], ['UUP']] as const
const havens = ['SHY', 'IEF', 'TLT', 'GLD', 'DBC', 'UUP'] as const
const riskOn = [
  {
    budget: 0.8,
    members: [
      'SPY',
      'QQQ',
      'IWM',
      'DIA',
      'SMH',
      'EFA',
      'EEM',
      'VNQ',
      'XLK',
      'XLF',
      'XLV',
      'XLY',
      'XLC',
      'XLI',
      'XLP',
      'XLE',
      'XLU',
      'XLRE',
      'XLB',
    ],
  },
  { budget: 0.1, members: ['HYG', 'LQD'] },
  { budget: 0.1, members: ['SLV', 'USO'] },
] satisfies { budget: number; members: Symbol[] }[]

type Cadence = 21 | 42
type Credit = 'IEF' | 'LQD'
type Term = 'fast' | 'slow' | 'both'
type Power = 1 | 2
type F1 = { family: 'F1'; cadence: Cadence; power: Power; rv: 20 | 60; target: 0.08 | 0.1 }
type Control = { family: 'F1'; cadence: Cadence; power: 0 }
type F2 = { family: 'F2'; cadence: Cadence; credit: Credit; ema: 50 | 100; smooth: 5 | 10 }
type F3 = { family: 'F3'; cadence: Cadence; term: Term; cut: 0.5 | 0.75 }
type F4 = { family: 'F4'; cadence: Cadence; power: Power; credit: Credit; mix: 'equal' | 'parity' }
export type Trial = F1 | Control | F2 | F3 | F4
const cadences = [21, 42] as const
const powers = [1, 2] as const
const credits = ['IEF', 'LQD'] as const

export const trials: Trial[] = []
for (const cadence of cadences) {
  trials.push({ family: 'F1', cadence, power: 0 })
  for (const power of powers)
    for (const rv of [20, 60] as const)
      for (const target of [0.08, 0.1] as const) trials.push({ family: 'F1', cadence, power, rv, target })
  for (const credit of credits)
    for (const ema of [50, 100] as const)
      for (const smooth of [5, 10] as const) trials.push({ family: 'F2', cadence, credit, ema, smooth })
  for (const term of ['fast', 'slow', 'both'] as const)
    for (const cut of [0.5, 0.75] as const) trials.push({ family: 'F3', cadence, term, cut })
  for (const power of powers)
    for (const credit of credits)
      for (const mix of ['equal', 'parity'] as const) trials.push({ family: 'F4', cadence, power, credit, mix })
}

export const trialId = (trial: Trial) => Object.values(trial).join('-')
const axes = (trial: Trial): readonly (string | number)[] => Object.values(trial)
export const neighbors = trials.map((trial, i) =>
  trials.flatMap((peer, j) => {
    if (i === j || trial.family !== peer.family) return []
    const first = axes(trial)
    const second = axes(peer)
    return first.length === second.length && first.filter((value, index) => value !== second[index]).length === 1
      ? [j]
      : []
  }),
)

export const weights = () => Array<number>(universe.length).fill(0)
const clamp = (value: number) => Math.min(1, Math.max(0, value))

type Matrix = number[][]
// Positive cyclic coordinate descent: solve x_i (Σx)_i = b_i, then normalize.
export const riskParity = (covariance: Matrix, budget: number[]) => {
  const x = budget.map((b, i) => Math.sqrt(b / covariance[i][i]))
  for (let pass = 0; pass < 48; pass++) {
    for (let i = 0; i < x.length; i++) {
      const diagonal = covariance[i][i]
      const other = x.reduce((sum, value, j) => (i === j ? sum : sum + covariance[i][j] * value), 0)
      const root = Math.sqrt(other * other + 4 * diagonal * budget[i])
      x[i] = other > 0 ? (2 * budget[i]) / (root + other) : (root - other) / (2 * diagonal)
    }
  }
  const total = x.reduce((sum, value) => sum + value, 0)
  return x.map((value) => value / total)
}

const product = (covariance: Matrix, x: number[]) =>
  x.reduce(
    (variance, weight, i) => variance + weight * x.reduce((row, value, j) => row + value * covariance[i][j], 0),
    0,
  )

export const volatilityScale = (target: number, rv: number, power: Power) =>
  clamp((target / Math.max(rv, 0.04)) ** power)
export const compressionScale = (term: Term, cut: 0.5 | 0.75, rv: [number, number, number]) => {
  const fast = rv[0] > 1.25 * rv[1]
  const slow = rv[1] > 1.25 * rv[2]
  return term === 'both'
    ? 1 - (cut * (Number(fast) + Number(slow))) / 2
    : 1 - cut * Number(term === 'fast' ? fast : slow)
}

const riskBasis = (sessions: readonly Session[], omitted: Symbol | undefined) => {
  const available = budgets
    .map((sleeve) => sleeve.filter((symbol) => symbol !== omitted))
    .filter((sleeve) => sleeve.length > 0)
  const indices = available.flat().map((symbol) => assets[symbol])
  const budget = available.flatMap((sleeve) => sleeve.map(() => 1 / (available.length * sleeve.length)))
  const logReturns = indices.map((index) =>
    sessions.map(({ bars }, i) => {
      if (i === 0) return 0
      const current = bars[index]
      const previous = sessions[i - 1].bars[index]
      if (current === undefined || previous === undefined)
        throw new Error(`Missing risk parity input: ${universe[index]} ${sessions[i].date}`)
      return Math.log(current.close / previous.close)
    }),
  )
  const prefix = (values: number[]) => {
    const sums = [0]
    for (const v of values) sums.push(sums[sums.length - 1] + v)
    return sums
  }
  const sums = logReturns.map(prefix)
  const products = logReturns.map((a, i) => logReturns.slice(0, i + 1).map((b) => prefix(a.map((v, t) => v * b[t]))))
  const trailing = (series: number[], t: number, n: number) => (series[t + 1] - series[t + 1 - n]) / n
  const covariance = (t: number, n: number) =>
    indices.map((_, i) =>
      indices.map(
        (__, j) =>
          trailing(products[Math.max(i, j)][Math.min(i, j)], t, n) - trailing(sums[i], t, n) * trailing(sums[j], t, n),
      ),
    )
  return sessions.map((_, t) => {
    if (t < warmup - 1) return undefined
    const long = covariance(t, 60)
    const shrunk = long.map((row, i) => row.map((value, j) => (i === j ? value + 0.02 ** 2 / annualDays : value * 0.8)))
    const core = riskParity(shrunk, budget)
    const rv: [number, number, number] = [covariance(t, 5), covariance(t, 20), long].map((matrix) =>
      Math.sqrt(Math.max(0, product(matrix, core)) * annualDays),
    ) as [number, number, number]
    const base = weights()
    indices.forEach((index, i) => {
      base[index] = core[i]
    })
    return { base, rv }
  })
}

export const trendSeries = (values: (number | undefined)[], window: number) => {
  let ema = 0
  let seen = 0
  return values.map((value) => {
    if (value === undefined) {
      seen = 0
      ema = 0
      return undefined
    }
    seen++
    // Seed on the initial full window's arithmetic mean.
    ema += (value - ema) * (seen <= window ? 1 / seen : 2 / (window + 1))
    return seen >= window ? value / ema - 1 : undefined
  })
}

export const defensiveWinner = (trend: (numerator: Symbol, denominator?: Symbol) => number | undefined) => {
  const votes = (pairs: readonly (readonly [Symbol, Symbol])[]) =>
    pairs.reduce((sum, [a, b]) => sum + Math.sign(trend(a, b) ?? 0), 0)
  const duration = votes([
    ['TLT', 'IEF'],
    ['TLT', 'SHY'],
  ])
  const inflation = votes([
    ['DBC', 'TLT'],
    ['GLD', 'TLT'],
  ])
  const dollar = trend('UUP', 'SHY')
  let best: Symbol | undefined
  let highest = 0
  for (const symbol of havens) {
    if (
      (symbol === 'TLT' && (duration < 0 || inflation > 0)) ||
      (symbol === 'IEF' && duration < 0 && inflation > 0) ||
      (symbol === 'DBC' && inflation < 0) ||
      (symbol === 'UUP' && dollar !== undefined && dollar <= 0)
    )
      continue
    const score = trend(symbol)
    if (score !== undefined && score > highest) {
      best = symbol
      highest = score
    }
  }
  return best
}

export const creditAllocation = (primary: number | undefined, secondary: number | undefined) => {
  const primaryMass = primary === undefined ? 0 : 2
  const secondaryMass = secondary === undefined ? 0 : 1
  if (primaryMass + secondaryMass === 0) return 0
  return (
    (Number((primary ?? 0) > 0) * primaryMass + Number((secondary ?? 0) > 0) * secondaryMass) /
    (primaryMass + secondaryMass)
  )
}

export const signalModel = (sessions: readonly Session[], omitted?: Symbol) => {
  const core = riskBasis(sessions, omitted)
  const trends = new Map<string, (number | undefined)[]>()
  const macroPaths = new Map<string, number[][]>()
  const consecutive = universe.map((symbol, i) => {
    let seen = 0
    return sessions.map(({ bars }) => {
      seen = symbol !== omitted && bars[i] !== undefined ? seen + 1 : 0
      return seen
    })
  })
  const trend = (a: Symbol, b: Symbol | undefined, window: number) => {
    const key = `${a}/${b ?? ''}/${window}`
    const existing = trends.get(key)
    if (existing !== undefined) return existing
    const values = sessions.map(({ bars }) => {
      const left = a === omitted ? undefined : bars[assets[a]]?.close
      if (left === undefined || (b === omitted && b !== undefined)) return undefined
      if (b === undefined) return left
      const right = bars[assets[b]]?.close
      return right === undefined ? undefined : left / right
    })
    const series = trendSeries(values, window)
    trends.set(key, series)
    return series
  }
  const macro = (credit: Credit, ema: 50 | 100, smooth: 5 | 10) => {
    const key = `${credit}/${ema}/${smooth}`
    const existing = macroPaths.get(key)
    if (existing !== undefined) return existing
    let prior = weights()
    const path = sessions.map((_, t) => {
      if (t < warmup - 1) return prior
      const at = (a: Symbol, b?: Symbol) => trend(a, b, ema)[t]
      const defensive = defensiveWinner(at)
      const offense = creditAllocation(at('HYG', credit), at('HYG', credit === 'IEF' ? 'LQD' : 'IEF'))
      const next = weights()
      for (const group of riskOn) {
        const eligible = group.members.filter((symbol) => consecutive[assets[symbol]][t] >= 20)
        for (const symbol of eligible) next[assets[symbol]] = (offense * group.budget) / eligible.length
      }
      if (defensive !== undefined) next[assets[defensive]] = 1 - offense
      prior = next.map((value, i) => prior[i] + (2 / (smooth + 1)) * (value - prior[i]))
      return prior
    })
    macroPaths.set(key, path)
    return path
  }
  return (trial: Trial) => {
    const macroPath =
      trial.family === 'F2'
        ? macro(trial.credit, trial.ema, trial.smooth)
        : trial.family === 'F4'
          ? macro(trial.credit, 100, 10)
          : undefined
    return sessions.map((_, t) => {
      const risk = core[t]
      if (risk === undefined || (t - warmup + 1) % trial.cadence !== 0) return undefined
      if (trial.family === 'F2') return macroPath?.[t]
      const { rv, base } = risk
      if (trial.family === 'F1') {
        if (trial.power === 0) return base
        const scale = volatilityScale(trial.target, rv[trial.rv === 20 ? 1 : 2], trial.power)
        return base.map((weight) => weight * scale)
      }
      const volTarget = volatilityScale(0.1, rv[2], 1)
      if (trial.family === 'F3') {
        const scale = volTarget * compressionScale(trial.term, trial.cut, rv)
        return base.map((weight) => weight * scale)
      }
      const f1 = volatilityScale(0.1, rv[1], trial.power)
      const f3 = volTarget * compressionScale('both', 0.5, rv)
      const [w1, w2, w3] = trial.mix === 'equal' ? [1 / 3, 1 / 3, 1 / 3] : [0.5, 0.25, 0.25]
      const defensive = macroPath?.[t]
      if (defensive === undefined) throw new Error('Missing ensemble macro weights')
      return base.map((weight, i) => weight * (w1 * f1 + w3 * f3) + w2 * defensive[i])
    })
  }
}
