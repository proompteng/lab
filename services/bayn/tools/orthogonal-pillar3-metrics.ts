import { type stationaryPlan } from './8yr-unseen-intraday-statistics'
import { dailySharpe, quantile, sum } from './midday-research-statistics'
import { type Day, beta } from './orthogonal-pillar3-replay'

const sessionsPerYear = 252
const annualization = Math.sqrt(sessionsPerYear)
export const compound = (values: readonly number[]) => values.reduce((nav, value) => nav * (1 + value), 1) - 1

export const metrics = (days: readonly Day[], shy: readonly number[], spy: readonly number[]) => {
  const values = days.map(({ net }) => net)
  const excess = values.map((value, i) => value - shy[i])
  const daily = dailySharpe(values)
  const active = dailySharpe(excess)
  const top = new Set(
    excess
      .map((_, i) => i)
      .filter((i) => excess[i] > 0)
      .sort((a, b) => excess[b] - excess[a])
      .slice(0, 10),
  )
  let nav = 1
  let peak = 1
  let maxDrawdown = 0
  for (const value of values) {
    nav *= 1 + value
    peak = Math.max(peak, nav)
    maxDrawdown = Math.max(maxDrawdown, 1 - nav / peak)
  }
  const cagr = nav ** (sessionsPerYear / days.length) - 1
  return {
    net: nav - 1,
    excess: nav - 1 - compound(shy),
    exTop10Excess: compound(values.filter((_, i) => !top.has(i))) - compound(shy.filter((_, i) => !top.has(i))),
    cagr,
    sharpe: daily === null ? null : daily * annualization,
    excessSharpe: active === null ? null : active * annualization,
    maxDrawdown,
    calmar: maxDrawdown === 0 ? null : cagr / maxDrawdown,
    turnover: (sum(days.map((day) => day.turnover)) * sessionsPerYear) / days.length,
    borrow: sum(days.map((day) => day.borrow)),
    spyBeta: beta(values, spy),
  }
}

export const blend = (sleeves: readonly (readonly Day[])[], weights: readonly number[], bp: number): Day[] => {
  if (
    sleeves.length !== weights.length ||
    sleeves.length === 0 ||
    Math.abs(sum(weights) - 1) > 1e-12 ||
    weights.some((weight) => !Number.isFinite(weight) || weight < 0) ||
    sleeves.some((days) => days.length !== sleeves[0].length)
  )
    throw new Error('Invalid capital blend')
  let before = weights
  return sleeves[0].map((_, i) => {
    const transfer = sum(weights.map((weight, j) => Math.abs(weight - before[j])))
    const first = 1 - (transfer * bp) / 10_000
    const gross = sum(sleeves.map((days, j) => weights[j] * (1 + days[i].net)))
    if (!(first * gross > 0)) throw new Error('Insolvent sleeve blend')
    before = sleeves.map((days, j) => (weights[j] * (1 + days[i].net)) / gross)
    return {
      net: first * gross - 1,
      turnover: transfer / 2 + first * sum(sleeves.map((days, j) => days[i].turnover * weights[j])),
      borrow: first * sum(sleeves.map((days, j) => days[i].borrow * weights[j])),
    }
  })
}

export const underwater = (spy: readonly number[]) => {
  let nav = 1
  let peak = 1
  return spy.map((value) => {
    nav *= 1 + value
    peak = Math.max(peak, nav)
    return nav < peak
  })
}

export const pairedSharpe = (
  strategy: readonly number[],
  reference: readonly number[],
  plan: ReturnType<typeof stationaryPlan>,
) => {
  const n = plan.sessions
  if (strategy.length !== n || reference.length !== n) throw new Error('Paired Sharpe length mismatch')
  const a = dailySharpe(strategy)
  const b = dailySharpe(reference)
  if (a === null || b === null) return null
  const observed = (a - b) * annualization
  const resample = (values: readonly number[]) => {
    const sums = new Float64Array(2 * n + 1)
    const squares = new Float64Array(2 * n + 1)
    for (let i = 0; i < 2 * n; i++) {
      const value = values[i % n]
      sums[i + 1] = sums[i] + value
      squares[i + 1] = squares[i] + value * value
    }
    return (draw: number) => {
      let total = 0
      let squared = 0
      for (let i = plan.offsets[draw]; i < plan.offsets[draw + 1]; i++) {
        const block = plan.blocks[i]
        const start = block >>> 16
        const end = start + (block & 0xffff)
        total += sums[end] - sums[start]
        squared += squares[end] - squares[start]
      }
      const variance = (squared - total ** 2 / n) / (n - 1)
      return variance > 0 ? (total / n / Math.sqrt(variance)) * annualization : null
    }
  }
  const left = resample(strategy)
  const right = resample(reference)
  const errors: number[] = []
  for (let draw = 0; draw < plan.draws; draw++) {
    const lhs = left(draw)
    const rhs = right(draw)
    if (lhs === null || rhs === null) return null
    errors.push(lhs - rhs - observed)
  }
  const upperError = quantile(errors, 0.95)
  return upperError === null
    ? null
    : {
        sharpeLift: observed,
        lower95: observed - upperError,
        p: (1 + errors.filter((error) => error >= observed).length) / (plan.draws + 1),
      }
}
