import { annualDays, bootstrap } from './etf-canary-macro-protocol'
import type { Marks, Path } from './etf-canary-macro-replay'
import { dailySharpe, deflatedSharpe } from './research-orb-zab-statistics'

const sum = (a: readonly number[]) => a.reduce((s, x) => s + x, 0)
const wealth = (a: readonly number[]) => a.reduce((p, x) => p * (1 + x), 1)
export type Window = { name: string; first: number; end: number }

export const stationaryBlocks = (n: number, draws = bootstrap.draws, blockDays = bootstrap.blockDays) => {
  let state: number = bootstrap.seed
  const uniform = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) + 0.5) / 2 ** 32
  }
  const p = Math.log1p(-1 / blockDays)
  const blocks: number[] = []
  for (let draw = 0; draw < draws; draw++) {
    let left = n
    while (left > 0) {
      const start = Math.floor(uniform() * n)
      const len = Math.min(left, 1 + Math.floor(Math.log(uniform()) / p))
      blocks.push(start, start + len)
      left -= len
    }
  }
  return Int32Array.from(blocks)
}

export const bootstrapP = (excess: readonly number[], blocks: Int32Array) => {
  const n = excess.length
  const observed = sum(excess)
  if (excess.every((x) => x === 0)) return 1
  const mean = observed / n
  const prefix = new Float64Array(2 * n + 1)
  for (let i = 0; i < 2 * n; i++) prefix[i + 1] = prefix[i] + excess[i % n] - mean
  let tails = 0
  let sampled = 0
  let length = 0
  let draws = 0
  for (let i = 0; i < blocks.length; i += 2) {
    sampled += prefix[blocks[i + 1]] - prefix[blocks[i]]
    length += blocks[i + 1] - blocks[i]
    if (length === n) {
      tails += Number(sampled >= observed)
      sampled = 0
      length = 0
      draws++
    }
  }
  return (1 + tails) / (1 + draws)
}

const compare = (net: readonly number[], cash: readonly number[], spy: readonly number[], turnover: number) => {
  const n = net.length
  const total = wealth(net) - 1
  const benchmark = wealth(cash) - 1
  const excess = net.map((r, i) => r - cash[i])
  let nav = 1
  let peak = 1
  let maxDD = 0
  let downNet = 1
  let downShy = 1
  let cross = 0
  let marketVariance = 0
  const mean = sum(net) / n
  const marketMean = sum(spy) / n
  for (let i = 0; i < n; i++) {
    nav *= 1 + net[i]
    peak = Math.max(peak, nav)
    maxDD = Math.max(maxDD, 1 - nav / peak)
    const deviation = spy[i] - marketMean
    marketVariance += deviation * deviation
    cross += (net[i] - mean) * deviation
    if (spy[i] < 0) {
      downNet *= 1 + net[i]
      downShy *= 1 + cash[i]
    }
  }
  const order = net
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r > 0)
    .sort((a, b) => b.r - a.r || a.i - b.i)
  const without = (count: number) => {
    const exclude = new Set(order.slice(0, count).map(({ i }) => i))
    // Use the same retained dates on both legs; don't replace unusually good days by imaginary fills.
    const a = wealth(net.filter((_, i) => !exclude.has(i)))
    const b = wealth(cash.filter((_, i) => !exclude.has(i)))
    return { net: a - 1, excessVsShy: a - b }
  }
  const sharpe = dailySharpe(net)
  const excessSharpe = dailySharpe(excess)
  return {
    net: total,
    excessVsShy: total - benchmark,
    exTop5: without(5),
    exTop10: without(10),
    annualSharpe: sharpe === null ? null : sharpe * Math.sqrt(annualDays),
    annualExcessSharpe: excessSharpe === null ? null : excessSharpe * Math.sqrt(annualDays),
    maxDrawdown: maxDD,
    calmar: maxDD > 0 ? ((1 + total) ** (annualDays / n) - 1) / maxDD : null,
    turnoverPerYear: (turnover * annualDays) / n,
    spyBeta: marketVariance > 0 ? cross / marketVariance : null,
    downSpyNet: downNet - 1,
    downSpyExcessVsShy: downNet - downShy,
  }
}

const returns = (path: Path, w: Window) => Array.from(path.net.subarray(w.first, w.end))
const turnover = (path: Path, w: Window) => path.turnover.subarray(w.first, w.end).reduce((a, b) => a + b, 0)

export const summarize = (
  withShy: Path,
  zeroCash: Path,
  prices: Marks,
  w: Window,
  benchmark: number | null,
  blocks?: Int32Array,
) => {
  const days = prices.slice(w.first, w.end)
  const cash = days.map((d) => d.shy)
  const spy = days.map((d) => d.spy)
  const net = returns(withShy, w)
  const excess = net.map((r, i) => r - cash[i])
  return {
    sessions: days.length,
    buyHoldShy: wealth(cash) - 1,
    withShy: compare(net, cash, spy, turnover(withShy, w)),
    zeroCash: compare(returns(zeroCash, w), cash, spy, turnover(zeroCash, w)),
    pStationary: blocks === undefined ? null : bootstrapP(excess, blocks),
    cumulativeDsr: deflatedSharpe(excess, benchmark),
  }
}

export const omitted = (withShy: Path, zeroCash: Path, prices: Marks, w: Window) => {
  const a = wealth(returns(withShy, w)) - 1
  const b = wealth(returns(zeroCash, w)) - 1
  const cash = wealth(prices.slice(w.first, w.end).map((d) => d.shy)) - 1
  return [a, b, a - cash, (turnover(withShy, w) * annualDays) / (w.end - w.first)]
}

export const passes = (summary: ReturnType<typeof summarize>, cap: number) =>
  summary.withShy.excessVsShy > 0 &&
  summary.withShy.exTop5.excessVsShy > 0 &&
  summary.withShy.exTop10.excessVsShy > 0 &&
  summary.withShy.turnoverPerYear < cap
