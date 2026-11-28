import { dailySharpe, deflatedSharpe, mean, sum } from './midday-research-statistics'
import { capital, costs, netAt, type Ledger } from './noise-area-study-replay'

export const draws = 10_000
export const meanBlockSessions = 5
export const bootstrapSeed = 0x6a202611

// Politis–Romano stationary bootstrap: each next index continues the circular block with
// probability 0.8, otherwise starts uniformly. Cache the same draws for all paired series.
export const stationaryBootstrap = (length: number, trials = draws) => {
  if (!Number.isInteger(length) || length < 1 || !Number.isInteger(trials) || trials < 1)
    throw new Error('Invalid bootstrap sample or draw count')
  let state = bootstrapSeed
  const uniform = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 2 ** 32
  }
  const blocks = new Uint32Array(trials * length)
  const ends = new Uint32Array(trials)
  let cursor = 0
  for (let trial = 0; trial < trials; trial++) {
    let remaining = length
    while (remaining > 0) {
      const start = Math.floor(uniform() * length)
      let size = 1
      while (size < remaining && uniform() >= 1 / meanBlockSessions) size++
      blocks[cursor++] = start * length + size - 1
      remaining -= size
    }
    ends[trial] = cursor
  }
  return (series: readonly number[]) => {
    if (series.length !== length) throw new Error('Bootstrap series length differs from registered window')
    const prefix = new Float64Array(2 * length + 1)
    for (let i = 0; i < 2 * length; i++) prefix[i + 1] = prefix[i] + series[i % length]
    const observed = prefix[length]
    const cutoff = 2 * observed
    let extreme = 0
    let i = 0
    for (const end of ends) {
      let total = 0
      for (; i < end; i++) {
        const code = blocks[i]
        const start = Math.floor(code / length)
        const size = (code % length) + 1
        total += prefix[start + size] - prefix[start]
      }
      // Comparing the raw bootstrap sum to 2x observed is equivalent to recentering under H0.
      if (total >= cutoff) extreme++
    }
    return (extreme + 1) / (trials + 1)
  }
}

const compact = <T>(values: readonly (T | null)[]) => (values.every((v): v is T => v !== null) ? values : null)

export const summarize = (
  rows: readonly Ledger[],
  bp: number,
  benchmark: number | null,
  carry?: readonly number[],
  pValue?: ReturnType<typeof stationaryBootstrap>,
) => {
  const daily = rows.map((row, i) => {
    const alpha = netAt(row, bp)
    return alpha === null ? null : alpha + (carry?.[i] ?? 0)
  })
  const complete = compact(daily)
  const sharpe = complete === null ? null : dailySharpe(complete)
  const activeDays = rows.filter(({ trades, unresolved }) => trades + unresolved > 0).length
  const unresolved = sum(rows.map((row) => row.unresolved))
  const knownClosedLegNetUsd = sum(rows.map((row) => row.base - bp * row.slope))
  const carryUsd = carry === undefined ? 0 : sum(carry)
  const dollarsPerBp = sum(rows.map((row) => row.slope))
  const netUsd = complete === null ? null : sum(complete)
  let drawdown = 0
  let drawdownPct = 0
  let dollars = capital
  let peak = dollars
  let wins = 0
  let losses = 0
  let positive = 0
  let negative = 0
  for (const value of complete ?? []) {
    dollars += value
    peak = Math.max(peak, dollars)
    drawdown = Math.max(drawdown, peak - dollars)
    drawdownPct = Math.max(drawdownPct, (peak - dollars) / peak)
    if (value > 0) {
      wins++
      positive += value
    } else if (value < 0) {
      losses++
      negative -= value
    }
  }
  const best = complete?.filter((value) => value > 0).toSorted((a, b) => b - a) ?? []
  return {
    sessions: rows.length,
    activeDays,
    trades: sum(rows.map((row) => row.trades)),
    unresolved,
    missingEntries: sum(rows.map((row) => row.missingEntries)),
    missingHeld: sum(rows.map((row) => row.missingHeld)),
    maxGrossUpperBoundUsd: Math.max(0, ...rows.map((row) => row.grossUpperBound)),
    knownClosedLegNetUsd,
    carryUsd,
    netUsd,
    returnOnStartingCapital: netUsd === null ? null : netUsd / capital,
    exTop5Usd: netUsd === null ? null : netUsd - sum(best.slice(0, 5)),
    exTop10Usd: netUsd === null ? null : netUsd - sum(best.slice(0, 10)),
    sharpeAnnualized: sharpe === null ? null : sharpe * Math.sqrt(252),
    maxDrawdownUsd: complete === null ? null : drawdown,
    maxDrawdownPct: complete === null ? null : drawdownPct,
    calmar: netUsd === null || drawdown === 0 ? null : (netUsd * 252) / rows.length / drawdown,
    breakevenRtBps: complete === null || dollarsPerBp === 0 ? null : (netUsd ?? 0) / dollarsPerBp + bp,
    winRate: complete === null || wins + losses === 0 ? null : wins / (wins + losses),
    profitFactor: complete === null || negative === 0 ? null : positive / negative,
    bootstrapP: complete === null || pValue === undefined ? null : pValue(complete),
    dsr: complete === null ? null : deflatedSharpe(complete, benchmark),
  }
}

export const matrix = (
  rows: readonly Ledger[],
  carry: readonly number[],
  benchmark: number | null,
  bootstrap?: ReturnType<typeof stationaryBootstrap>,
  allCosts = false,
) =>
  costs.map((bp) => ({
    bp,
    alpha: summarize(rows, bp, benchmark, undefined, allCosts || bp === 5 ? bootstrap : undefined),
    // DSR and inference concern alpha. The additive SHY exposure is not a second strategy discovery.
    withShy: summarize(rows, bp, null, carry),
  }))

export const delta = (
  a: readonly Ledger[],
  b: readonly Ledger[],
  bp: number,
  pValue: ReturnType<typeof stationaryBootstrap>,
) => {
  const paired = compact(
    a.map((row, i) => {
      const first = netAt(row, bp)
      const second = netAt(b[i], bp)
      return first === null || second === null ? null : first - second
    }),
  )
  return paired === null ? { netUsd: null, p: null } : { netUsd: sum(paired), p: pValue(paired) }
}

export const correlation = (a: readonly (number | null)[], b: readonly (number | null)[]) => {
  const pairs = a.flatMap((value, i) => (value === null || b[i] === null ? [] : [[value, b[i]] as const]))
  if (pairs.length < 2) return { sessions: pairs.length, r: null }
  const mx = mean(pairs.map(([x]) => x))
  const my = mean(pairs.map(([, y]) => y))
  let xx = 0
  let yy = 0
  let xy = 0
  for (const [x, y] of pairs) {
    xx += (x - mx) ** 2
    yy += (y - my) ** 2
    xy += (x - mx) * (y - my)
  }
  return { sessions: pairs.length, r: xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : null }
}
