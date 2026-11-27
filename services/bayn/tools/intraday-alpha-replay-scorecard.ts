const trials = 10_000
const blockLength = 5
const seed = 0x53b87e91
export const replayDiagnosticClass = 'DIAGNOSTIC_ONLY_NON_QUALIFYING'

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

export const replayBootstrap = (dailyNet: readonly number[]) => {
  const observed = sum(dailyNet)
  let pValue: number | null = null
  // Sample consecutive circular blocks from the mean-centered series under the zero-mean null.
  // A one-sided test asks how often the resampled total meets or exceeds the observed total.
  if (dailyNet.length >= blockLength) {
    const mean = observed / dailyNet.length
    const centered = dailyNet.map((value) => value - mean)
    const blocks = centered.map((_, start) =>
      sum(Array.from({ length: blockLength }, (_, offset) => centered[(start + offset) % centered.length] ?? 0)),
    )
    let rng = seed
    const draw = () => {
      rng ^= rng << 13
      rng ^= rng >>> 17
      rng ^= rng << 5
      return Math.floor(((rng >>> 0) / 2 ** 32) * centered.length)
    }
    let atLeastObserved = 0
    for (let trial = 0; trial < trials; trial++) {
      let total = 0
      let count = 0
      for (; count + blockLength <= centered.length; count += blockLength) total += blocks[draw()] ?? 0
      if (count < centered.length) {
        const index = draw()
        for (let j = count; j < centered.length; j++) total += centered[(index + j - count) % centered.length] ?? 0
      }
      if (total >= observed) atLeastObserved++
    }
    pValue = (atLeastObserved + 1) / (trials + 1)
  }
  return { blockLength, trials, seed, pValue }
}

interface ClosedDay {
  readonly date: string
  readonly trades: readonly { readonly netPnlUsd: number }[]
}

const dailyRisk = (days: readonly { readonly net: number }[], startingCapitalUsd: number) => {
  const total = sum(days.map((day) => day.net))
  const mean = total / Math.max(1, days.length)
  const variance = sum(days.map((day) => (day.net - mean) ** 2)) / Math.max(1, days.length - 1)
  let equity = startingCapitalUsd
  let peak = equity
  let maxDrawdownUsd = 0
  let maxDrawdownRatio = 0
  for (const { net } of days) {
    equity += net
    peak = Math.max(peak, equity)
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity)
    maxDrawdownRatio = Math.max(maxDrawdownRatio, (peak - equity) / peak)
  }
  const annualizedReturn =
    days.length > 0 && equity > 0 ? Math.expm1(Math.log1p(total / startingCapitalUsd) * (252 / days.length)) : null
  return {
    netPnlUsd: total,
    sharpe: variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : null,
    calmar: maxDrawdownRatio > 0 && annualizedReturn !== null ? annualizedReturn / maxDrawdownRatio : null,
    maxDrawdownUsd,
    maxDrawdownRatio,
  }
}

const profitFactor = (days: readonly { readonly trades: ClosedDay['trades'] }[]) => {
  let profit = 0
  let loss = 0
  for (const day of days)
    for (const { netPnlUsd } of day.trades) {
      if (netPnlUsd > 0) profit += netPnlUsd
      else loss -= netPnlUsd
    }
  return loss > 0 ? profit / loss : null
}

export const replayScorecard = (input: readonly ClosedDay[], startingCapitalUsd: number) => {
  const days = input.map((day) => ({ ...day, net: sum(day.trades.map((trade) => trade.netPnlUsd)) }))
  const topFive = days.toSorted((a, b) => b.net - a.net || a.date.localeCompare(b.date)).slice(0, 5)
  const excluded = new Set(topFive.map(({ date }) => date))
  const chronologicalFolds = [0, 1, 2].map((index) => {
    const base = Math.floor(days.length / 3)
    const remainder = days.length % 3
    const start = index * base + Math.min(index, remainder)
    const fold = days.slice(start, start + base + Number(index < remainder))
    return {
      start: fold[0]?.date ?? null,
      end: fold.at(-1)?.date ?? null,
      sessions: fold.length,
      ...(fold.length === 0 ? null : dailyRisk(fold, startingCapitalUsd)),
      profitFactor: profitFactor(fold),
    }
  })
  return {
    ...dailyRisk(days, startingCapitalUsd),
    profitFactor: profitFactor(days),
    exTopFiveDaysNetPnlUsd:
      days.length > 5 ? sum(days.filter((day) => !excluded.has(day.date)).map((day) => day.net)) : null,
    topFiveDays: topFive.map(({ date, net }) => ({ date, netPnlUsd: net })),
    chronologicalFolds,
    bootstrap: replayBootstrap(days.map(({ net }) => net)),
  }
}
